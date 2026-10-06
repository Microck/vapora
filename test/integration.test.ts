import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { Effect, Fiber, Layer, ManagedRuntime, Schema } from "effect";
import { defaults, SteamId, Settings } from "../src/model.js";
import * as Steam from "../src/steam.js";
import * as Storage from "../src/storage.js";
import * as Scanner from "../src/scanner.js";
import * as Analysis from "../src/analysis.js";
import * as Server from "../src/server.js";
import * as Contracts from "../src/contracts.js";
import { seed, second, third, fourth, fifth, key, userAgent, steamFixture } from "./fixtures.js";

const friendPath = "/ISteamUser/GetFriendList/v1/";
const summaryPath = "/ISteamUser/GetPlayerSummaries/v2/";
test("HTTP provider handles private lists, transient retries, denied keys, and malformed data", async () => {
  const fixture = await steamFixture();
  const runtime = ManagedRuntime.make(Steam.layer({ key, requestsPerMinute: 60000, baseUrl: fixture.url, retryBaseMs: 1 }));
  try {
    fixture.failures.set(friendPath + seed, { status: 429, remaining: 2, retryAfter: "0" });
    const friends = await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Steam.Service).friends(seed); }));
    assert.deepEqual(friends.values, [second, third, fourth]);
    assert.equal(fixture.requests.filter((r) => r.path === friendPath && r.id === seed).length, 3);
    assert.equal((await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Steam.Service).friends(fourth); }))).status, "private");
    assert.equal((await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Steam.Service).groups(seed); }))).status, "unavailable");
    await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Steam.Service).groups(second); }));
    assert.equal(fixture.requests.filter((r) => r.path.includes("GetUserGroupList")).length, 1);
    const summaryCalls = fixture.requests.filter((r) => r.path === summaryPath).length;
    fixture.interruptedBodies.set(summaryPath, 1);
    const summaries = await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Steam.Service).summaries([seed]); }));
    assert.equal(summaries[0]?.steamid, seed);
    assert.equal(summaries[0]?.avatarfull, `${fixture.url}/avatars/${seed}.svg`);
    assert.equal(fixture.requests.filter((r) => r.path === summaryPath).length - summaryCalls, 2);
    fixture.omittedAvatars.add(third);
    const noAvatar = await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Steam.Service).summaries([third]); }));
    assert.equal(noAvatar[0]?.avatarfull, undefined);
    fixture.omittedAvatars.clear();
    fixture.malformed.set(summaryPath, JSON.stringify({ response: { players: [{ steamid: seed, avatarfull: "javascript:alert(1)" }] } }));
    await assert.rejects(runtime.runPromise(Effect.gen(function* () { return yield* (yield* Steam.Service).summaries([seed]); })), /unexpected response/);
    fixture.malformed.clear();
    fixture.malformed.set(summaryPath, '{"invalid":true}');
    await assert.rejects(runtime.runPromise(Effect.gen(function* () { return yield* (yield* Steam.Service).summaries([seed]); })), /unexpected response/);
    fixture.malformed.clear();
    fixture.malformed.set(summaryPath, '{"response":');
    const beforeInvalidJson = fixture.requests.length;
    await assert.rejects(runtime.runPromise(Effect.gen(function* () { return yield* (yield* Steam.Service).summaries([seed]); })), /unexpected response/);
    assert.equal(fixture.requests.length - beforeInvalidJson, 1);
    fixture.malformed.clear();
    fixture.malformed.set("/IPlayerService/GetOwnedGames/v1/", '{"response":{"game_count":1,"games":[{"appid":-1}]}}');
    await assert.rejects(runtime.runPromise(Effect.gen(function* () { return yield* (yield* Steam.Service).games(seed); })), /unexpected response/);
    fixture.malformed.clear();
    fixture.failures.set(friendPath + seed, { status: 503, remaining: 20 });
    const before = fixture.requests.length;
    await assert.rejects(runtime.runPromise(Effect.gen(function* () { return yield* (yield* Steam.Service).friends(seed); })), /503/);
    assert.equal(fixture.requests.length - before, 4);
    assert.ok(fixture.requests.every((r) => r.agent === userAgent));
    const denied = Steam.layer({ key: "bad-key", requestsPerMinute: 60000, baseUrl: fixture.url });
    await assert.rejects(Effect.runPromise(Effect.gen(function* () { return yield* (yield* Steam.Service).summaries([seed]); }).pipe(Effect.provide(denied))), /denied access/);
  } finally { await runtime.dispose(); await fixture.close(); }
});
test("provider pacing applies to every actual request", async () => {
  const fixture = await steamFixture();
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const steam = yield* Steam.Service;
      yield* steam.summaries([seed]); yield* steam.friends(seed);
    }).pipe(Effect.provide(Steam.layer({ key, requestsPerMinute: 120, baseUrl: fixture.url }))));
    assert.ok((fixture.requests[1]?.time ?? 0) - (fixture.requests[0]?.time ?? 0) >= 450);
  } finally { await fixture.close(); }
});
test("capped scan saves observations, real optional signals, reports, and resumes interrupted frontier", async () => {
  const fixture = await steamFixture();
  const root = await mkdtemp(join(tmpdir(), "vapora-integration-"));
  const runtime = ManagedRuntime.make(Layer.mergeAll(Storage.layer(root), Steam.layer({ key, requestsPerMinute: 60000, baseUrl: fixture.url })));
  try {
    const settings = { ...defaults, maxNodes: 4, depth: 2, includeGroups: true, includeGames: true };
    fixture.omittedBans.add(second);
    fixture.omittedAvatars.add(third);
    const initial = await runtime.runPromise(Scanner.create("https://steamcommunity.com/id/12345", settings));
    assert.equal(initial.seed, seed);
    assert.ok(fixture.requests.some((r) => r.path.includes("ResolveVanityURL")));
    const arrived = fixture.hold(friendPath, second);
    const fiber = runtime.runFork(Scanner.run(initial));
    await arrived;
    await Effect.runPromise(Fiber.interrupt(fiber));
    fixture.release(friendPath, second);
    const saved = await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Storage.Service).read(initial.id); }));
    assert.equal(saved.status, "cancelled");
    assert.equal(saved.players.find((p) => p.id === seed)?.avatar, `${fixture.url}/avatars/${seed}.svg`);
    assert.deepEqual(saved.queue, [second, third, fourth]);
    assert.equal(saved.players.find((p) => p.id === seed)?.friendsStatus, "public");
    const seedCalls = fixture.requests.filter((r) => r.path === friendPath && r.id === seed).length;
    const denied = ManagedRuntime.make(Layer.mergeAll(Storage.layer(root), Steam.layer({ key: "bad-key", requestsPerMinute: 60000, baseUrl: fixture.url })));
    try {
      const friendCalls = fixture.requests.filter((r) => r.path === friendPath).length;
      await assert.rejects(denied.runPromise(Scanner.run(saved)), /denied access/);
      assert.equal(fixture.requests.filter((r) => r.path === friendPath).length, friendCalls);
      const failure = await denied.runPromise(Effect.gen(function* () { return yield* (yield* Storage.Service).read(saved.id); }));
      assert.equal(failure.error, "Steam denied access. Check the API key and this endpoint's permissions.");
      assert.match(await readFile(join(root, "outputs", saved.id, "run.log"), "utf8"), /ApiError: Steam denied access/);
    } finally { await denied.dispose(); }
    const completed = await runtime.runPromise(Scanner.run(saved));
    assert.equal(completed.status, "complete"); assert.equal(completed.players.length, 4); assert.equal(completed.truncated, true);
    assert.equal(fixture.requests.filter((r) => r.path === friendPath && r.id === seed).length, seedCalls);
    assert.ok(!completed.players.some((p) => p.id === fifth));
    assert.equal(completed.players.find((p) => p.id === fourth)?.friendsStatus, "private");
    assert.equal(completed.players.find((p) => p.id === fourth)?.avatar, `${fixture.url}/avatars/${fourth}.svg`);
    assert.equal(completed.players.find((p) => p.id === third)?.avatar, null);
    assert.equal(completed.players.find((p) => p.id === second)?.bansStatus, "unavailable");
    const banCalls = fixture.requests.filter((r) => r.path.includes("GetPlayerBans")).length;
    await runtime.runPromise(Scanner.run(completed));
    assert.equal(fixture.requests.filter((r) => r.path.includes("GetPlayerBans")).length, banCalls);
    const report = Analysis.analyze(completed);
    assert.equal(report.friends.find((f) => f.id === second)?.sharedGames, 2);
    assert.equal(report.friends.find((f) => f.id === second)?.sharedGroups, null);
    assert.ok(report.edges.every((edge) => completed.players.some((p) => p.id === edge.source) && completed.players.some((p) => p.id === edge.target)));
    const json = await readFile(join(root, "outputs", completed.id, "analysis.json"), "utf8");
    assert.deepEqual(Schema.decodeUnknownSync(Schema.fromJsonString(Contracts.Report))(json), report);
    const csv = await readFile(join(root, "outputs", completed.id, "gephi/nodes.csv"), "utf8");
    assert.ok(csv.includes("'=HYPERLINK"));
    assert.ok(!(await readFile(join(root, "outputs", completed.id, "scan.json"), "utf8")).includes(key));
    await runtime.runPromise(Effect.gen(function* () {
      const store = yield* Storage.Service; yield* store.saveProfile("inner-circle", settings);
      assert.deepEqual(yield* store.profile("inner-circle"), settings);
      assert.deepEqual(yield* store.profiles(), ["inner-circle"]);
      assert.equal((yield* store.recent()).runs[0]?.id, completed.id);
    }));
    await assert.rejects(runtime.runPromise(Effect.gen(function* () { return yield* (yield* Storage.Service).profile("../secret"); })));
    await assert.rejects(runtime.runPromise(Effect.gen(function* () { return yield* (yield* Storage.Service).read("../secret"); })));
    const invalid = { ...completed, queue: [fifth] };
    await writeFile(join(root, "outputs", completed.id, "scan.json"), JSON.stringify(invalid));
    await assert.rejects(runtime.runPromise(Effect.gen(function* () { return yield* (yield* Storage.Service).read(completed.id); })), /inconsistent/);
    const healthy = await runtime.runPromise(Scanner.create(seed, settings));
    const recent = await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Storage.Service).recent(); }));
    assert.equal(recent.issues[0]?.id, completed.id);
    assert.equal(recent.runs[0]?.id, healthy.id);
  } finally { await runtime.dispose(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});
test("local server validates host and origin, protects keys, and runs a complete browser API workflow", async () => {
  const fixture = await steamFixture(); const root = await mkdtemp(join(tmpdir(), "vapora-server-"));
  const server = await Server.start({ root, key: "", port: 0, steamBaseUrl: fixture.url, retryBaseMs: 1 });
  const request = (path: string, payload?: string) => fetch(`${server.origin}${path}`, payload === undefined ? { headers: { "user-agent": userAgent } } : {
    method: "POST", headers: { origin: server.origin, "content-type": "application/json", "user-agent": userAgent }, body: payload,
  });
  const terminalState = async (origin = server.origin) => {
    for (let attempts = 0; attempts < 100; attempts++) {
      const state = Schema.decodeUnknownSync(Contracts.State)(await (await fetch(`${origin}/api/state`, { headers: { "user-agent": userAgent } })).json());
      if (state.job.status !== "running") return state;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("The server operation timed out.");
  };
  try {
    assert.equal((await request("/")).status, 200);
    const logo = await request("/vapora.svg");
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get("content-type"), "image/svg+xml");
    assert.deepEqual(Buffer.from(await logo.arrayBuffer()), await readFile(fileURLToPath(new URL("../../assets/vapora.svg", import.meta.url))));
    assert.equal((await request("/vapora.png")).status, 404);
    assert.equal((await request("/vapora.ico")).headers.get("content-type"), "image/x-icon");
    assert.equal((await request("/placeholder.jpg")).headers.get("content-type"), "image/jpeg");
    assert.equal((await request("/assets/logoextended_old.png")).status, 404);
    const foreignHostStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${server.origin}/api/state`, { headers: { host: "evil.test", "user-agent": userAgent } }, (response) => {
        response.resume(); response.once("end", () => resolve(response.statusCode ?? 0));
      });
      request.once("error", reject); request.end();
    });
    assert.equal(foreignHostStatus, 403);
    assert.equal((await fetch(`${server.origin}/api/key`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.test", "user-agent": userAgent }, body: JSON.stringify({ key }) })).status, 403);
    assert.equal((await request("/api/key", JSON.stringify({ key }))).status, 200);
    assert.ok(!(await (await request("/api/state")).text()).includes(key));
    const target = await request("/api/target", JSON.stringify({ target: seed, settings: defaults }));
    assert.equal(target.status, 200);
    assert.equal((await target.json()).avatar, `${fixture.url}/avatars/${seed}.svg`);
    assert.equal((await (await request("/api/state")).json()).runs.length, 0);
    const settings = { ...defaults, depth: 1, maxNodes: 3 };
    assert.equal((await request("/api/profiles", JSON.stringify({ name: "test", settings }))).status, 200);
    assert.deepEqual(await (await request("/api/profiles/test")).json(), settings);
    const failed = [];
    for (const target of ["https://evil.test/id/a", "https://steamcommunity.com/profiles/alice"]) {
      assert.equal((await request("/api/scan", JSON.stringify({ target, settings }))).status, 202);
      const state = await terminalState();
      assert.equal(state.job.status, "failed"); assert.equal(state.job.id, null);
      assert.equal(state.job.error, target.includes("evil.test") ? "Only steamcommunity.com profile URLs are accepted." : "The profile URL must contain a SteamID64.");
      assert.ok(state.job.operationId); failed.push(state.job.operationId);
    }
    assert.notEqual(failed[0], failed[1]);
    const anotherSession = await Server.start({ root, key, port: 0, steamBaseUrl: fixture.url });
    try {
      await fetch(`${anotherSession.origin}/api/scan`, { method: "POST", headers: { origin: anotherSession.origin, "content-type": "application/json", "user-agent": userAgent }, body: JSON.stringify({ target: "https://evil.test/id/a", settings }) });
      const failure = await terminalState(anotherSession.origin);
      assert.equal(failure.job.status, "failed"); assert.ok(failure.job.operationId);
      assert.ok(!failed.includes(failure.job.operationId));
    } finally { await anotherSession.close(); }
    const arrived = fixture.hold(friendPath, seed);
    assert.equal((await request("/api/scan", JSON.stringify({ target: seed, settings }))).status, 202);
    await arrived;
    assert.equal((await request("/api/scan", JSON.stringify({ target: seed, settings }))).status, 400);
    assert.equal((await request("/api/cancel", "{}")).status, 200);
    fixture.release(friendPath, seed);
    const state = Schema.decodeUnknownSync(Contracts.State)(await (await request("/api/state")).json());
    assert.equal(state.job.status, "cancelled"); assert.ok(state.job.id);
    assert.equal((await request("/api/resume", JSON.stringify({ id: state.job.id }))).status, 202);
    const current = await terminalState();
    assert.equal(current.job.status, "complete", current.job.error ?? "run timed out");
    assert.notEqual(current.job.operationId, state.job.operationId);
    const view = Schema.decodeUnknownSync(Contracts.RunView)(await (await request(`/api/runs/${current.job.id}`)).json());
    assert.equal(view.scan.players.length, 3);
    assert.equal(view.scan.players.find((p) => p.id === seed)?.avatar, `${fixture.url}/avatars/${seed}.svg`);
    assert.equal(current.runs.find((run) => run.id === current.job.id)?.avatar, `${fixture.url}/avatars/${seed}.svg`);
    assert.equal((await request(`/api/download?id=${current.job.id}&file=gephi%2Fnodes.csv`)).status, 200);
    assert.equal((await request(`/api/download?id=${current.job.id}&file=..%2F.env`)).status, 404);
    assert.equal((await request("/api/history", JSON.stringify({ runId: current.job.id, contents: JSON.stringify({ steamID64: seed, lastChecked: 1000, historic: { friends: [] } }) }))).status, 200);
    assert.equal((await request(`/api/download?id=${current.job.id}&file=history.json`)).status, 200);
  } finally { await server.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});
test("private-profile policy survives resume and retains incoming evidence without collecting skipped accounts", async () => {
  const fixture = await steamFixture();
  const root = await mkdtemp(join(tmpdir(), "vapora-private-"));
  const runtime = ManagedRuntime.make(Layer.mergeAll(Storage.layer(root), Steam.layer({ key, requestsPerMinute: 60000, baseUrl: fixture.url })));
  const read = (id: string) => runtime.runPromise(Effect.gen(function* () { return yield* (yield* Storage.Service).read(id); }));
  try {
    fixture.privateProfiles.add(second);
    fixture.omittedVisibility.add(third);
    const settings = { ...defaults, depth: 5, skipPrivate: true, includeGroups: true, includeGames: true };
    const initial = await runtime.runPromise(Scanner.create(seed, settings));
    const arrived = fixture.hold(friendPath, third);
    const fiber = runtime.runFork(Scanner.run(initial));
    await arrived;
    await Effect.runPromise(Fiber.interrupt(fiber));
    fixture.release(friendPath, third);
    const saved = await read(initial.id);
    assert.equal(saved.settings.skipPrivate, true);
    assert.equal(saved.players.find((p) => p.id === second)?.friendsStatus, "skipped");
    assert.deepEqual(saved.queue, [third, fourth]);
    const completed = await runtime.runPromise(Scanner.run(saved));
    const skipped = completed.players.find((p) => p.id === second);
    assert.equal(skipped?.bansStatus, "skipped");
    assert.equal(skipped?.groupsStatus, "skipped");
    assert.equal(skipped?.gamesStatus, "skipped");
    assert.ok(!fixture.requests.some((r) => r.path !== summaryPath && r.ids.includes(second)));
    assert.ok(!completed.players.some((p) => p.id === fifth));
    assert.equal(completed.players.find((p) => p.id === third)?.visibility, "unavailable");
    assert.equal(completed.players.find((p) => p.id === third)?.friendsStatus, "public");
    assert.equal(completed.players.find((p) => p.id === fourth)?.visibility, "public");
    assert.equal(completed.players.find((p) => p.id === fourth)?.friendsStatus, "private");
    assert.equal(completed.players.find((p) => p.id === fourth)?.gamesStatus, "public");
    const report = Analysis.analyze(completed);
    assert.equal(report.coverage.skippedLists, 1);
    assert.equal(report.friends.find((p) => p.id === second)?.mutual, 1);
    assert.equal(report.friends.find((p) => p.id === second)?.jaccard, null);
    assert.ok(report.edges.some((e) => e.source === second && e.target === third));
    assert.equal((await read(initial.id)).players.find((p) => p.id === second)?.friendsStatus, "skipped");
    fixture.privateProfiles.add(seed);
    const before = fixture.requests.length;
    const privateSeed = await runtime.runPromise(Scanner.run(await runtime.runPromise(Scanner.create(seed, settings))));
    assert.equal(privateSeed.status, "complete");
    assert.equal(privateSeed.players[0]?.friendsStatus, "skipped");
    assert.ok(fixture.requests.slice(before).every((r) => r.path === summaryPath));
    const estimate = await runtime.runPromise(Scanner.estimate(seed, settings));
    assert.equal(estimate.available, false);
    assert.match(estimate.note ?? "", /skipped/);
    fixture.privateProfiles.delete(seed);
    const sampleStart = fixture.requests.length;
    const sampled = await runtime.runPromise(Scanner.estimate(seed, settings));
    assert.match(sampled.note ?? "", /not the full depth 5/);
    assert.ok(!fixture.requests.slice(sampleStart).some((r) => r.path === friendPath && r.id === second));
    fixture.privateProfiles.add(seed);
    fixture.omittedVisibility.delete(third); fixture.omittedSummaries.add(third);
    const unrestricted = await runtime.runPromise(Scanner.run(await runtime.runPromise(Scanner.create(seed, { ...settings, skipPrivate: false }))));
    assert.equal(unrestricted.players.find((p) => p.id === second)?.friendsStatus, "public");
    assert.ok(unrestricted.players.some((p) => p.id === fifth));
    assert.equal(unrestricted.players.find((p) => p.id === seed)?.friendsStatus, "public");
    assert.equal(unrestricted.players.find((p) => p.id === third)?.visibility, "unavailable");
    assert.equal(unrestricted.players.find((p) => p.id === third)?.friendsStatus, "public");
  } finally { await runtime.dispose(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});
test("depth 4 and 5 reach the selected frontier and query boundary lists without admitting beyond it", async () => {
  const fixture = await steamFixture();
  const root = await mkdtemp(join(tmpdir(), "vapora-depth-"));
  const runtime = ManagedRuntime.make(Layer.mergeAll(Storage.layer(root), Steam.layer({ key, requestsPerMinute: 60000, baseUrl: fixture.url })));
  try {
    const chain = [seed, second, third, fifth, "76561197960265734", "76561197960265735", "76561197960265736"].map((id) => Schema.decodeUnknownSync(SteamId)(id));
    chain.forEach((id, index) => fixture.friends.set(id, chain.slice(index + 1, index + 2)));
    for (const depth of [4, 5]) {
      const completed = await runtime.runPromise(Scanner.run(await runtime.runPromise(Scanner.create(seed, { ...defaults, depth }))));
      assert.deepEqual(completed.players.map((p) => [p.id, p.level]), chain.slice(0, depth + 1).map((id, level) => [id, level]));
      assert.equal(completed.players.at(-1)?.friendsStatus, "public");
      assert.ok(!completed.players.some((p) => p.id === chain[depth + 1]));
    }
  } finally { await runtime.dispose(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});
test("CLI commands work from a fresh root and reject invalid input with a nonzero exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "vapora-cli-")); const execute = promisify(execFile);
  try {
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    assert.match((await execute(process.execPath, [cli, "--help"])).stdout, /resume RUN_ID/);
    assert.match((await execute(process.execPath, [cli, "profile-save", "tiny", "--root", root, "--max-nodes", "1", "--depth", "5", "--skip-private"])).stdout, /Saved profile tiny/);
    const settings = Schema.decodeUnknownSync(Schema.fromJsonString(Settings))(await readFile(join(root, "profiles", "tiny.json"), "utf8"));
    assert.equal(settings.depth, 5); assert.equal(settings.skipPrivate, true);
    assert.match((await execute(process.execPath, [cli, "profiles", "--root", root])).stdout, /tiny/);
    await assert.rejects(execute(process.execPath, [cli, "profile-save", "bad", "--root", root, "--depth", "20"]), /Invalid settings/);
    await assert.rejects(execute(process.execPath, [cli, "unknown", "--root", root]), /Unknown command/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("assertion lint accepts justified exports and rejects undocumented assertions", async () => {
  const root = await mkdtemp(join(tmpdir(), "vapora-lint-")); const execute = promisify(execFile);
  try {
    const fixture = join(root, "assertion.ts");
    const assertion = 'export const parsed = JSON.parse(\'{"value":1}\') as { value: number };\n';
    const linter = fileURLToPath(new URL("../../node_modules/oxlint/bin/oxlint", import.meta.url));
    const config = fileURLToPath(new URL("../../.oxlintrc.json", import.meta.url));
    const args = [linter, "--config", config, fixture];
    await writeFile(fixture, assertion);
    await assert.rejects(execute(process.execPath, args), (error) => {
      const failure = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.Number, stdout: Schema.String }))(error);
      assert.equal(failure.code, 1); assert.match(failure.stdout, /SAFETY:/); return true;
    });
    await writeFile(fixture, "// SAFETY: the literal JSON has this known structure.\n" + assertion);
    await execute(process.execPath, args);
  } finally { await rm(root, { recursive: true, force: true }); }
});
