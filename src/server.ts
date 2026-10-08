import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Cause, Effect, Fiber, ManagedRuntime, Schema, Semaphore } from "effect";
import { InputError, Settings, Ranking, SteamId, failureMessage } from "./model.js";
import type { Scan, StorageError } from "./model.js";
import * as Steam from "./steam.js";
import * as Storage from "./storage.js";
import * as Scanner from "./scanner.js";
import * as Analysis from "./analysis.js";
import * as Obsidian from "./obsidian.js";
import * as History from "./history.js";
import * as HistoryProvider from "./history-provider.js";
import * as HistoryBrowser from "./history-browser.js";
import type { Job, State, RunView } from "./contracts.js";

export interface Options {
  readonly root: string; readonly key: string; readonly port?: number; readonly steamBaseUrl?: string; readonly retryBaseMs?: number;
  readonly historyBaseUrl?: string;
  readonly historyRuntime?: string;
  readonly historySession?: HistoryProvider.OpenSession;
  readonly keyStorage?: { readonly available: boolean; readonly remembered: boolean; readonly save: (key: string | null) => Promise<void> };
}

const ScanRequest = Schema.Struct({ target: Schema.NonEmptyString, settings: Settings });
const ResumeRequest = Schema.Struct({ id: Schema.NonEmptyString });
const KeyRequest = Schema.Struct({ key: Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{32}$/)), remember: Schema.Boolean });
const ProfileRequest = Schema.Struct({ name: Schema.NonEmptyString, settings: Settings });
const HistoryRequest = Schema.Struct({ contents: Schema.String, runId: Schema.optionalKey(Schema.String) });
const AccountHistoryRequest = Schema.Struct({ id: SteamId, refresh: Schema.Boolean, runId: Schema.optionalKey(Schema.String) });
const AnalyzeRequest = Schema.Struct({ id: Schema.NonEmptyString, ranking: Ranking });
// Only bundled UI assets are public. Never resolve request paths against the filesystem.
const files = new Map([
  ["/", { name: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { name: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/style.css", { name: "style.css", type: "text/css; charset=utf-8" }],
  ["/vapora.svg", { name: "vapora.svg", type: "image/svg+xml" }],
  ["/vapora.ico", { name: "vapora.ico", type: "image/x-icon" }],
  ["/placeholder.jpg", { name: "placeholder.jpg", type: "image/jpeg" }],
  ["/key.png", { name: "key.png", type: "image/png" }],
  ["/save.svg", { name: "save.svg", type: "image/svg+xml" }],
  ["/presets.png", { name: "presets.png", type: "image/png" }],
  ["/checkbox-off.png", { name: "checkbox-off.png", type: "image/png" }],
  ["/checkbox-on.png", { name: "checkbox-on.png", type: "image/png" }],
]);
for (const weight of ["regular", "medium", "bold"]) files.set(`/fonts/motiva-sans-${weight}.ttf`, { name: `fonts/motiva-sans-${weight}.ttf`, type: "font/ttf" });

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 5 * 1024 * 1024) throw new InputError({ message: "The request is too large. Import a history file up to 2 MB." });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const json = <T>(response: ServerResponse, status: number, payload: T) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
};
const decode = <T>(schema: Schema.ConstraintDecoder<T>, contents: string) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(contents).pipe(
  Effect.mapError(() => new InputError({ message: "Invalid request. Check the target, settings, or uploaded file format." })),
);

/** This transport owns one active Steam operation. The browser never receives the API key. */
export async function start(options: Options) {
  const runtime = ManagedRuntime.make(Storage.layer(options.root));
  let key = options.key;
  let remembered = options.keyStorage?.remembered ?? false;
  let job: Job = { operationId: null, status: "idle", id: null, error: null, progress: null };
  let cancelJob: (() => Promise<void>) | null = null;
  let estimating = false;
  let origin = "";
  const historyRequests = new Map<SteamId, Promise<History.HistoryState>>();
  const historyErrors = new Map<SteamId, string>();
  const historyGate = await Effect.runPromise(Semaphore.make(1));
  const browserGate = await Effect.runPromise(Semaphore.make(1));
  const historyCancellation = new Set<() => Promise<void>>();
  let closing = false;
  const saveHistory = (bundle: History.Bundle) => runtime.runPromise(historyGate.withPermit(Effect.gen(function* () {
    const store = yield* Storage.Service;
    const id = bundle.sources[0]?.snapshots[0]?.steamID64;
    if (!id) return yield* Effect.fail(new InputError({ message: "No account found in history." }));
    const previous = yield* store.accountHistory(id);
    const report = History.view(History.merge(previous ?? { sources: [] }, bundle));
    yield* store.saveHistory(report);
    return report;
  })));
  const savedHistoryState = (id: SteamId, report: History.HistoryReport | null): History.HistoryState => {
    const error = historyErrors.get(id) ?? (report ? History.coverageError(report) : null);
    return { id, status: historyErrors.has(id) || !report ? "unavailable" : error ? "partial" : "ready", error, report };
  };
  const storedAccountHistory = async (id: SteamId): Promise<History.HistoryState> => {
    const report = await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Storage.Service).accountHistory(id); }));
    return savedHistoryState(id, report);
  };
  const accountHistory = async (id: SteamId, refresh: boolean): Promise<History.HistoryState> => {
    const running = historyRequests.get(id); if (running) return running;
    const collect = async (): Promise<History.HistoryState> => {
      const saved = await storedAccountHistory(id);
      if (!refresh && (saved.report || historyErrors.has(id))) return saved;
      if (closing) throw new InputError({ message: "Vapora is closing. Retry after reopening it." });
      const fiber = runtime.runFork(browserGate.withPermit(HistoryProvider.fetchAccount(id,
        options.historySession ?? HistoryBrowser.open(options.historyRuntime, options.historyBaseUrl))));
      const cancel = () => Effect.runPromise(Fiber.interrupt(fiber)); historyCancellation.add(cancel);
      const outcome = await Effect.runPromise(Fiber.join(fiber).pipe(Effect.result)).finally(() => historyCancellation.delete(cancel));
      if (outcome._tag === "Failure") {
        if (historyRequests.get(id) !== operation) return storedAccountHistory(id);
        historyErrors.set(id, outcome.failure.message);
        return { id, status: "unavailable", error: outcome.failure.message, report: saved.report };
      }
      const report = await saveHistory(outcome.success);
      if (historyRequests.get(id) !== operation) return storedAccountHistory(id);
      historyErrors.delete(id);
      const error = History.coverageError(report);
      return { id, status: error ? "partial" : "ready", error, report };
    };
    const operation = collect();
    historyRequests.set(id, operation);
    try { return await operation; } finally { if (historyRequests.get(id) === operation) historyRequests.delete(id); }
  };
  // Call under historyGate so attachment and cache reads cannot split a persistence operation.
  const attachedSources = (scan: Scan) => Effect.gen(function* () {
    const store = yield* Storage.Service;
    const attachment = yield* store.history(scan.id);
    if (attachment && attachment.profile.steamID64 !== scan.seed) return yield* Effect.fail(new InputError({ message: "Attached history belongs to another Steam account. Inspect its original captures before replacing it." }));
    const cached = yield* store.accountHistory(scan.seed);
    return attachment && cached ? History.merge(attachment, cached) : cached ?? attachment;
  });
  const projectAttachedHistory = (scan: Scan) => Effect.gen(function* () {
    const store = yield* Storage.Service;
    const source = yield* attachedSources(scan);
    if (!source) return null;
    const report = yield* Effect.try({ try: () => History.view(source, scan),
      catch: () => new InputError({ message: "Saved history could not be analyzed. Inspect its original captures before replacing it." }) });
    yield* store.writeArtifact(scan.id, "history.json", JSON.stringify(report, null, 2));
    return report;
  });
  const attachedHistory = (id: string) => historyGate.withPermit(Effect.gen(function* () {
    const scan = yield* (yield* Storage.Service).read(id);
    return yield* projectAttachedHistory(scan);
  }));
  const savedObservations = (id: string) => historyGate.withPermit(Effect.gen(function* () {
    const scan = yield* (yield* Storage.Service).read(id);
    const history = yield* projectAttachedHistory(scan).pipe(Effect.result);
    return { scan, history: history._tag === "Success" ? history.success : null,
      historyError: history._tag === "Failure" ? history.failure.message : null } satisfies Obsidian.Observations;
  }));
  const savedRun = (id: string) => Effect.gen(function* () {
    const saved = yield* savedObservations(id);
    return { scan: saved.scan, report: Analysis.analyze(saved.scan), history: saved.history, historyError: saved.historyError } satisfies RunView;
  });
  const busy = () => job.status === "running" || estimating;
  const ensureReady = () => {
    if (busy()) throw new InputError({ message: "A Steam operation is already running. Wait or cancel it first." });
    if (!key) throw new InputError({ message: "Set a Steam API key before scanning." });
  };
  const steamLayer = (settings: Settings) => Steam.layer({ key, requestsPerMinute: settings.requestsPerMinute,
    baseUrl: options.steamBaseUrl, retryBaseMs: options.retryBaseMs });
  const observe: Scanner.Observe = (progress) => { job = { ...job, id: progress.id, progress }; };
  const launch = (workflow: Effect.Effect<Scan, Steam.ApiError | InputError | StorageError, Storage.Service>) => {
    job = { operationId: randomUUID(), status: "running", id: null, error: null, progress: null };
    const fiber = runtime.runFork(workflow.pipe(Effect.onExit((exit) => Effect.sync(() => {
      job = { ...job, status: exit._tag === "Success" ? "complete" : Cause.hasInterrupts(exit.cause) ? "cancelled" : "failed",
        error: exit._tag === "Failure" && !Cause.hasInterrupts(exit.cause) ? failureMessage(exit.cause) : null };
      cancelJob = null;
    }))));
    cancelJob = () => Effect.runPromise(Fiber.interrupt(fiber));
  };
  // A configured local Steam fixture can serve HTTP avatars; normal images require HTTPS.
  const avatarOrigin = options.steamBaseUrl ? ` ${new URL(options.steamBaseUrl).origin}` : "";
  const server = createServer((request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("content-security-policy", `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https:${avatarOrigin}; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    void dispatch(request, response).catch((error) => {
      if (response.headersSent) { response.destroy(); return; }
      const message = error instanceof Error ? error.message : "The request failed. Check the run log.";
      json(response, 400, { error: message });
    });
  });
  async function dispatch(request: IncomingMessage, response: ServerResponse) {
    const expectedHost = new URL(origin).host;
    if (request.headers.host !== expectedHost) { json(response, 403, { error: "Use Vapora's local server address." }); return; }
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "POST") {
      if (request.headers.origin !== origin || !request.headers["content-type"]?.startsWith("application/json")) {
        json(response, 403, { error: "Only JSON requests from the local Vapora page are accepted." }); return;
      }
      await mutate(url.pathname, request, response);
      return;
    }
    if (request.method !== "GET") { json(response, 405, { error: "Use GET or POST." }); return; }
    if (url.pathname === "/api/state") {
      const recent = await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Storage.Service).recent(); }));
      const profiles = await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Storage.Service).profiles(); }));
      json(response, 200, { hasKey: Boolean(key), keyStorage: options.keyStorage ? { available: options.keyStorage.available, remembered } : null,
        profiles, job, runIssues: recent.issues, runs: recent.runs.map((scan) => {
        const target = scan.players.find((p) => p.id === scan.seed);
        return { id: scan.id, seed: scan.seed, name: target?.name ?? scan.seed, avatar: target?.avatar ?? null,
          createdAt: scan.createdAt, status: scan.status, nodes: scan.players.length };
      }) } satisfies State);
      return;
    }
    const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
    if (runMatch?.[1]) {
      json(response, 200, await runtime.runPromise(savedRun(runMatch[1])));
      return;
    }
    const profileMatch = /^\/api\/profiles\/([^/]+)$/.exec(url.pathname);
    if (profileMatch?.[1]) {
      json(response, 200, await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Storage.Service).profile(profileMatch[1] ?? ""); })));
      return;
    }
    if (url.pathname === "/api/obsidian") {
      await downloadObsidian(url, response);
      return;
    }
    if (url.pathname === "/api/download") {
      const artifact = Storage.artifacts.find((name) => name === url.searchParams.get("file"));
      if (!artifact) { json(response, 404, { error: "Unknown export file." }); return; }
      const id = url.searchParams.get("id") ?? "";
      const contents = await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Storage.Service).readArtifact(id, artifact); }));
      response.writeHead(200, { "content-type": artifact.endsWith(".csv") ? "text/csv; charset=utf-8" : "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="${artifact.replaceAll("/", "-")}"`, "cache-control": "no-store" });
      response.end(contents);
      return;
    }
    const file = files.get(url.pathname);
    if (!file) { json(response, 404, { error: "Page not found." }); return; }
    const contents = await readFile(fileURLToPath(new URL(`../ui/${file.name}`, import.meta.url)));
    response.writeHead(200, { "content-type": file.type });
    response.end(contents);
  }
  async function downloadObsidian(url: URL, response: ServerResponse) {
    const view = await runtime.runPromise(savedObservations(url.searchParams.get("id") ?? ""));
    const contents = await Obsidian.vault(view);
    response.writeHead(200, { "content-type": "application/zip", "cache-control": "no-store",
      "content-disposition": `attachment; filename="vapora-${view.scan.id}-obsidian.zip"` });
    response.end(contents);
  }
  async function updateKey(path: string, contents: string, response: ServerResponse) {
    if (path === "/api/key") {
      const payload = await Effect.runPromise(decode(KeyRequest, contents));
      if (busy()) throw new InputError({ message: "Wait for the active operation before changing the API key." });
      if (payload.remember && !options.keyStorage?.available) throw new InputError({ message: "Secure key storage is unavailable. Use the key for this session." });
      // A well-formed candidate is not authority. Keep the current key until Steam accepts it.
      estimating = true;
      try {
        await runtime.runPromise(Effect.gen(function* () {
          const steam = yield* Steam.Service;
          yield* steam.summaries([Schema.decodeUnknownSync(SteamId)("76561197960287930")]);
        }).pipe(Effect.provide(Steam.layer({ key: payload.key, requestsPerMinute: 120,
          baseUrl: options.steamBaseUrl, retryBaseMs: options.retryBaseMs }))));
        // Commit the candidate only after both Steam validation and the requested storage action succeed.
        if (options.keyStorage) await options.keyStorage.save(payload.remember ? payload.key : null);
        key = payload.key;
        remembered = payload.remember;
      } finally { estimating = false; }
      json(response, 200, { ok: true }); return;
    }
    if (path === "/api/key/forget") {
      if (busy()) throw new InputError({ message: "Wait for the active operation before forgetting the saved key." });
      if (!options.keyStorage) throw new InputError({ message: "This browser session has no saved key." });
      estimating = true;
      try { await options.keyStorage.save(null); remembered = false; }
      finally { estimating = false; }
      json(response, 200, { ok: true }); return;
    }
  }
  async function updateAnalysis(path: string, contents: string, response: ServerResponse) {
    const payload = path === "/api/analyze" ? await Effect.runPromise(decode(AnalyzeRequest, contents))
      : { ...await Effect.runPromise(decode(ResumeRequest, contents)), ranking: null };
    if (busy()) throw new InputError({ message: "Wait for the active operation before updating exports or ranking." });
    estimating = true;
    try {
      const view = await runtime.runPromise(historyGate.withPermit(Effect.gen(function* () {
        const store = yield* Storage.Service;
        const scan = yield* store.read(payload.id);
        const bundle = yield* attachedSources(scan);
        // Validate both sources before changing ranking settings or exports.
        const source = bundle ? History.view(bundle, scan) : null;
        const analyzed = yield* (payload.ranking ? Analysis.reanalyze(payload.id, payload.ranking) : Analysis.rebuild(payload.id));
        const history = source ? History.view(source, analyzed.scan) : null;
        if (history) yield* store.writeArtifact(payload.id, "history.json", JSON.stringify(history, null, 2));
        return { ...analyzed, history, historyError: null } satisfies RunView;
      })));
      json(response, 200, view);
    } finally { estimating = false; }
    return;
  }
  async function updateHistory(path: string, contents: string, response: ServerResponse) {
    if (path === "/api/history/account") {
      const payload = await Effect.runPromise(decode(AccountHistoryRequest, contents));
      // Check the target before requesting or modifying any attachment.
      const scan = payload.runId ? await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Storage.Service).read(payload.runId ?? ""); })) : null;
      if (scan && scan.seed !== payload.id) throw new InputError({ message: "Select the matching account before attaching its history." });
      const savedReport = scan && !payload.refresh ? await runtime.runPromise(attachedHistory(scan.id)) : null;
      if (savedReport) {
        json(response, 200, savedHistoryState(payload.id, savedReport));
        return;
      }
      const state = await accountHistory(payload.id, payload.refresh);
      const report = scan && state.report ? await runtime.runPromise(attachedHistory(scan.id)) : state.report;
      json(response, 200, { ...state, report }); return;
    }
    if (path === "/api/history") {
      const payload = await Effect.runPromise(decode(HistoryRequest, contents));
      if (Buffer.byteLength(payload.contents, "utf8") > 2 * 1024 * 1024) throw new InputError({ message: "The history file exceeds 2 MB." });
      const bundle = await Effect.runPromise(History.parse(payload.contents));
      const scan = payload.runId ? await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Storage.Service).read(payload.runId ?? ""); })) : null;
      const account = bundle.sources[0]?.snapshots[0]?.steamID64;
      if (scan && scan.seed !== account) throw new InputError({ message: "This history belongs to another account. Import separately or open a matching run." });
      const saved = await saveHistory(bundle);
      // The import owns current state; older completions cannot replace its error or request ownership.
      historyRequests.delete(saved.profile.steamID64); historyErrors.delete(saved.profile.steamID64);
      const report = scan ? await runtime.runPromise(attachedHistory(scan.id)) : saved;
      json(response, 200, report); return;
    }
  }
  async function mutate(path: string, request: IncomingMessage, response: ServerResponse) {
    const contents = await body(request);
    if (path === "/api/key" || path === "/api/key/forget") { await updateKey(path, contents, response); return; }
    if (path === "/api/scan" || path === "/api/estimate" || path === "/api/target") {
      const payload = await Effect.runPromise(decode(ScanRequest, contents));
      ensureReady();
      if (path === "/api/estimate" || path === "/api/target") {
        estimating = true;
        try {
          const result = path === "/api/target"
            ? await runtime.runPromise(Scanner.lookup(payload.target, payload.settings).pipe(Effect.provide(steamLayer(payload.settings))))
            : await runtime.runPromise(Scanner.estimate(payload.target, payload.settings).pipe(Effect.provide(steamLayer(payload.settings))));
          json(response, 200, result);
        }
        finally { estimating = false; }
      } else {
        launch(Effect.gen(function* () {
          const scan = yield* Scanner.create(payload.target, payload.settings);
          job = { ...job, id: scan.id };
          return yield* Scanner.run(scan, observe);
        }).pipe(Effect.provide(steamLayer(payload.settings))));
        json(response, 202, { ok: true });
      }
      return;
    }
    if (path === "/api/resume") {
      const payload = await Effect.runPromise(decode(ResumeRequest, contents));
      const scan = await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Storage.Service).read(payload.id); }));
      ensureReady();
      if (scan.status === "complete") throw new InputError({ message: "This run is already complete. Open its report." });
      launch(Scanner.run(scan, observe).pipe(Effect.provide(steamLayer(scan.settings))));
      job = { ...job, id: scan.id };
      json(response, 202, { ok: true }); return;
    }
    if (path === "/api/cancel") {
      if (cancelJob) await cancelJob();
      json(response, 200, { ok: true }); return;
    }
    if (path === "/api/profiles") {
      const payload = await Effect.runPromise(decode(ProfileRequest, contents));
      await runtime.runPromise(Effect.gen(function* () { yield* (yield* Storage.Service).saveProfile(payload.name, payload.settings); }));
      json(response, 200, { ok: true }); return;
    }
    if (path === "/api/analyze" || path === "/api/rebuild") { await updateAnalysis(path, contents, response); return; }
    if (path === "/api/history/account" || path === "/api/history") { await updateHistory(path, contents, response); return; }
    json(response, 404, { error: "Unknown action." });
  }
  await runtime.runPromise(Effect.gen(function* () { yield* Storage.Service; }));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 3000, "127.0.0.1", resolve); });
  const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(server.address());
  origin = `http://127.0.0.1:${address.port}`;
  return { origin, close: async () => {
    closing = true;
    await Promise.all([...historyCancellation].map((cancel) => cancel()));
    await Promise.allSettled(historyRequests.values());
    if (cancelJob) await cancelJob();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      // Chromium preconnections have no HTTP request and survive close's idle cleanup.
      // Stop accepting connections first, then close sockets owned by this local server.
      server.closeAllConnections();
    });
    await runtime.dispose();
  } };
}
