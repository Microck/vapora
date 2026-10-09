import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile, appendFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Context, Effect, Layer, Schedule, Schema, Semaphore } from "effect";
import { InputError, Scan, Settings, StorageError, RunId, SteamId } from "./model.js";

import type { Artifact } from "./model.js";
import { HistoryReport } from "./history.js";
export { artifacts } from "./model.js";
const ProfileName = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/));
function filesystemHint(code: string): string {
  switch (code) {
    case "ENOSPC": case "EDQUOT": return `Storage is full (${code}). Free space in the data folder, then resume the run.`;
    case "EACCES": case "EPERM": return `Access was denied (${code}). Check folder permissions and close other apps using this file, then retry.`;
    case "EBUSY": return "The file is busy (EBUSY). Close apps using it, then retry.";
    case "EROFS": return "The data folder is read-only (EROFS). Use a writable data folder.";
    case "ENOENT": return "The file or directory is missing (ENOENT). Check the data folder.";
    default: return `Filesystem error ${code}. Check the run log for details.`;
  }
}
const io = <T>(message: string, action: () => Promise<T>) => Effect.tryPromise({
  try: action,
  catch: (cause) => {
    const code = cause instanceof Error && "code" in cause && Schema.is(Schema.String)(cause.code) ? cause.code : undefined;
    return new StorageError({ message: code ? `${message} ${filesystemHint(code)}` : message, code, cause });
  },
});
export interface RunIssue { readonly id: string; readonly message: string }
export interface Recent { readonly runs: readonly Scan[]; readonly issues: readonly RunIssue[] }

export interface Interface {
  readonly root: string;
  readonly create: (scan: Scan) => Effect.Effect<void, StorageError>;
  readonly save: (scan: Scan) => Effect.Effect<void, StorageError>;
  readonly read: (id: string) => Effect.Effect<Scan, StorageError | InputError>;
  readonly recent: () => Effect.Effect<Recent, StorageError>;
  readonly writeArtifact: (id: string, artifact: Artifact, contents: string) => Effect.Effect<void, StorageError | InputError>;
  readonly readArtifact: (id: string, artifact: Artifact) => Effect.Effect<string, StorageError | InputError>;
  readonly history: (id: string) => Effect.Effect<typeof HistoryReport.Type | null, StorageError | InputError>;
  readonly accountHistory: (id: SteamId) => Effect.Effect<typeof HistoryReport.Type | null, StorageError>;
  readonly saveHistory: (report: typeof HistoryReport.Type) => Effect.Effect<void, StorageError>;
  readonly log: (id: string, message: string) => Effect.Effect<void, StorageError | InputError>;
  readonly saveProfile: (name: string, settings: Settings) => Effect.Effect<void, StorageError | InputError>;
  readonly profile: (name: string) => Effect.Effect<Settings, StorageError | InputError>;
  readonly profiles: () => Effect.Effect<readonly string[], StorageError>;
}
export class Service extends Context.Service<Service, Interface>()("Vapora/Storage") {}

export function runId(now = new Date()): string {
  return `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z-${randomBytes(6).toString("hex")}`;
}

/** Atomic replacement keeps the previous checkpoint readable if a process dies while writing. */
const atomic = Effect.fn("Storage.atomic")(function* (path: string, contents: string) {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  // Windows can briefly deny replacement while another process holds a file. Retry only rename,
  // retaining the same completed temporary file and a bounded 1.55-second backoff.
  const replace = io(`Could not replace ${path}.`, () => rename(temporary, path)).pipe(Effect.retry({
    schedule: Schedule.exponential(50).pipe(Schedule.upTo({ times: 5 })),
    while: (error) => process.platform === "win32" && (error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY"),
  }));
  yield* io(`Could not save ${path}.`, () => writeFile(temporary, contents, { mode: 0o600 })).pipe(
    Effect.andThen(replace),
    // Failed writes must not accumulate checkpoint-sized temporary files.
    // Cleanup cannot replace the original save failure or undo a successful replacement.
    Effect.ensuring(io(`Could not remove temporary file ${temporary}.`, () => rm(temporary, { force: true })).pipe(Effect.ignore)),
    Effect.uninterruptible,
  );
});

export const layer = (directory = process.cwd()) => Layer.effect(Service, Effect.gen(function* () {
  const root = resolve(directory);
  const output = join(root, "outputs");
  const profileDir = join(root, "profiles");
  const historyDir = join(root, "history");
  // Windows replacement can fail while this process is reading the destination.
  // Queue scan-file reads and writes fairly; external sharing locks still use atomic's bounded retry.
  const runFiles = yield* Semaphore.make(1);
  yield* io("Could not create Vapora's output and profile directories.", async () => {
    await mkdir(output, { recursive: true, mode: 0o700 });
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    await mkdir(historyDir, { recursive: true, mode: 0o700 });
  });
  const runPath = (id: string) => Schema.decodeUnknownEffect(RunId)(id).pipe(
    Effect.map((validated) => join(output, validated)),
    Effect.mapError(() => new InputError({ message: "Invalid run ID. Use an ID listed by the recent command." })),
  );
  const profilePath = (name: string) => Schema.decodeUnknownEffect(ProfileName)(name).pipe(
    Effect.map((validated) => join(profileDir, `${validated}.json`)),
    Effect.mapError(() => new InputError({ message: "Profile names must use 1-64 letters, digits, hyphens, or underscores." })),
  );
  const save = Effect.fn("Storage.save")((scan: Scan) => runFiles.withPermit(atomic(join(output, scan.id, "scan.json"), JSON.stringify(scan, null, 2))));
  const read = Effect.fn("Storage.read")(function* (id: string) {
    const path = yield* runPath(id);
    const contents = yield* runFiles.withPermit(io("Could not read this run. Check that its scan.json exists.", () => readFile(join(path, "scan.json"), "utf8")));
    const scan = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Scan))(contents).pipe(
      Effect.mapError(() => new StorageError({ message: "This checkpoint is invalid. Vapora 2 requires its current scan.json format." })),
    );
    const ids = new Set(scan.players.map((p) => p.id));
    if (scan.id !== id || !ids.has(scan.seed) || ids.size !== scan.players.length || (scan.settings.maxNodes > 0 && scan.players.length > scan.settings.maxNodes) || scan.queue.some((sid) => !ids.has(sid))) {
      return yield* Effect.fail(new StorageError({ message: "The checkpoint has inconsistent nodes, seed, or frontier. Start a new run." }));
    }
    return scan;
  });
  return Service.of({
    root, save, read,
    saveHistory: Effect.fn("Storage.saveHistory")((report: typeof HistoryReport.Type) => atomic(join(historyDir, `${report.profile.steamID64}.json`), JSON.stringify(report))),
    accountHistory: Effect.fn("Storage.accountHistory")(function* (id: SteamId) {
      const contents = yield* io("Could not read saved account history.", () => readFile(join(historyDir, `${id}.json`), "utf8").catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }));
      if (contents === null) return null;
      const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(HistoryReport))(contents).pipe(
        Effect.mapError(() => new StorageError({ message: "Saved account history is invalid. Import a valid capture explicitly." })),
      );
      if (report.profile.steamID64 !== id) return yield* Effect.fail(new StorageError({ message: "Cached history belongs to another Steam account. Inspect its original captures before replacing it." }));
      return report;
    }),
    create: Effect.fn("Storage.create")(function* (scan: Scan) {
      yield* io("Could not create a unique output directory.", () => mkdir(join(output, scan.id), { mode: 0o700 }));
      yield* save(scan);
    }),
    recent: Effect.fn("Storage.recent")(function* () {
      const entries = yield* io("Could not list saved runs.", () => readdir(output, { withFileTypes: true }));
      const ids = entries.filter((entry) => entry.isDirectory() && Schema.is(RunId)(entry.name)).map((entry) => entry.name).sort().reverse();
      const observed = yield* Effect.forEach(ids, (id) => read(id).pipe(Effect.result, Effect.map((outcome) => ({ id, outcome }))));
      const runs: Scan[] = []; const issues: RunIssue[] = [];
      for (const { id, outcome } of observed) {
        if (outcome._tag === "Success") runs.push(outcome.success);
        else issues.push({ id, message: outcome.failure.message });
      }
      return { runs, issues };
    }),
    writeArtifact: Effect.fn("Storage.writeArtifact")(function* (id: string, artifact: Artifact, contents: string) {
      const path = yield* runPath(id);
      if (artifact.startsWith("gephi/")) yield* io("Could not create the Gephi export directory.", () => mkdir(join(path, "gephi"), { recursive: true }));
      yield* runFiles.withPermit(atomic(join(path, artifact), contents));
    }),
    readArtifact: Effect.fn("Storage.readArtifact")(function* (id: string, artifact: Artifact) {
      const path = yield* runPath(id);
      return yield* runFiles.withPermit(io(`This run has no ${artifact}. Finish or resume the run first.`, () => readFile(join(path, artifact), "utf8")));
    }),
    history: Effect.fn("Storage.history")(function* (id: string) {
      const path = yield* runPath(id);
      const contents = yield* io("Could not read attached history.", () => readFile(join(path, "history.json"), "utf8").catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }));
      if (contents === null) return null;
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(HistoryReport))(contents).pipe(
        Effect.mapError(() => new StorageError({ message: "Attached history is invalid. Import a valid history file again." })),
      );
    }),
    log: Effect.fn("Storage.log")(function* (id: string, message: string) {
      const path = yield* runPath(id);
      yield* io("Could not append the run log.", () => appendFile(join(path, "run.log"), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 }));
    }),
    saveProfile: Effect.fn("Storage.saveProfile")(function* (name: string, settings: Settings) {
      yield* atomic(yield* profilePath(name), JSON.stringify(settings, null, 2));
    }),
    profile: Effect.fn("Storage.profile")(function* (name: string) {
      const path = yield* profilePath(name);
      const contents = yield* io(`Could not read profile ${name}.`, () => readFile(path, "utf8"));
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Settings))(contents).pipe(
        Effect.mapError(() => new StorageError({ message: `Profile ${name} has invalid settings. Save a new profile.` })),
      );
    }),
    profiles: Effect.fn("Storage.profiles")(function* () {
      const names = yield* io("Could not list saved profiles.", () => readdir(profileDir));
      return names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).sort();
    }),
  });
}));
