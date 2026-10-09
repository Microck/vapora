import { UndirectedGraph } from "graphology";
import louvain from "graphology-communities-louvain";
import betweenness from "graphology-metrics/centrality/betweenness.js";
import { Worker } from "node:worker_threads";
import { Effect, Schema } from "effect";
import type { Player, Scan, SteamId } from "./model.js";
import { InputError } from "./model.js";
import type { Ranking } from "./model.js";
import type { Edge, FriendRank, Report } from "./contracts.js";
import * as Scoring from "./scoring.js";
import * as Storage from "./storage.js";

export type { Report } from "./contracts.js";

export class AnalysisError extends Schema.TaggedError<AnalysisError>()("AnalysisError", { message: Schema.String }) {}

/** Own the worker until it exits, including when collection or application shutdown interrupts it. */
export const calculate = Effect.fn("Analysis.calculate")(function* (scan: Scan) {
  return yield* Effect.acquireUseRelease(
    Effect.try({ try: () => new Worker(new URL("./analysis-worker.js", import.meta.url), { workerData: scan }),
      catch: (error) => new AnalysisError({ message: `Could not start network analysis: ${String(error)}` }) }),
    (worker) => Effect.tryPromise({
      try: () => new Promise<Report>((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
        worker.once("exit", (code) => reject(new Error(`Network analysis exited before returning results (${code}).`)));
      }),
      catch: (error) => new AnalysisError({ message: `Network analysis failed: ${String(error)}` }),
    }),
    (worker) => Effect.promise(() => worker.terminate()),
  );
});

const intersection = <T>(left: ReadonlySet<T>, right: ReadonlySet<T>): number => {
  let count = 0;
  for (const value of left) if (right.has(value)) count++;
  return count;
};

/** Centrality uses only admitted undirected friendships. Raw lists remain available for ranking signals. */
function buildFriendships(scan: Scan) {
  const graph = new UndirectedGraph();
  const players = new Map(scan.players.map((p) => [p.id, p]));
  const seed = players.get(scan.seed);
  if (!seed) throw new Error("Scan invariant failed: missing seed");
  const sorted = [...players.keys()].sort();
  for (const id of sorted) graph.addNode(id);
  const edges: Edge[] = [];
  for (const id of sorted) {
    const player = players.get(id);
    if (!player) continue;
    for (const friend of player.friends) {
      if (!players.has(friend) || friend === id || graph.hasEdge(id, friend)) continue;
      graph.addEdge(id, friend);
      edges.push({ source: id < friend ? id : friend, target: id < friend ? friend : id, kind: "friend" });
    }
  }
  return { graph, edges, players, seed, sorted };
}

function sharedGroupEdges(scan: Scan): Edge[] {
  const edges: Edge[] = [];
  const groupMembers = new Map<string, SteamId[]>();
  for (const player of scan.players) for (const group of new Set(player.groups)) {
    const members = groupMembers.get(group) ?? [];
    members.push(player.id);
    groupMembers.set(group, members);
  }
  const groupPairs = new Set<string>();
  for (const members of groupMembers.values()) {
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
      const left = members[i]; const right = members[j];
      if (!left || !right) continue;
      const source = left < right ? left : right; const target = left < right ? right : left;
      const key = `${source}:${target}`;
      if (groupPairs.has(key)) continue;
      groupPairs.add(key);
      edges.push({ source, target, kind: "group" });
    }
  }
  return edges;
}

function graphMetrics(graph: UndirectedGraph, sorted: readonly SteamId[], percentile: number) {
  const centrality = graph.order > 2 ? betweenness(graph, { normalized: true, getEdgeWeight: null }) : {};
  const communities = louvain(graph, { randomWalk: false, getEdgeWeight: null });
  const scores = sorted.map((id) => centrality[id] ?? 0).sort((a, b) => a - b);
  const threshold = scores[Math.max(0, Math.ceil(scores.length * percentile) - 1)] ?? 0;
  const metrics = sorted.map((id) => ({ id, degree: graph.degree(id), betweenness: centrality[id] ?? 0,
    community: communities[id] ?? 0, hub: (centrality[id] ?? 0) > 0 && (centrality[id] ?? 0) >= threshold,
  }));
  return metrics;
}

function compareLists<T>(left: readonly T[], right: readonly T[] | undefined, leftStatus: string, rightStatus: string | undefined) {
  if (leftStatus !== "public" || rightStatus !== "public" || !right) return null;
  const l = new Set(left); const r = new Set(right); const shared = intersection(l, r);
  return { shared, jaccard: shared / Math.max(1, l.size + r.size - shared) };
}

function friendSignals(seed: Player, player: Player | undefined) {
  const friends = compareLists(seed.friends, player?.friends, seed.friendsStatus, player?.friendsStatus);
  const groups = compareLists(seed.groups, player?.groups, seed.groupsStatus, player?.groupsStatus);
  const games = compareLists(seed.games, player?.games, seed.gamesStatus, player?.gamesStatus);
  return { jaccard: friends?.jaccard ?? null, sharedGroups: groups?.shared ?? null, sharedGames: games?.shared ?? null,
    groupJaccard: groups?.jaccard ?? null, gameJaccard: games?.jaccard ?? null };
}
function combinedScore(index: number | null, signals: ReturnType<typeof friendSignals>, weights: Ranking["weights"]) {
  const denominator = weights.mutual + weights.jaccard + weights.groups + weights.games;
  return denominator ? (weights.mutual * (index ?? 0) + 100 * weights.jaccard * (signals.jaccard ?? 0) +
    100 * weights.groups * (signals.groupJaccard ?? 0) + 100 * weights.games * (signals.gameJaccard ?? 0)) / denominator : null;
}

function rankFriends(scan: Scan, players: ReadonlyMap<SteamId, Player>, seed: Player): FriendRank[] {
  const seedFriends = new Set(seed.friends.filter((id) => id !== scan.seed));
  const neighbors = new Map(scan.players.filter((p) => p.friendsStatus === "public").map((p) => [p.id, new Set(p.friends)]));
  const incoming = new Map<SteamId, Set<SteamId>>();
  for (const other of seedFriends) for (const id of neighbors.get(other) ?? []) {
    if (id === other || !seedFriends.has(id)) continue;
    const sources = incoming.get(id) ?? new Set<SteamId>(); sources.add(other); incoming.set(id, sources);
  }
  const counts = Scoring.countIndex([...seedFriends].map((id) => incoming.get(id)?.size ?? 0), scan.settings.topN, scan.settings.countBaseline);
  const weights = scan.settings.weights;
  const denominator = weights.mutual + weights.jaccard + weights.groups + weights.games;
  const ranks: FriendRank[] = [];
  const rank = (id: SteamId): FriendRank => {
    const player = players.get(id);
    const mutuals = new Set(incoming.get(id));
    for (const friend of neighbors.get(id) ?? []) if (seedFriends.has(friend) && friend !== id) mutuals.add(friend);
    const signals = friendSignals(seed, player);
    const incomingMutual = incoming.get(id)?.size ?? 0;
    const index = counts(incomingMutual);
    const score = combinedScore(index, signals, weights);
    return { id, name: player?.name ?? id, admitted: Boolean(player), mutual: mutuals.size, incomingMutual, countIndex: index,
      ...signals,
      score, evidenceScore: score, friendsStatus: player?.friendsStatus ?? "pending" };
  };
  for (const id of seedFriends) ranks.push(rank(id));
  return ranks.sort((a, b) => denominator ? (b.score ?? 0) - (a.score ?? 0) || a.id.localeCompare(b.id) : b.incomingMutual - a.incomingMutual || a.id.localeCompare(b.id));
}

export function analyze(scan: Scan): Report {
  const { graph, edges: friendships, players, seed, sorted } = buildFriendships(scan);
  const edges = [...friendships, ...sharedGroupEdges(scan)].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.kind.localeCompare(b.kind));
  const metrics = graphMetrics(graph, sorted, scan.settings.hubPercentile);
  const friends = rankFriends(scan, players, seed);
  const locations = Scoring.locations(friends.map((rank) => ({ country: players.get(rank.id)?.country ?? null,
    state: players.get(rank.id)?.state ?? null, city: players.get(rank.id)?.city ?? null, count: rank.incomingMutual })), scan.settings);
  const seedFriends = new Set(seed.friends.filter((id) => id !== scan.seed));
  const listCounts = { public: 0, private: 0, skipped: 0, unavailable: 0, pending: 0, disabled: 0 };
  for (const player of scan.players) listCounts[player.friendsStatus]++;
  const { public: publicLists, private: privateLists, skipped: skippedLists, unavailable: unavailableLists, pending: pendingLists } = listCounts;
  const warnings = ["Scores describe public network signals. They do not establish real-life friendship or residence."];
  if (scan.truncated) warnings.push("The node cap truncated the network. Missing nodes can change graph metrics and rankings.");
  if (publicLists < scan.players.length) warnings.push("Some friend lists are private, unavailable or skipped. Observed mutual counts are lower bounds.");
  if (skippedLists) warnings.push(`${skippedLists} private profile(s) skipped by collection policy. Known incoming friendships remain included.`);
  if (scan.players.some((p) => p.groupsStatus === "unavailable")) warnings.push("Steam denied or could not provide group membership. Publisher permissions may be required.");
  if (scan.players.some((p) => p.bans === null)) warnings.push("Ban data is unavailable or skipped for some profiles. Missing records mean unknown, not unbanned.");
  if (friends.some((friend) => !friend.admitted)) warnings.push("Some direct friends fall outside the admitted graph. Their observed incoming signals remain ranked.");
  return {
    runId: scan.id, seed: scan.seed, edges, metrics, friends, locations, warnings,
    locationCoverage: { referenceSize: friends.length, located: locations.reduce((count, city) => count + city.contributors, 0),
      missingLocation: friends.length - locations.reduce((count, city) => count + city.contributors, 0), uncollected: friends.filter((friend) => !friend.admitted).length },
    coverage: { nodes: players.size, publicLists, privateLists, skippedLists, unavailableLists, pendingLists,
      directFriends: seedFriends.size, admittedDirectFriends: friends.filter((friend) => friend.admitted).length, truncated: scan.truncated },
  };
}

/** RFC 4180 quoting preserves names; a leading apostrophe blocks formulas in spreadsheet imports. */
export function csv(rows: readonly (readonly (string | number | boolean | null)[])[]): string {
  return rows.map((row) => row.map((field) => {
    let value = field === null ? "" : String(field);
    if (/^[\s]*[=+@-]/.test(value) && !Number.isFinite(Number(value))) value = `'${value}`;
    return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  }).join(",")).join("\r\n") + "\r\n";
}

export const exportRun = Effect.fn("Analysis.exportRun")(function* (scan: Scan) {
  const store = yield* Storage.Service;
  const report = yield* calculate(scan);
  const players = new Map(scan.players.map((p) => [p.id, p]));
  const nodes = csv([
    ["Id", "Label", "degree", "betweenness", "modularity_class", "is_seed", "is_hub", "is_banned", "vac_bans", "is_public"],
    ...report.metrics.map((metric) => {
      const player = players.get(metric.id);
      return [metric.id, player?.name ?? metric.id, metric.degree, metric.betweenness, metric.community, metric.id === scan.seed,
        metric.hub, player?.bans ? player.bans.vac || player.bans.game > 0 || player.bans.community : null,
        player?.bans?.vacCount ?? null,
        player?.visibility === "unavailable" || player?.visibility === "pending" ? null : player?.visibility === "public"];
    }),
  ]);
  const edges = csv([["Source", "Target", "Kind"], ...report.edges.map((edge) => [edge.source, edge.target, edge.kind])]);
  const friends = csv([
    ["candidate_steamid", "name", "score", "evidence_score", "undirected_mutual_count", "incoming_mutual_count", "authored_count_index", "admitted", "jaccard_with_seed", "shared_groups", "shared_games", "friends_status"],
    ...report.friends.map((rank) => [rank.id, rank.name, rank.score, rank.evidenceScore, rank.mutual, rank.incomingMutual, rank.countIndex, rank.admitted, rank.jaccard, rank.sharedGroups, rank.sharedGames, rank.friendsStatus]),
  ]);
  yield* store.writeArtifact(scan.id, "analysis.json", JSON.stringify(report, null, 2));
  yield* store.writeArtifact(scan.id, "gephi/nodes.csv", nodes);
  yield* store.writeArtifact(scan.id, "gephi/edges.csv", edges);
  yield* store.writeArtifact(scan.id, "probable-friends.csv", friends);
  return report;
});

/** Rebuild files without rewriting the checkpoint or collecting provider data. */
export const rebuild = Effect.fn("Analysis.rebuild")(function* (id: string) {
  const store = yield* Storage.Service;
  const scan = yield* store.read(id);
  if (scan.status !== "complete") return yield* Effect.fail(new InputError({ message: "Finish or resume this run before rebuilding exports." }));
  const report = yield* exportRun(scan);
  yield* store.log(id, "Rebuilt analysis exports from saved observations; checkpoint unchanged");
  return { scan, report };
});

/** Reranking changes analysis settings only; provider observations remain untouched. */
export const reanalyze = Effect.fn("Analysis.reanalyze")(function* (id: string, ranking: Ranking) {
  const store = yield* Storage.Service;
  const saved = yield* store.read(id);
  if (saved.status !== "complete") return yield* Effect.fail(new InputError({ message: "Finish or resume this run before saving a new ranking." }));
  const scan = { ...saved, settings: { ...saved.settings, ...ranking }, updatedAt: new Date().toISOString() };
  const report = yield* exportRun(scan);
  yield* store.save(scan);
  yield* store.log(id, "Saved ranking settings and regenerated analysis exports; collected observations unchanged");
  return { scan, report };
});
