import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Cause, Effect, Fiber, ManagedRuntime, Schema } from "effect";
import { InputError, Settings, Ranking, failureMessage } from "./model.js";
import type { Scan, StorageError } from "./model.js";
import * as Steam from "./steam.js";
import * as Storage from "./storage.js";
import * as Scanner from "./scanner.js";
import * as Analysis from "./analysis.js";
import * as History from "./history.js";
import type { Job, State, RunView } from "./contracts.js";

export interface Options { readonly root: string; readonly key: string; readonly port?: number; readonly steamBaseUrl?: string; readonly retryBaseMs?: number }

const ScanRequest = Schema.Struct({ target: Schema.NonEmptyString, settings: Settings });
const ResumeRequest = Schema.Struct({ id: Schema.NonEmptyString });
const KeyRequest = Schema.Struct({ key: Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{32}$/)) });
const ProfileRequest = Schema.Struct({ name: Schema.NonEmptyString, settings: Settings });
const HistoryRequest = Schema.Struct({ contents: Schema.String, runId: Schema.optionalKey(Schema.String) });
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
  let job: Job = { operationId: null, status: "idle", id: null, error: null, progress: null };
  let cancelJob: (() => Promise<void>) | null = null;
  let estimating = false;
  let origin = "";
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
      json(response, 200, { hasKey: Boolean(key), profiles, job, runIssues: recent.issues, runs: recent.runs.map((scan) => {
        const target = scan.players.find((p) => p.id === scan.seed);
        return { id: scan.id, seed: scan.seed, name: target?.name ?? scan.seed, avatar: target?.avatar ?? null,
          createdAt: scan.createdAt, status: scan.status, nodes: scan.players.length };
      }) } satisfies State);
      return;
    }
    const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
    if (runMatch?.[1]) {
      const scan = await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Storage.Service).read(runMatch[1] ?? ""); }));
      const history = await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Storage.Service).history(scan.id); }));
      json(response, 200, { scan, report: Analysis.analyze(scan), history } satisfies RunView);
      return;
    }
    const profileMatch = /^\/api\/profiles\/([^/]+)$/.exec(url.pathname);
    if (profileMatch?.[1]) {
      json(response, 200, await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Storage.Service).profile(profileMatch[1] ?? ""); })));
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
  async function mutate(path: string, request: IncomingMessage, response: ServerResponse) {
    const contents = await body(request);
    if (path === "/api/key") {
      const payload = await Effect.runPromise(decode(KeyRequest, contents));
      if (busy()) throw new InputError({ message: "Wait for the active operation before changing the API key." });
      key = payload.key;
      json(response, 200, { ok: true }); return;
    }
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
    if (path === "/api/analyze") {
      const payload = await Effect.runPromise(decode(AnalyzeRequest, contents));
      if (busy()) throw new InputError({ message: "Wait for the active operation before saving ranking settings." });
      estimating = true;
      try {
        // Read attached data before saving so a corrupt attachment cannot hide a successful mutation.
        const history = await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Storage.Service).history(payload.id); }));
        const view = await runtime.runPromise(Analysis.reanalyze(payload.id, payload.ranking));
        json(response, 200, { ...view, history } satisfies RunView);
      } finally { estimating = false; }
      return;
    }
    if (path === "/api/history") {
      const payload = await Effect.runPromise(decode(HistoryRequest, contents));
      if (Buffer.byteLength(payload.contents, "utf8") > 2 * 1024 * 1024) throw new InputError({ message: "The history file exceeds 2 MB." });
      const report = await Effect.runPromise(History.parse(payload.contents).pipe(Effect.flatMap(History.analyze)));
      if (payload.runId) {
        await runtime.runPromise(Effect.gen(function* () {
          const store = yield* Storage.Service;
          const scan = yield* store.read(payload.runId ?? "");
          if (scan.seed !== report.profile.steamID64) return yield* Effect.fail(new InputError({ message: "This history belongs to another account. Open a matching run or import it separately." }));
          yield* store.writeArtifact(scan.id, "history.json", JSON.stringify(report, null, 2));
        }));
      }
      json(response, 200, report); return;
    }
    json(response, 404, { error: "Unknown action." });
  }
  await runtime.runPromise(Effect.gen(function* () { yield* Storage.Service; }));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 3000, "127.0.0.1", resolve); });
  const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(server.address());
  origin = `http://127.0.0.1:${address.port}`;
  return { origin, close: async () => {
    if (cancelJob) await cancelJob();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await runtime.dispose();
  } };
}
