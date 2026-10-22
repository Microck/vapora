import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs, { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Cause, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { defaults, SteamId } from "../src/model.js";
import * as Scanner from "../src/scanner.js";
import * as Steam from "../src/steam.js";
import * as Storage from "../src/storage.js";
import { key, player, scan, seed, steamFixture } from "./fixtures.js";

// This is a real Windows sharing lock: reads remain allowed, replacement is denied.
async function lockFile(path: string) {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    '$ErrorActionPreference = "Stop"; $stream = $null; try { while ($null -ne ($command = [Console]::ReadLine())) { if ($command -eq "lock") { $stream = [IO.File]::Open($env:VAPORA_LOCK_FILE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); [Console]::WriteLine("locked") } elseif ($command -eq "release") { $stream.Dispose(); $stream = $null; [Console]::WriteLine("released") } else { throw "Unknown lock command" } } } finally { if ($null -ne $stream) { $stream.Dispose() } }',
  ], { env: { ...process.env, VAPORA_LOCK_FILE: path }, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  const replies = createInterface({ input: child.stdout });
  let diagnostic = "";
  child.stderr.on("data", (chunk: Buffer) => { diagnostic += chunk.toString(); });
  const command = async (value: string, expected: string) => {
    const response = Promise.race([
      once(replies, "line"),
      exited.then(() => { throw new Error(`Windows lock helper exited: ${diagnostic}`); }),
    ]);
    child.stdin.write(`${value}\n`);
    const [reply] = await response;
    assert.equal(reply, expected);
  };
  // Reuse one PowerShell process: two cold starts can consume the test's fixed deadline.
  // Each acknowledgement still follows acquiring or releasing the real OS sharing lock.
  try { await command("lock", "locked"); } catch (error) { child.kill(); replies.close(); throw error; }
  return { acquire: () => command("lock", "locked"), release: () => command("release", "released"), close: async () => {
    child.stdin.end();
    const [code] = await exited; replies.close(); assert.equal(code, 0, diagnostic);
  } };
}

if (process.platform === "win32") test("Windows replacement retries a real sharing lock and preserves a checkpoint on a persistent lock", { timeout: 20000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vapora windows storage-"));
  const runtime = ManagedRuntime.make(Storage.layer(root));
  let lock: Awaited<ReturnType<typeof lockFile>> | undefined;
  try {
    const store = await runtime.runPromise(Storage.Service);
    const original = scan([player(seed, [])]); await runtime.runPromise(store.create(original));
    const checkpoint = join(root, "outputs", original.id, "scan.json");
    lock = await lockFile(checkpoint);
    // Establish the OS failure that the previous one-shot rename could not handle.
    const probe = join(root, "replacement-probe"); await writeFile(probe, "probe");
    await assert.rejects(rename(probe, checkpoint), (error) => {
      const failure = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.Literals(["EPERM", "EACCES", "EBUSY"]) }))(error);
      console.log(`Windows sharing lock reproduces ${failure.code} on replacement`); return true;
    });
    await rm(probe);
    const heldLock = lock;
    const nativeRename = fs.rename;
    let sharingFailures = 0;
    // Observe the real OS call without synthesizing failures. Release only after
    // save itself encounters the lock, never on a timer that could beat its first rename.
    const observedRename = t.mock.method(fs, "rename", async (...args: Parameters<typeof rename>) => {
      try { return await nativeRename(...args); }
      catch (error) {
        if (args[1] === checkpoint && ++sharingFailures === 1) await heldLock.release();
        throw error;
      }
    });
    syncBuiltinESMExports();
    try {
      await runtime.runPromise(store.save({ ...original, status: "cancelled" }));
      assert.ok(sharingFailures >= 1);
      assert.ok(observedRename.mock.callCount() >= 2);
    } finally {
      observedRename.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal((await runtime.runPromise(store.read(original.id))).status, "cancelled");
    const lastGood = await readFile(checkpoint);
    await lock.acquire();
    const blocked = await runtime.runPromise(store.save(original).pipe(Effect.result));
    assert.equal(blocked._tag, "Failure");
    if (blocked._tag !== "Failure") throw new Error("The persistent lock should block replacement");
    assert.match(blocked.failure.code ?? "", /^(EPERM|EACCES|EBUSY)$/);
    assert.ok(blocked.failure.cause instanceof Error);
    assert.match(blocked.failure.message, /then retry/);
    assert.deepEqual(await readFile(checkpoint), lastGood);
    assert.ok(!(await readdir(join(root, "outputs", original.id))).some((name) => name.endsWith(".tmp")));
    } finally {
      try { await lock?.close(); }
      finally {
        try { await runtime.dispose(); }
        finally { await rm(root, { recursive: true, force: true }); }
      }
    }
});

test("permanent filesystem errors retain their cause and leave the valid checkpoint intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "vapora storage failure-"));
  const runtime = ManagedRuntime.make(Storage.layer(root));
  try {
    const store = await runtime.runPromise(Storage.Service);
    const original = scan([player(seed, [])]); await runtime.runPromise(store.create(original));
    const checkpoint = join(root, "outputs", original.id, "scan.json");
    const lastGood = await readFile(checkpoint);
    // A directory cannot be replaced by a file. Exercise real failure and cleanup.
    await mkdir(join(root, "outputs", original.id, "analysis.json"));
    const failure = await runtime.runPromise(store.writeArtifact(original.id, "analysis.json", "{}").pipe(Effect.result));
    assert.equal(failure._tag, "Failure");
    if (failure._tag !== "Failure" || failure.failure._tag !== "StorageError") throw new Error("Expected a filesystem failure");
    assert.ok(failure.failure.code); assert.ok(failure.failure.cause instanceof Error);
    assert.match(Cause.pretty(Cause.fail(failure.failure)), /rename/);
    assert.deepEqual(await readFile(checkpoint), lastGood);
    assert.ok(!(await readdir(join(root, "outputs", original.id))).some((name) => name.endsWith(".tmp")));
    const missing = await runtime.runPromise(store.save({ ...original, id: Storage.runId() }).pipe(Effect.result));
    assert.equal(missing._tag, "Failure");
    if (missing._tag !== "Failure") throw new Error("Expected a missing directory failure");
    assert.equal(missing.failure.code, "ENOENT"); assert.match(missing.failure.message, /Check the data folder/);
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("500-account fixture collection remains readable during checkpoints and completes all exports", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "vapora 500 accounts-"));
  const fixture = await steamFixture();
  // Production scan settings remain valid. Only this local provider's pacing is faster.
  const runtime = ManagedRuntime.make(Layer.mergeAll(Storage.layer(root), Steam.layer({ key, requestsPerMinute: 60000, baseUrl: fixture.url })));
  try {
    const ids = Array.from({ length: 500 }, (_, index) => Schema.decodeUnknownSync(SteamId)((BigInt(seed) + BigInt(index)).toString()));
    fixture.friends.set(seed, ids.slice(1));
    for (const id of ids.slice(1)) fixture.friends.set(id, [seed]);
    const initial = await runtime.runPromise(Scanner.create(seed, defaults));
    const store = await runtime.runPromise(Storage.Service);
    let collecting = true; let reads = 0;
    const completion = runtime.runPromise(Scanner.run(initial)).finally(() => { collecting = false; });
    const polling = async () => {
      while (collecting) {
        const recent = await runtime.runPromise(store.recent());
        assert.deepEqual(recent.issues, []); assert.equal(recent.runs[0]?.id, initial.id);
        reads++; await delay(1);
      }
    };
    const [completed] = await Promise.all([completion, polling()]);
    assert.equal(completed.status, "complete"); assert.equal(completed.players.length, 500); assert.deepEqual(completed.queue, []);
    assert.ok(reads > 10); assert.ok(fixture.requests.length > 500);
    assert.equal((await runtime.runPromise(store.read(initial.id))).status, "complete");
    for (const artifact of Storage.artifacts.filter((name) => name !== "history.json")) {
      const contents = await runtime.runPromise(store.readArtifact(initial.id, artifact));
      assert.ok(contents.length); assert.ok(!contents.includes(key));
    }
    assert.ok(!(await readdir(join(root, "outputs", initial.id))).some((name) => name.endsWith(".tmp")));
  } finally { await runtime.dispose(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});
