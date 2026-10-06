import { UndirectedGraph } from "graphology";
import louvain from "graphology-communities-louvain";
import betweenness from "graphology-metrics/centrality/betweenness.js";
import { Effect } from "effect";
import type { Player, Scan, SteamId } from "./model.js";
import type { Edge, FriendRank, LocationSignal, Report } from "./contracts.js";
import * as Storage from "./storage.js";

export type { Report } from "./contracts.js";

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

function rankFriends(scan: Scan, players: ReadonlyMap<SteamId, Player>, seed: Player): FriendRank[] {
  const seedFriends = new Set(seed.friends.filter((id) => id !== scan.seed));
  const seedGroups = new Set(seed.groups); const seedGames = new Set(seed.games);
  const neighbors = new Map(scan.players.map((p) => [p.id, new Set(p.friends)]));
  const weights = scan.settings.weights;
  const ranks: Omit<FriendRank, "evidenceScore">[] = [];
  for (const id of seedFriends) {
    const player = players.get(id);
    if (!player) continue;
    const friendSet = neighbors.get(id) ?? new Set<SteamId>();
    const mutuals = new Set([...friendSet].filter((friend) => seedFriends.has(friend) && friend !== id));
    // A public list can establish an undirected friendship even when the other list is private.
    for (const other of seedFriends) if (other !== id && neighbors.get(other)?.has(id)) mutuals.add(other);
    const union = new Set([...friendSet, ...seedFriends]);
    const jaccard = seed.friendsStatus === "public" && player.friendsStatus === "public" ? intersection(seedFriends, friendSet) / Math.max(1, union.size) : null;
    const groups = seed.groupsStatus === "public" && player.groupsStatus === "public" ? intersection(seedGroups, new Set(player.groups)) : null;
    const games = seed.gamesStatus === "public" && player.gamesStatus === "public" ? intersection(seedGames, new Set(player.games)) : null;
    ranks.push({ id, name: player.name, mutual: mutuals.size, jaccard, sharedGroups: groups, sharedGames: games,
      score: mutuals.size * weights.mutual + (jaccard ?? 0) * weights.jaccard + (groups ?? 0) * weights.groups + (games ?? 0) * weights.games,
      friendsStatus: player.friendsStatus,
    });
  }
  ranks.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const maxScore = ranks[0]?.score ?? 0;
  const friends: FriendRank[] = ranks.map((rank) => ({ ...rank, evidenceScore: maxScore ? rank.score / maxScore * 100 : 0 }));
  return friends;
}

function locationSignals(friends: readonly FriendRank[], players: ReadonlyMap<SteamId, Player>): LocationSignal[] {
  const signals = new Map<string, Omit<LocationSignal, "share">>();
  for (const rank of friends) {
    const player = players.get(rank.id);
    if (!player?.country) continue;
    const key = `${player.country}/${player.state ?? ""}/${player.city ?? ""}`;
    const previous = signals.get(key);
    signals.set(key, { country: player.country, state: player.state, city: player.city,
      contributors: (previous?.contributors ?? 0) + 1, weight: (previous?.weight ?? 0) + rank.mutual + 1,
    });
  }
  const totalWeight = [...signals.values()].reduce((sum, signal) => sum + signal.weight, 0);
  const locations = [...signals.values()].map((signal) => ({ ...signal, share: totalWeight ? signal.weight / totalWeight * 100 : 0 })).sort((a, b) => b.weight - a.weight);
  return locations;
}

export function analyze(scan: Scan): Report {
  const { graph, edges: friendships, players, seed, sorted } = buildFriendships(scan);
  const edges = [...friendships, ...sharedGroupEdges(scan)].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.kind.localeCompare(b.kind));
  const metrics = graphMetrics(graph, sorted, scan.settings.hubPercentile);
  const friends = rankFriends(scan, players, seed);
  const locations = locationSignals(friends, players);
  const seedFriends = new Set(seed.friends.filter((id) => id !== scan.seed));
  const publicLists = scan.players.filter((p) => p.friendsStatus === "public").length;
  const skippedLists = scan.players.filter((p) => p.friendsStatus === "skipped").length;
  const warnings = ["Scores describe public network signals. They do not establish real-life friendship or residence."];
  if (scan.truncated) warnings.push("The node cap truncated the network. Missing nodes can change graph metrics and rankings.");
  if (publicLists < scan.players.length) warnings.push("Some friend lists are private, unavailable or skipped. Observed mutual counts are lower bounds.");
  if (skippedLists) warnings.push(`${skippedLists} private profile(s) skipped by collection policy. Known incoming friendships remain included.`);
  if (scan.players.some((p) => p.groupsStatus === "unavailable")) warnings.push("Steam denied or could not provide group membership. Publisher permissions may be required.");
  if (scan.players.some((p) => p.bans === null)) warnings.push("Ban data is unavailable or skipped for some profiles. Missing records mean unknown, not unbanned.");
  if (seedFriends.size > friends.length) warnings.push("Some direct friends fall outside the node cap and are not ranked.");
  return {
    runId: scan.id, seed: scan.seed, edges, metrics, friends, locations, warnings,
    coverage: { nodes: players.size, publicLists, skippedLists, unavailableLists: players.size - publicLists - skippedLists,
      directFriends: seedFriends.size, admittedDirectFriends: friends.length, truncated: scan.truncated },
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
  const report = analyze(scan);
  const players = new Map(scan.players.map((p) => [p.id, p]));
  const nodes = csv([
    ["Id", "Label", "degree", "betweenness", "modularity_class", "is_seed", "is_hub", "is_banned", "is_public"],
    ...report.metrics.map((metric) => {
      const player = players.get(metric.id);
      return [metric.id, player?.name ?? metric.id, metric.degree, metric.betweenness, metric.community, metric.id === scan.seed,
        metric.hub, player?.bans ? player.bans.vac || player.bans.game > 0 || player.bans.community : null,
        player?.visibility === "unavailable" || player?.visibility === "pending" ? null : player?.visibility === "public"];
    }),
  ]);
  const edges = csv([["Source", "Target", "Kind"], ...report.edges.map((edge) => [edge.source, edge.target, edge.kind])]);
  const friends = csv([
    ["candidate_steamid", "name", "score", "evidence_score", "mutual_count", "jaccard_with_seed", "shared_groups", "shared_games", "friends_status"],
    ...report.friends.map((rank) => [rank.id, rank.name, rank.score, rank.evidenceScore, rank.mutual, rank.jaccard, rank.sharedGroups, rank.sharedGames, rank.friendsStatus]),
  ]);
  yield* store.writeArtifact(scan.id, "analysis.json", JSON.stringify(report, null, 2));
  yield* store.writeArtifact(scan.id, "gephi/nodes.csv", nodes);
  yield* store.writeArtifact(scan.id, "gephi/edges.csv", edges);
  yield* store.writeArtifact(scan.id, "probable-friends.csv", friends);
  return report;
});
