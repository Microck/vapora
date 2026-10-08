import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { defaults } from "../src/model.js";
import * as History from "../src/history.js";
import * as Scoring from "../src/scoring.js";
import * as Analysis from "../src/analysis.js";
import * as Server from "../src/server.js";
import { seed, second, third, fourth, player, scan, historyFixture } from "./fixtures.js";

const profile = (lastChecked: number, friends: readonly History.Record[] = [], comments: readonly History.Record[] = []) => ({
  steamID64: seed, name: "Alice", lastChecked, historic: { friends, comments, persona: [{ Name: "Old Alice", Timestamp: 5 }], url: [], pfp: [] },
});
const parse = (value: History.Record) => Effect.runPromise(History.parse(JSON.stringify(value)));

test("authored count reference distinguishes positive friend-comment counts from all-direct-friend counts", () => {
  const positive = Scoring.countIndex([10, 5], 5, 50);
  assert.ok(Math.abs((positive(10) ?? 0) - 79.55555555555556) < 1e-10);
  assert.ok(Math.abs((positive(5) ?? 0) - 39.77777777777778) < 1e-10);
  const all = Scoring.countIndex([10, 5, 0], 5, 50);
  assert.equal(all(10), 84); assert.ok(Math.abs((all(5) ?? 0) - 48.666666666666664) < 1e-10);
  assert.equal(all(0), 0); assert.equal(Scoring.countIndex([], 5, 50)(1), null);
});
test("network ranks every known direct friend and separates incoming from undirected signals", () => {
  const report = Analysis.analyze(scan([player(seed, [second, third, fourth]), player(second, [seed, third])]));
  assert.equal(report.friends.length, 3); assert.equal(report.coverage.admittedDirectFriends, 1);
  assert.equal(report.friends.find((row) => row.id === third)?.incomingMutual, 1);
  assert.equal(report.friends.find((row) => row.id === third)?.admitted, false);
  assert.equal(report.friends.find((row) => row.id === second)?.incomingMutual, 0);
  assert.equal(report.friends.find((row) => row.id === second)?.mutual, 1);
  const off = Analysis.analyze({ ...scan([player(seed, [second])]), settings: { ...defaults, weights: { mutual: 0, jaccard: 0, groups: 0, games: 0 } } });
  assert.equal(off.friends[0]?.evidenceScore, null);
});
test("bounded game overlap cannot increase when only unshared games are added", () => {
  const settings = { ...defaults, weights: { mutual: 0, jaccard: 0, groups: 0, games: 1 } };
  const network = scan([player(seed, [second], { gamesStatus: "public", games: [1] }), player(second, [], { gamesStatus: "public", games: [1] })], settings);
  assert.equal(Analysis.analyze(network).friends[0]?.score, 100);
  const expanded = { ...network, players: [network.players[0] ?? player(seed, []), player(second, [], { gamesStatus: "public", games: Array.from({ length: 1001 }, (_, index) => index + 1) })] };
  assert.ok((Analysis.analyze(expanded).friends[0]?.score ?? 100) < 1);
});
test("true products keep zeros absorbing and remain finite beyond 10^400", () => {
  const city = (city: number, count: number) => ({ country: "ES", state: null, city, count });
  const zero = Scoring.locations([city(1, 2), city(1, 0), city(1, 4)], defaults);
  assert.equal(zero[0]?.support, "0"); assert.equal(zero[0]?.share, null); assert.equal(zero[0]?.index, null);
  const enormous = Scoring.locations(Array.from({ length: 400 }, (_, index) => city(index < 200 ? 1 : 2, 100)), defaults);
  assert.equal(enormous[0]?.support, `1${"0".repeat(400)}`); assert.equal(enormous[0]?.share, 50);
  assert.ok(Math.abs((enormous[0]?.index ?? 0) - 66.66666666666667) < 1e-10);
  assert.equal(Scoring.locations([city(1, 2), city(1, 3)], { ...defaults, locationAggregation: "sum" })[0]?.support, "5");
});
test("all captures, unknown fields and original UTF-8 formatting survive the report contract", async () => {
  const contents = '\r\n' + JSON.stringify({ ...profile(100), unknown: { keep: ["é", null] }, vacBanned: true, gameBans: 2 }) + '\r\n';
  const bundle = await Effect.runPromise(History.parse(contents));
  const report = History.view(bundle);
  const reopened = Schema.decodeUnknownSync(History.HistoryReport)(JSON.parse(JSON.stringify(report)));
  assert.equal(reopened.sources[0]?.contents, contents);
  assert.deepEqual(reopened.profile.fields.unknown, { keep: ["é", null] });
  assert.equal(reopened.profile.fields.vacBanned, true);
});
test("recognized real-name history rejects malformed records rather than hiding them", async () => {
  for (const invalid of [null, "not records", { Name: "Alice" }, [null]]) {
    await assert.rejects(parse({ ...profile(100), historic: { realName: invalid } }), /History section realName must contain records/);
  }
  const report = History.view(await parse({ ...profile(100), historic: { realName: [{ Name: "Alice Example" }], providerMetadata: "preserved" } }));
  assert.equal(report.profile.historic.realName?.[0]?.Name, "Alice Example");
  assert.deepEqual(report.profile.fields.historic, { realName: [{ Name: "Alice Example" }], providerMetadata: "preserved" });
});
test("byte-identical reimports reuse one source while distinct original captures remain retained", async () => {
  const first = await parse(profile(100));
  const repeated = await parse(profile(100));
  const newer = await parse(profile(200));
  const merged = History.merge(first, repeated, newer, newer);
  assert.equal(merged.sources.length, 2);
  assert.deepEqual(merged.sources, [...first.sources, ...newer.sources]);
  assert.equal(History.view(merged).profile.lastChecked, 200);
});
test("devalue pools resolve each reference once without chasing small scalar values and keep deferred chunks", async () => {
  const stream = JSON.stringify({ type: "data", nodes: [{ type: "data", data: [
    { profile: 1 }, { steamID64: 2, name: 3, lastUpdated: 4, historic: 5, vacBanned: 6 }, seed, "Alice", 3, ["Promise", 7], false,
  ] }] }) + '\n' + JSON.stringify({ type: "chunk", id: 7, data: [{ friends: 1, comments: 2 }, [], []] });
  const bundle = await Effect.runPromise(History.parse(stream)); const report = History.view(bundle);
  assert.equal(report.profile.lastChecked, 3); assert.equal(report.profile.fields.vacBanned, false);
  assert.equal(report.sources[0]?.contents, stream);
  await assert.rejects(Effect.runPromise(History.parse(stream.split('\n')[0] ?? '')));
});
test("newer closed friendship supersedes old open period; complete live observations may establish refriending", async () => {
  const old = await parse(profile(30, [{ Friend: second, FriendDate: 10, Name: "Bob" }]));
  const newer = await parse(profile(50, [{ Friend: second, FriendDate: 10, UnfriendDate: 40, Name: "Bob" }]));
  const combined = { sources: [...old.sources, ...newer.sources] };
  assert.equal(History.view(combined).friends[0]?.status, "former");
  assert.equal(History.view(combined).friends[0]?.durationSeconds, 30);
  assert.equal(History.view(combined, scan([player(seed, [second])])).friends[0]?.status, "current");
  const partial = scan([player(seed, [], { friendsStatus: "private" })]);
  assert.equal(History.view(old, partial).friends[0]?.status, "current");
  const contradiction = await parse(profile(50, [{ Friend: second, FriendDate: 10 }, { Friend: second, FriendDate: 10, UnfriendDate: 40 }]));
  assert.equal(History.view(contradiction).friends[0]?.status, "unknown");
  assert.equal(History.view(contradiction).friends[0]?.durationSeconds, null);
});
test("overlapping durations union once and clip to selected dates", async () => {
  const bundle = await parse(profile(50, [{ Friend: second, FriendDate: 10, UnfriendDate: 30 }, { Friend: second, FriendDate: 20, UnfriendDate: 40 }]));
  assert.equal(History.view(bundle).friends[0]?.durationSeconds, 30);
  assert.equal(History.view(bundle, undefined, { from: 25, to: 35 }).friends[0]?.durationSeconds, 10);
});
test("captured comment reference includes former friends, excludes outsiders, and preserves anonymous multiplicity", async () => {
  const friend = { Friend: second, FriendDate: 1, UnfriendDate: 50, Name: "Bob", countryCode: "ES", cityID: 1 };
  const event = { Commenter: second, Timestamp: 10, Message: "same" };
  const first = await parse(profile(100, [friend, { Friend: third, FriendDate: 1 }], [event, event, { Commenter: fourth, Message: "outside", Timestamp: 20 }]));
  const secondCapture = await parse(profile(110, [friend, { Friend: third, FriendDate: 1 }], [event, event, event]));
  const bundle = { sources: [...first.sources, ...secondCapture.sources] };
  const report = History.view(bundle);
  assert.equal(report.comments.filter((row) => row.author === second).length, 3);
  assert.equal(report.referenceSize, 1); assert.equal(report.commenters.find((row) => row.id === fourth)?.index, null);
  assert.equal(report.commenters.find((row) => row.id === second)?.status, "former");
  assert.equal(report.comments.find((row) => row.author === second)?.occurrences, 5);
  assert.equal(History.view(bundle, undefined, { from: 15, to: 30 }).referenceSize, 0);
});
test("identified comment versions remain one event and undated comments stay outside date ranges", async () => {
  const a = await parse(profile(100, [], [{ ID: "c", Commenter: second, Timestamp: 20, Message: "before" }, { Commenter: third, Message: "undated" }]));
  const b = await parse(profile(200, [], [{ ID: "c", Commenter: second, Timestamp: 20, Message: "after" }]));
  const report = History.view({ sources: [...a.sources, ...b.sources] });
  assert.equal(report.comments.length, 2); assert.equal(report.comments.find((row) => !row.estimated)?.versions.length, 2);
  assert.equal(report.comments.find((row) => !row.estimated)?.message, "after");
  assert.equal(History.view(report, undefined, { from: 1, to: 100 }).comments.length, 1);
});
test("numeric comment identifiers reconcile All, Deleted and edited versions without inflating rankings", async () => {
  const friend = { Friend: second, FriendDate: 1 };
  const event = { CommentID: 42, Commenter: second, Timestamp: 20, Message: "before" };
  const old = await parse(profile(100, [friend], [event, { ...event, IsDeleted: 1 }]));
  const recent = await parse(profile(200, [friend], [{ ...event, CommentID: "42", Message: "after" }]));
  const report = History.view({ sources: [...old.sources, ...recent.sources] });
  assert.equal(report.comments.length, 1);
  assert.equal(report.comments[0]?.estimated, false);
  assert.equal(report.comments[0]?.message, "after");
  assert.equal(report.comments[0]?.versions.length, 3);
  assert.equal(report.commenters[0]?.count, 1);
  assert.equal(History.commentId({ ID: 0 }), "0");
});
test("unsafe numeric comment IDs fail explicitly while exact large string IDs stay distinct", async () => {
  const contents = `{"steamID64":"${seed}","lastChecked":100,"historic":{"comments":[{"CommentID":9007199254740993,"Message":"rounded"}]}}`;
  await assert.rejects(Effect.runPromise(History.parse(contents)), /numeric comment ID cannot be represented exactly/);
  assert.throws(() => History.commentId({ ID: Number.MAX_SAFE_INTEGER + 1 }), /JSON strings/);
  assert.throws(() => History.commentId({ CommentID: 1.5 }), /JSON strings/);
  assert.equal(History.commentId({ ID: Number.MAX_SAFE_INTEGER }), String(Number.MAX_SAFE_INTEGER));
  const report = History.view(await parse(profile(100, [], [{ ID: "9007199254740992" }, { ID: "9007199254740993" }])));
  assert.equal(report.comments.length, 2);
  const Provider = await import("../src/history-provider.js"); const fixture = await historyFixture();
  fixture.replies.set("comments:0", '{"data":[{"CommentID":9007199254740993}],"total":1}');
  try {
    const partial = History.view(await Effect.runPromise(Provider.fetchAccount(seed, fixture.session)));
    assert.equal(partial.comments.length, 0);
    assert.equal(partial.profile.historic.persona?.length, 2);
    assert.match(partial.sources[0]?.coverage.find((row) => row.section === "comments")?.error ?? "", /numeric comment ID/);
  } finally { await fixture.close(); }
});
test("account fetching reuses current paginated captures; failure retains data and scan API stays independent", async () => {
  const fixture = await historyFixture();
  const root = await mkdtemp(join(tmpdir(), "vapora-history-"));
  const app = await Server.start({ root, key: "", port: 0, historySession: fixture.session });
  const post = (refresh: boolean) => fetch(`${app.origin}/api/history/account`, { method: "POST", headers: { origin: app.origin, "content-type": "application/json", "user-agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" }, body: JSON.stringify({ id: seed, refresh }) }).then(async (response) => Schema.decodeUnknownSync(History.HistoryState)(await response.json()));
  try {
    const fetched = await post(false); assert.equal(fetched.status, "ready"); assert.equal(fixture.requests(), 8);
    assert.deepEqual(await post(false), fetched); assert.equal(fixture.requests(), 8);
    fixture.setStatus(403); const blocked = await post(true); assert.equal(blocked.status, "unavailable"); assert.deepEqual(blocked.report, fetched.report);
    assert.match(blocked.error ?? "", /blocked/);
    assert.equal((await post(false)).status, "unavailable"); assert.equal(fixture.requests(), 9);
    assert.equal((await fetch(`${app.origin}/api/state`, { headers: { "user-agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" } })).status, 200);
    const saved = Schema.decodeUnknownSync(History.HistoryReport)(JSON.parse(await readFile(join(root, "history", `${seed}.json`), "utf8")));
    const contents = saved.sources[0]?.contents ?? "";
    const original = Schema.decodeUnknownSync(History.Document)(JSON.parse(contents));
    assert.equal(original.pages.length, 7); assert.match(original.profile.contents, /userdata/);
    assert.equal((await Effect.runPromise(History.parse(contents))).sources[0]?.contents, contents);
    fixture.setStatus(200); assert.equal((await post(true)).report?.sources.length, 2);
    const imported = await fetch(`${app.origin}/api/history`, { method: "POST", headers: { origin: app.origin, "content-type": "application/json", "user-agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" }, body: JSON.stringify({ contents }) });
    assert.equal(imported.status, 200);
    assert.equal(Schema.decodeUnknownSync(History.HistoryReport)(await imported.json()).sources.length, 2);
  } finally { await app.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});

test("an import supersedes a pending fetch failure without poisoning cached state", { timeout: 10000 }, async () => {
  const fixture = await historyFixture(); const root = await mkdtemp(join(tmpdir(), "vapora-history-race-"));
  const app = await Server.start({ root, key: "", port: 0, historySession: fixture.session });
  const post = (path: string, body: History.Record) => fetch(`${app.origin}${path}`, { method: "POST", headers: { origin: app.origin, "content-type": "application/json", "user-agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" }, body: JSON.stringify(body) });
  const path = `/id/${seed}/__data.json`;
  try {
    fixture.setStatus(403); const arrived = fixture.hold(path);
    const pending = post("/api/history/account", { id: seed, refresh: true }); await arrived;
    const imported = await post("/api/history", { contents: JSON.stringify(profile(100, [], [{ ID: "imported", Message: "saved" }])) });
    assert.equal(imported.status, 200);
    const duringFetch = Schema.decodeUnknownSync(History.HistoryState)(await (await post("/api/history/account", { id: seed, refresh: false })).json());
    assert.equal(duringFetch.status, "ready"); assert.equal(duringFetch.report?.comments[0]?.message, "saved");
    fixture.release(path);
    const completion = Schema.decodeUnknownSync(History.HistoryState)(await (await pending).json());
    assert.equal(completion.status, "ready"); assert.equal(completion.error, null);
    const cached = Schema.decodeUnknownSync(History.HistoryState)(await (await post("/api/history/account", { id: seed, refresh: false })).json());
    assert.deepEqual(cached, completion); assert.equal(fixture.requests(), 1);
  } finally { fixture.release(path); await app.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});

test("current history paginates all records and retains deleted comment versions and page metadata", async () => {
  const Provider = await import("../src/history-provider.js"); const fixture = await historyFixture();
  const friends = Array.from({ length: 205 }, (_, index) => ({ Friend: String(BigInt(seed) + 1000n + BigInt(index)), FriendDate: 10, Name: `Friend ${index}`, unknown: { keep: true } }));
  fixture.rows.set("friends", friends);
  fixture.rows.set("comments", [{ CommentID: "same", Commenter: second, Message: "deleted", Timestamp: 20, IsDeleted: true }]);
  try {
    const bundle = await Effect.runPromise(Provider.fetchAccount(seed, fixture.session)); const report = History.view(bundle);
    assert.equal(report.friends.length, 205); assert.equal(report.comments.length, 1); assert.equal(report.comments[0]?.versions.length, 2);
    assert.deepEqual(report.profile.historic.friends, friends);
    assert.equal(History.coverageError(bundle), null);
    assert.ok(fixture.paths.some((path) => path.includes("type=5&offset=200")));
    const original = Schema.decodeUnknownSync(History.Document)(JSON.parse(report.sources[0]?.contents ?? ""));
    assert.equal(original.pages.filter((page) => page.section === "friends").length, 3);
    assert.ok(original.pages.every((page) => page.response.contents.includes("customPageField")));
    assert.equal(report.profile.fields.steamHistoryRoute && JSON.stringify(report.profile.fields.steamHistoryRoute).includes("unknownRouteField"), true);
  } finally { await fixture.close(); }
});

test("partial pages and provider summary discrepancies remain visible without losing successful sections", async () => {
  const Provider = await import("../src/history-provider.js"); const fixture = await historyFixture();
  fixture.counts.set("comments", 7); fixture.failures.set("pfp", 503);
  try {
    const report = History.view(await Effect.runPromise(Provider.fetchAccount(seed, fixture.session)));
    assert.equal(report.friends.length, 2); assert.equal(report.comments.length, 4);
    const coverage = report.sources[0]?.coverage;
    assert.equal(coverage?.find((row) => row.section === "comments")?.status, "partial");
    assert.equal(coverage?.find((row) => row.section === "pfp")?.status, "unavailable");
    assert.match(History.coverageError(report) ?? "", /summary lists 7 comments records; this session returned 4/);
    assert.match(History.coverageError(report) ?? "", /HTTP 503/);
    const restored = History.view(await Effect.runPromise(History.parse(report.sources[0]?.contents ?? "")));
    assert.deepEqual(restored.profile.historic, report.profile.historic);
    assert.deepEqual(restored.sources[0]?.coverage, coverage);
  } finally { await fixture.close(); }
});

test("summary and accessible comment totals stay distinct after complete public pagination", async () => {
  const Provider = await import("../src/history-provider.js"); const fixture = await historyFixture();
  fixture.counts.set("comments", 8);
  fixture.rows.set("comments", Array.from({ length: 5 }, (_, index) => ({ CommentID: String(index), Commenter: second,
    Timestamp: 20 + index, Message: `Public comment ${index}`, IsDeleted: 0 })));
  try {
    const report = History.view(await Effect.runPromise(Provider.fetchAccount(seed, fixture.session)));
    assert.equal(report.comments.length, 5);
    const coverage = report.sources[0]?.coverage.find((row) => row.section === "comments");
    assert.deepEqual(coverage && { captured: coverage.captured, total: coverage.total, expected: coverage.expected, status: coverage.status },
      { captured: 5, total: 5, expected: 8, status: "partial" });
    assert.match(coverage?.error ?? "", /supporter access/);
    assert.match(coverage?.error ?? "", /summary may also be outdated/);
    assert.ok(fixture.paths.some((path) => path.includes("commentFilter=all")));
    assert.ok(fixture.paths.some((path) => path.includes("commentFilter=deleted")));
    assert.equal(report.profile.historic.comments?.length, 5);
    assert.equal(report.comments.some((comment) => comment.message.includes("deleted")), false);
  } finally { await fixture.close(); }
});

test("pagination stops truthfully on repeated, empty, changed and malformed pages", async () => {
  const Provider = await import("../src/history-provider.js"); const fixture = await historyFixture();
  const friends = Array.from({ length: 205 }, (_, index) => ({ Friend: String(BigInt(seed) + 1000n + BigInt(index)), FriendDate: 10 }));
  fixture.rows.set("friends", friends);
  try {
    for (const [payload, expected] of [
      [JSON.stringify({ data: friends.slice(0, 100), total: 205 }), /repeated/],
      [JSON.stringify({ data: [], total: 205 }), /ended pagination/],
      [JSON.stringify({ data: friends.slice(100, 200), total: 206 }), /total changed/],
      ["not JSON", /malformed/],
    ] satisfies [string, RegExp][]) {
      fixture.replies.set("friends:100", payload);
      const report = History.view(await Effect.runPromise(Provider.fetchAccount(seed, fixture.session)));
      assert.equal(report.friends.length, 100); assert.match(History.coverageError(report) ?? "", expected);
    }
  } finally { await fixture.close(); }
});

test("capture byte accounting retains earlier Unicode pages when the size limit is reached", async () => {
  const Provider = await import("../src/history-provider.js"); const fixture = await historyFixture();
  fixture.rows.set("friends", Array.from({ length: 305 }, (_, index) => ({
    Friend: String(BigInt(seed) + 1000n + BigInt(index)), FriendDate: 10, Name: "界".repeat(3000),
  })));
  try {
    const report = History.view(await Effect.runPromise(Provider.fetchAccount(seed, fixture.session)));
    assert.equal(report.friends.length, 200);
    assert.match(History.coverageError(report) ?? "", /2 MB limit/);
    const capture = report.sources[0]; assert.ok(capture);
    assert.ok(Buffer.byteLength(capture.contents) < 2 * 1024 * 1024);
    assert.equal((await Effect.runPromise(History.parse(capture.contents))).sources[0]?.snapshots[0]?.historic.friends?.length, 200);
  } finally { await fixture.close(); }
});

test("another account in the live profile is rejected before history pages or saving", async () => {
  const Provider = await import("../src/history-provider.js"); const fixture = await historyFixture(); fixture.document.steamID64 = second;
  try { await assert.rejects(Effect.runPromise(Provider.fetchAccount(seed, fixture.session)), /another account/); assert.equal(fixture.requests(), 1); }
  finally { await fixture.close(); }
});

test("VAC counts survive real Steam collection, persistence and exports", async () => {
  const { steamFixture, key } = await import("./fixtures.js");
  const Storage = await import("../src/storage.js"); const Steam = await import("../src/steam.js"); const Scanner = await import("../src/scanner.js");
  const fixture = await steamFixture(); fixture.vacCounts.set(second, 3);
  const root = await mkdtemp(join(tmpdir(), 'vapora-vac-'));
  try {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const created = yield* Scanner.create(seed, { ...defaults, requestsPerMinute: 0, maxNodes: 2 });
      const completed = yield* Scanner.run(created);
      const store = yield* Storage.Service; const saved = yield* store.read(completed.id);
      assert.equal(saved.players.find((row) => row.id === second)?.bans?.vacCount, 3);
      assert.equal(saved.players.find((row) => row.id === second)?.bans?.vac, true);
      assert.ok(saved.players.find((row) => row.id === second)?.bansObservedAt);
      return yield* store.readArtifact(saved.id, 'scan.json');
    }).pipe(Effect.provide(Steam.layer({ key, requestsPerMinute: 0, baseUrl: fixture.url, retryBaseMs: 1 })), Effect.provide(Storage.layer(root))));
    assert.equal(JSON.parse(result).players.find((row: { id: string }) => row.id === second).bans.vacCount, 3);
  } finally { await fixture.close(); await rm(root, { recursive: true, force: true }); }
});

test("weighted near ties sort at full precision, while unknown comparisons retain the configured denominator", () => {
  const settings = { ...defaults, weights: { mutual: 1, jaccard: 0, groups: 0, games: 1e-10 } };
  const network = scan([
    player(seed, [second, third], { games: [1], gamesStatus: "public" }),
    player(second, [seed, third], { games: [1, 2], gamesStatus: "public" }),
    player(third, [seed, second], { games: [1], gamesStatus: "public" }),
  ], settings);
  const report = Analysis.analyze(network);
  assert.equal(report.friends[0]?.id, third);
  assert.equal(report.friends[0]?.score?.toFixed(1), report.friends[1]?.score?.toFixed(1));
  const unknown = Analysis.analyze({ ...network, settings: { ...settings, weights: { ...settings.weights, games: 1 } },
    players: network.players.map((row) => ({ ...row, gamesStatus: "private" as const })) });
  assert.equal(unknown.friends[0]?.gameJaccard, null);
  assert.equal(unknown.friends[0]?.score, (unknown.friends[0]?.countIndex ?? 0) / 2);
});
test("old provisional intervals stop at their own capture date and anonymous NDJSON snapshots reconcile by maximum multiplicity", async () => {
  const first = profile(20, [{ Friend: second, FriendDate: 10 }], [{ Commenter: second, Message: "same" }, { Commenter: second, Message: "same" }]);
  const secondSnapshot = profile(50, [{ Friend: second, FriendDate: 30, UnfriendDate: 40 }], [{ Commenter: second, Message: "same" }, { Commenter: second, Message: "same" }, { Commenter: second, Message: "same" }]);
  const bundle = await Effect.runPromise(History.parse(`${JSON.stringify(first)}\n${JSON.stringify(secondSnapshot)}`));
  assert.equal(History.view(bundle).friends[0]?.durationSeconds, 20);
  assert.equal(History.view(bundle).comments.length, 3);
  const invalidEnd = await parse(profile(50, [{ Friend: second, FriendDate: 10, UnfriendDate: -1 }]));
  assert.equal(History.view(invalidEnd).friends[0]?.status, "unknown");
  assert.equal(History.view(invalidEnd).friends[0]?.durationSeconds, null);
  const bytes = '\ufeff' + JSON.stringify({ ...profile(50), historic: { ...profile(50).historic, unknownSection: { nested: "keep" } } });
  const raw = await Effect.runPromise(History.parse(bytes));
  assert.equal(History.view(raw).sources[0]?.contents, bytes);
});

test("importing an older captured comment never rolls back its newer version or loses version source dates", async () => {
  const old = await parse(profile(100, [{ Friend: second, FriendDate: 1, UnfriendDate: 60 }], [{ ID: "edited", Commenter: second, Timestamp: 50, Message: "before" }]));
  const recent = await parse(profile(200, [{ Friend: second, FriendDate: 1, UnfriendDate: 60 }], [{ ID: "edited", Commenter: second, Timestamp: 50, Message: "after" }]));
  const report = History.view({ sources: [...recent.sources, ...old.sources] });
  assert.equal(report.comments[0]?.message, "after");
  assert.equal(report.comments[0]?.versions[0]?.sourceAsOf, 200);
  assert.equal(report.comments[0]?.friendAtComment, "yes");
  assert.equal(report.commenters[0]?.status, "former");
});

test("equal observation dates select the newest captured comment independently of import order", async () => {
  const old = await parse(profile(200, [], [{ ID: "same", Commenter: second, Message: "before", Timestamp: 100 }]));
  const recent = await parse(profile(200, [], [{ ID: "same", Commenter: third, Message: "after", Timestamp: 150 }]));
  assert.ok(old.sources[0]); assert.ok(recent.sources[0]);
  const oldSource = { ...old.sources[0], capturedAt: "2026-10-08T01:00:00+02:00" };
  const newSource = { ...recent.sources[0], capturedAt: "2026-10-07T23:30:00Z" };
  for (const sources of [[oldSource, newSource], [newSource, oldSource]]) {
    const report = History.view({ sources });
    assert.equal(report.comments[0]?.message, "after"); assert.equal(report.comments[0]?.author, third);
    assert.equal(report.comments[0]?.timestamp, 150); assert.equal(report.comments[0]?.versions.length, 2);
    assert.equal(report.commenters[0]?.id, third);
  }
});

test("older friendship evidence stays in the comment reference and undated live lists do not override dated history", async () => {
  const old = await parse(profile(100, [{ Friend: second, FriendDate: 10, UnfriendDate: 90, countryCode: "ES", cityID: 1 }], [{ Commenter: second, Timestamp: 50, Message: "friend" }]));
  const recent = await parse(profile(200));
  const bundle = { sources: [...old.sources, ...recent.sources] };
  const undated = scan([player(seed, [second], { friendsObservedAt: null })]);
  const report = History.view(bundle, undated);
  assert.equal(report.referenceSize, 1); assert.ok(report.commenters[0]?.index);
  assert.equal(report.locations[0]?.contributors, 1);
  assert.equal(report.friends[0]?.status, "former"); assert.equal(report.friends[0]?.asOf, 100);
  assert.equal(report.commenters[0]?.status, "former");
  const open = await parse(profile(100, [{ Friend: second, FriendDate: 10 }]));
  assert.equal(History.view(open, scan([player(seed, [], { friendsObservedAt: null })])).friends[0]?.status, "current");
});

test("friend and commenter membership select the newest observation and expose same-date contradictions", async () => {
  const event = { ID: "dated", Commenter: second, Timestamp: 20, Message: "hello" };
  const current = await parse(profile(200, [{ Friend: second, FriendDate: 10 }], [event]));
  const former = await parse(profile(200, [{ Friend: second, FriendDate: 10, UnfriendDate: 150 }], [event]));
  const datedScan = (stamp: number, friends: readonly typeof second[], friendsStatus: "public" | "private" = "public") =>
    scan([player(seed, friends, { friendsObservedAt: new Date(stamp * 1000).toISOString(), friendsStatus })]);
  for (const [bundle, list, expected] of [[current, [], "current"], [former, [second], "former"]] as const) {
    const report = History.view(bundle, datedScan(100, list));
    assert.equal(report.friends[0]?.status, expected); assert.equal(report.friends[0]?.asOf, 200);
    assert.equal(report.commenters[0]?.status, expected); assert.equal(report.commenters[0]?.asOf, 200);
  }
  const newer = History.view(current, datedScan(300, []));
  assert.equal(newer.friends[0]?.status, "former"); assert.equal(newer.friends[0]?.asOf, 300);
  assert.equal(newer.commenters[0]?.status, "former"); assert.equal(newer.commenters[0]?.asOf, 300);
  assert.equal(History.view(current, datedScan(300, [], "private")).friends[0]?.status, "current");
  const liveOnly = await parse(profile(200, [], [event]));
  const liveOnlyMember = History.view(liveOnly, datedScan(300, [second])).commenters[0];
  assert.equal(liveOnlyMember?.status, "current"); assert.equal(liveOnlyMember?.asOf, 300);
  assert.equal(History.view(liveOnly, datedScan(300, [])).commenters[0]?.asOf, null);
  assert.equal(History.view(liveOnly, scan([player(seed, [second], { friendsObservedAt: null })])).commenters[0]?.asOf, null);
  const contradiction = History.view(current, datedScan(200, []));
  assert.equal(contradiction.friends[0]?.status, "unknown");
  assert.equal(contradiction.commenters[0]?.status, "unknown");
  assert.ok(contradiction.warnings.some((warning) => warning.includes("Same-date")));
});

test("cyclic deferred chunks fail explicitly at the stream boundary", async () => {
  const contents = [
    { type: "data", nodes: [{ type: "data", data: [["Promise", 1]] }] },
    { type: "chunk", id: 1, data: [["Promise", 2]] },
    { type: "chunk", id: 2, data: [["Promise", 1]] },
  ].map((line) => JSON.stringify(line)).join('\n');
  await assert.rejects(Effect.runPromise(History.parse(contents)), /cyclic stream chunks/);
});
