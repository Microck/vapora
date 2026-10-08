import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Config, Effect, Schema } from "effect";
import { InputError } from "./model.js";
import type { SteamId } from "./model.js";
import * as Provider from "./history-provider.js";

const Manifest = Schema.Struct({ browser: Schema.String, helper: Schema.String, platform: Schema.String, arch: Schema.String });
const Reply = Schema.Struct({ id: Schema.Number, ready: Schema.optionalKey(Schema.Boolean), error: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Number), contents: Schema.optionalKey(Schema.String) });
type Reply = typeof Reply.Type;
const defaultRoot = fileURLToPath(new URL("../../.history-runtime/", import.meta.url));
const safePath = (root: string, path: string) => {
  const full = resolve(root, path);
  if (!full.startsWith(resolve(root) + (process.platform === "win32" ? "\\" : "/"))) throw new InputError({ message: "The bundled history runtime has an invalid path." });
  return full;
};

async function connect(id: SteamId, root: string, origin: string, sandbox: string) {
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(await readFile(join(root, "runtime.json"), "utf8").catch(() => {
    throw new InputError({ message: "The history runtime is missing. Build it with npm run build:history, or reinstall the desktop download." });
  }));
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) throw new InputError({ message: "The history runtime was built for another operating system or architecture. Rebuild or reinstall Vapora." });
  const browser = safePath(root, manifest.browser); const helper = safePath(root, manifest.helper);
  await Promise.all([access(browser), access(helper)]);
  const profile = await mkdtemp(join(tmpdir(), "vapora-history-browser-"));
  // The helper gets only the environment needed by a native browser, never Steam authority.
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  const child = spawn(helper, [browser, profile, id, origin, sandbox], { env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, detached: process.platform !== "win32" });
  const pending = new Map<number, { resolve: (reply: Reply) => void; reject: (error: InputError) => void }>();
  const lines = createInterface({ input: child.stdout });
  let sequence = 0; let stopped = false;
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const fail = (message: string) => {
    for (const waiter of pending.values()) waiter.reject(new InputError({ message }));
    pending.clear();
  };
  child.once("error", () => fail("The history helper could not start. Rebuild or reinstall Vapora."));
  child.stdin.on("error", () => fail("The history browser closed before collection finished. Retry to open another session."));
  child.once("exit", () => fail("The history browser closed before collection finished. Retry to open another session."));
  lines.on("line", (line) => {
    const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(Reply))(line);
    if (decoded._tag === "Failure") { fail("The history helper returned an invalid response. Rebuild or reinstall Vapora."); return; }
    const reply = decoded.success; const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    if (reply.error) waiter.reject(new InputError({ message: reply.error })); else waiter.resolve(reply);
  });
  const receive = (id: number, timeout: number) => new Promise<Reply>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new InputError({ message: "History timed out. Retry or import a saved capture." })); }, timeout);
    pending.set(id, { resolve: (reply) => { clearTimeout(timer); resolve(reply); }, reject: (error) => { clearTimeout(timer); reject(error); } });
  });
  const close = async () => {
    if (stopped) return; stopped = true;
    child.stdin.end(JSON.stringify({ command: "close" }) + "\n");
    const timer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      // Only this helper's process tree is owned here, including its Chromium children.
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      else if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; } }
    }, 3000);
    await exited; clearTimeout(timer); lines.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  const request = Effect.fn("History.browserRequest")((path: string) => Effect.tryPromise({
    try: async () => {
      if (stopped || child.exitCode !== null || child.signalCode !== null) throw new InputError({ message: "The history browser is closed. Retry to open it again." });
      const id = ++sequence; const response = receive(id, 25000);
      child.stdin.write(JSON.stringify({ id, path }) + "\n");
      return Schema.decodeUnknownSync(Provider.Response)(await response);
    }, catch: (error) => error instanceof InputError ? error : new InputError({ message: "History's browser response could not be read. Retry the capture." }),
  }));
  const ready = receive(0, 95000);
  return { request, close, ready };
}

/** Packaged and source launches use the same frozen helper and isolated browser session. */
export const open = (root = defaultRoot, origin = "https://steamhistory.net"): Provider.OpenSession => Effect.fn("History.openBrowser")(function* (id: SteamId) {
  const sandbox = yield* Config.String("VAPORA_HISTORY_SANDBOX").pipe(Config.withDefault("enabled"),
    Effect.mapError(() => new InputError({ message: "Invalid history browser sandbox setting." })));
  if (sandbox !== "enabled" && sandbox !== "disabled") return yield* Effect.fail(new InputError({ message: "The history sandbox setting must be enabled or disabled." }));
  const session = yield* Effect.acquireRelease(Effect.tryPromise({ try: () => connect(id, root, origin, sandbox),
    catch: (error) => error instanceof InputError ? error : new InputError({ message: "The history browser could not start. Check the bundled history runtime and retry." }) }),
  (session) => Effect.promise(session.close));
  const ready = yield* Effect.tryPromise({ try: () => session.ready,
    catch: (error) => error instanceof InputError ? error : new InputError({ message: "History's browser did not become ready." }) });
  if (!ready.ready) return yield* Effect.fail(new InputError({ message: "History's browser did not become ready." }));
  return session;
});
