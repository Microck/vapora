import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { defaults, Settings } from "../src/model.js";
import * as Identifiers from "../src/ids.js";
import * as Analysis from "../src/analysis.js";
import * as History from "../src/history.js";
import { player, scan, seed, second, third, fourth, fifth } from "./fixtures.js";

test("individual account IDs round-trip without Number precision loss", async () => {
  for (const input of [seed, "STEAM_0:1:0", "[U:1:1]", `https://steamcommunity.com/profiles/${seed}/`, `steamcommunity.com/profiles/${seed}`]) {
    assert.deepEqual(await Effect.runPromise(Identifiers.parse(input)), { kind: "id", id: seed });
  }
  assert.deepEqual(await Effect.runPromise(Identifiers.parse("https://steamcommunity.com/id/alice/?x=1")), { kind: "vanity", vanity: "alice" });
  for (const vanity of ["12345", seed, "STEAM_example"]) {
    assert.deepEqual(await Effect.runPromise(Identifiers.parse(`https://steamcommunity.com/id/${vanity}/`)), { kind: "vanity", vanity });
  }
  for (const input of ["", "12345", "https://steamcommunity.com.evil/id/alice", "https://evil.test/id/alice", "[U:2:1]", "STEAM_0:2:1", "76561197960265728", "99999999999999999", "https://steamcommunity.com/profiles/alice", "https://alice@steamcommunity.com/id/alice", "https://steamcommunity.com/id/a/b", "https://steamcommunity.com/id/STEAM_0:1:1"]) {
    await assert.rejects(Effect.runPromise(Identifiers.parse(input)));
  }
});
test("settings accept zero limits and reject fractions, NaN, negatives and invalid depth", () => {
  assert.deepEqual(Schema.decodeUnknownSync(Settings)({ ...defaults, maxNodes: 0, requestsPerMinute: 0 }), { ...defaults, maxNodes: 0, requestsPerMinute: 0 });
  for (const settings of [{ ...defaults, depth: 0 }, { ...defaults, depth: 1.5 }, { ...defaults, depth: 6 }, { ...defaults, maxNodes: -1 }, { ...defaults, maxNodes: 1001 }, { ...defaults, requestsPerMinute: -1 }, { ...defaults, requestsPerMinute: 0.5 }, { ...defaults, hubPercentile: NaN }, { ...defaults, weights: { ...defaults.weights, games: -1 } }]) {
    assert.throws(() => Schema.decodeUnknownSync(Settings)(settings));
  }
});
test("coverage separates private, skipped, pending and unavailable friend lists", () => {
  const report = Analysis.analyze(scan([
    player(seed, [second, third, fourth, fifth]), player(second, [], { friendsStatus: "private" }),
    player(third, [], { friendsStatus: "skipped" }), player(fourth, [], { friendsStatus: "unavailable" }),
    player(fifth, [], { friendsStatus: "pending" }),
  ]));
  assert.deepEqual(report.coverage, { nodes: 5, publicLists: 1, privateLists: 1, skippedLists: 1, unavailableLists: 1, pendingLists: 1, directFriends: 4, admittedDirectFriends: 4, truncated: false });
});
test("undirected metrics, percentile hubs, clean edges, and exact mutual signals", () => {
  const network = scan([
    player(seed, [second, third, fourth]), player(second, [seed, third]), player(third, [seed, second]), player(fourth, [seed]),
  ]);
  const report = Analysis.analyze(network);
  assert.equal(report.edges.length, 4);
  assert.equal(report.metrics.find((m) => m.id === seed)?.degree, 3);
  assert.equal(report.metrics.find((m) => m.id === seed)?.betweenness, 2 / 3);
  assert.deepEqual(report.metrics.filter((m) => m.hub).map((m) => m.id), [seed]);
  assert.equal(report.friends.find((f) => f.id === second)?.mutual, 1);
  assert.deepEqual(report, Analysis.analyze(network));
  assert.equal(Analysis.analyze(scan([player(seed, [])])).metrics[0]?.hub, false);
  const triangle = Analysis.analyze(scan([player(seed, [second, third]), player(second, [seed, third]), player(third, [seed, second])]));
  assert.equal(triangle.metrics.filter((m) => m.hub).length, 0);
});
test("private signals remain unknown and group edges do not change centrality", () => {
  const network = scan([
    player(seed, [second, third], { groups: ["g"], groupsStatus: "public" }),
    player(second, [], { friendsStatus: "private", groups: ["g"], groupsStatus: "public", country: "ES", state: "56", city: 123 }),
    player(third, [seed, second], { groups: ["g"], groupsStatus: "public" }),
  ]);
  const report = Analysis.analyze(network);
  assert.equal(report.edges.filter((e) => e.kind === "group").length, 3);
  assert.equal(report.friends.find((f) => f.id === second)?.jaccard, null);
  assert.equal(report.friends.find((f) => f.id === second)?.mutual, 1);
  assert.equal(report.locations[0]?.contributors, 1);
  assert.equal(report.locations[0]?.share, 100);
  assert.ok(report.warnings.some((warning) => warning.includes("lower bounds")));
  assert.ok(report.metrics.every((metric) => Number.isFinite(metric.betweenness)));
});
test("CSV preserves names and newlines while blocking spreadsheet formulas", () => {
  assert.equal(Analysis.csv([["Id", "Label"], [seed, 'Alice, "A"\nB'], [second, '=HYPERLINK("https://bad")'], [third, -1]]),
    `Id,Label\r\n${seed},"Alice, ""A""\nB"\r\n${second},"'=HYPERLINK(""https://bad"")"\r\n${third},-1\r\n`);
});
test("history merges overlapping periods and selects the latest NDJSON snapshot", async () => {
  const profile = {
    steamID64: seed, lastChecked: 1000, historic: { friends: [
      { Friend: second, FriendDate: 100, UnfriendDate: 300 }, { Friend: second, FriendDate: 200, UnfriendDate: 400 },
      { Friend: third, FriendDate: 500, Name: "Carol" },
    ], persona: [{ Name: "Old name" }] },
  };
  const parsed = await Effect.runPromise(History.parse(JSON.stringify(profile)));
  const report = await Effect.runPromise(History.analyze(parsed));
  assert.equal(report.friends.find((f) => f.id === second)?.durationSeconds, 300);
  assert.equal(report.friends.find((f) => f.id === third)?.durationSeconds, 500);
  assert.equal(report.friends.find((f) => f.id === third)?.currentlyFriends, true);
  assert.equal(report.profile.historic.persona?.length, 1);
  const ndjson = `${JSON.stringify({ ...profile, lastChecked: 900 })}\n${JSON.stringify(profile)}`;
  assert.equal((await Effect.runPromise(History.parse(ndjson))).lastChecked, 1000);
  await assert.rejects(Effect.runPromise(History.parse(`${JSON.stringify(profile)}\n${JSON.stringify({ ...profile, steamID64: second })}`)));
  await assert.rejects(Effect.runPromise(History.analyze({ ...parsed, historic: { friends: [{ Friend: second, FriendDate: 1200 }] } })));
});
