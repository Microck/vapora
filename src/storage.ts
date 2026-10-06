import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { InputError, Scan, Settings, StorageError, RunId } from "./model.js";

import type { Artifact } from "./model.js";
import { HistoryReport } from "./history.js";
export { artifacts } from "./model.js";
const ProfileName = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/));
const io = <T>(message: string, action: () => Promise<T>) => Effect.tryPromise({ try: action, catch: () => new StorageError({ message }) });
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
const atomic = (path: string, contents: string) => io(`Could not save ${path}. Check disk space and permissions.`, async () => {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
}).pipe(Effect.uninterruptible);

export const layer = (directory = process.cwd()) => Layer.effect(Service, Effect.gen(function* () {
  const root = resolve(directory);
  const output = join(root, "outputs");
  const profileDir = join(root, "profiles");
  yield* io("Could not create Vapora's output and profile directories.", async () => {
    await mkdir(output, { recursive: true, mode: 0o700 });
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
  });
  const runPath = (id: string) => Schema.decodeUnknownEffect(RunId)(id).pipe(
    Effect.map((validated) => join(output, validated)),
    Effect.mapError(() => new InputError({ message: "Invalid run ID. Use an ID listed by the recent command." })),
  );
  const profilePath = (name: string) => Schema.decodeUnknownEffect(ProfileName)(name).pipe(
    Effect.map((validated) => join(profileDir, `${validated}.json`)),
    Effect.mapError(() => new InputError({ message: "Profile names must use 1-64 letters, digits, hyphens, or underscores." })),
  );
  const save = Effect.fn("Storage.save")((scan: Scan) => atomic(join(output, scan.id, "scan.json"), JSON.stringify(scan, null, 2)));
  const read = Effect.fn("Storage.read")(function* (id: string) {
    const path = yield* runPath(id);
    const contents = yield* io("Could not read this run. Check that its scan.json exists.", () => readFile(join(path, "scan.json"), "utf8"));
    const scan = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Scan))(contents).pipe(
      Effect.mapError(() => new StorageError({ message: "This checkpoint is invalid. Vapora 2 requires its current scan.json format." })),
    );
    const ids = new Set(scan.players.map((p) => p.id));
    if (scan.id !== id || !ids.has(scan.seed) || ids.size !== scan.players.length || scan.players.length > scan.settings.maxNodes || scan.queue.some((sid) => !ids.has(sid))) {
      return yield* Effect.fail(new StorageError({ message: "The checkpoint has inconsistent nodes, seed, or frontier. Start a new run." }));
    }
    return scan;
  });
  return Service.of({
    root, save, read,
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
      yield* atomic(join(path, artifact), contents);
    }),
    readArtifact: Effect.fn("Storage.readArtifact")(function* (id: string, artifact: Artifact) {
      const path = yield* runPath(id);
      return yield* io(`This run has no ${artifact}. Finish or resume the run first.`, () => readFile(join(path, artifact), "utf8"));
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
