import { Cause, Effect } from "effect";
import { InputError, failureMessage, newPlayer } from "./model.js";
import type { Player, Scan, Settings } from "./model.js";
import * as Identifiers from "./ids.js";
import * as Steam from "./steam.js";
import * as Storage from "./storage.js";
import * as Analysis from "./analysis.js";

import type { Progress } from "./contracts.js";
export type { Progress } from "./contracts.js";
export type Observe = (progress: Progress) => void;
const summary = (player: Player, record: Steam.Summary | undefined): Player => ({
  ...player,
  name: record?.personaname ?? player.id,
  avatar: record?.avatarfull ?? null,
  visibility: record?.communityvisibilitystate === undefined ? "unavailable" : record.communityvisibilitystate === 3 ? "public" : "private",
  country: record?.loccountrycode ?? null, state: record?.locstatecode ?? null, city: record?.loccityid ?? null,
});

export const create = Effect.fn("Scanner.create")(function* (target: string, settings: Settings) {
  const steam = yield* Steam.Service;
  const store = yield* Storage.Service;
  const parsed = yield* Identifiers.parse(target);
  const seed = parsed.kind === "id" ? parsed.id : yield* steam.resolve(parsed.vanity);
  const now = new Date().toISOString();
  const scan: Scan = {
    version: 2, id: Storage.runId(), seed, createdAt: now, updatedAt: now, status: "running", error: null,
    settings, players: [newPlayer(seed, 0, settings)], queue: [seed], truncated: false,
  };
  yield* store.create(scan);
  yield* store.log(scan.id, `Started scan of ${seed}`);
  return scan;
});

/** Explicit target lookup returns Steam identity without creating a run or collecting lists. */
export const lookup = Effect.fn("Scanner.lookup")(function* (target: string, settings: Settings) {
  const steam = yield* Steam.Service;
  const parsed = yield* Identifiers.parse(target);
  const id = parsed.kind === "id" ? parsed.id : yield* steam.resolve(parsed.vanity);
  const records = yield* steam.summaries([id]);
  const record = records.find((p) => p.steamid === id);
  if (!record) return yield* Effect.fail(new InputError({ message: "Steam did not return this account. Check the ID and API key." }));
  return summary(newPlayer(id, 0, settings), record);
});

/** A frontier item leaves the checkpoint only after all its observations have succeeded. */
export const run = Effect.fn("Scanner.run")(function* (initial: Scan, observe: Observe = () => {}) {
  const steam = yield* Steam.Service;
  const store = yield* Storage.Service;
  let scan: Scan = { ...initial, status: "running", error: null };
  const publish = (phase: string) => Effect.sync(() => observe({
    id: scan.id, phase, nodes: scan.players.length,
    scanned: scan.players.filter((p) => p.friendsStatus !== "pending").length, remaining: scan.queue.length,
  }));
  const checkpoint = (phase: string) => Effect.gen(function* () {
    scan = { ...scan, updatedAt: new Date().toISOString() };
    yield* store.save(scan);
    yield* publish(phase);
  });
  const workflow = Effect.gen(function* () {
    // Resume can use a new credential. Validate it before interpreting privacy or optional-access errors.
    yield* publish("Verifying Steam access");
    const verified = yield* steam.summaries([scan.seed]);
    const record = verified.find((p) => p.steamid === scan.seed);
    if (!record) return yield* Effect.fail(new InputError({ message: "Steam did not return this account. Check the ID and API key." }));
    scan = { ...scan, players: scan.players.map((p) => p.id === scan.seed ? summary(p, record) : p) };
    yield* checkpoint("Scanning friends");
    while (scan.queue.length) {
      // Batch frontier summaries before collection so the private-profile policy is enforceable.
      // Saved visibility prevents completed batches from being repeated on resume.
      const frontier = new Set(scan.queue);
      const summaryIds = scan.players.filter((p) => frontier.has(p.id) && p.visibility === "pending").slice(0, 100).map((p) => p.id);
      if (summaryIds.length) {
        const summaries = yield* steam.summaries(summaryIds);
        const records = new Map(summaries.map((record) => [record.steamid, record]));
        scan = { ...scan, players: scan.players.map((p) => summaryIds.includes(p.id) ? summary(p, records.get(p.id)) : p) };
        yield* checkpoint("Checking profile visibility");
      }
      const id = scan.queue[0];
      const player = scan.players.find((p) => p.id === id);
      if (!player) return yield* Effect.fail(new InputError({ message: "Checkpoint frontier has no matching profile." }));
      if (scan.settings.skipPrivate && player.visibility === "private") {
        const skipped: Player = { ...player, friendsStatus: "skipped", bansStatus: "skipped",
          groupsStatus: player.groupsStatus === "pending" ? "skipped" : player.groupsStatus,
          gamesStatus: player.gamesStatus === "pending" ? "skipped" : player.gamesStatus };
        scan = { ...scan, players: scan.players.map((p) => p.id === id ? skipped : p), queue: scan.queue.slice(1) };
        yield* store.log(scan.id, `${id}: private profile skipped by collection policy; incoming links retained`);
        yield* checkpoint("Skipping private profile");
        continue;
      }
      const friends = yield* steam.friends(player.id);
      const players = scan.players.map((p) => p.id === player.id ? { ...p, friends: friends.values, friendsStatus: friends.status } : p);
      const known = new Set(players.map((p) => p.id));
      const queue = scan.queue.slice(1);
      let truncated = scan.truncated;
      if (player.level < scan.settings.depth) {
        for (const friend of friends.values) {
          if (known.has(friend)) continue;
          if (scan.settings.maxNodes > 0 && players.length >= scan.settings.maxNodes) { truncated = true; continue; }
          known.add(friend);
          players.push(newPlayer(friend, player.level + 1, scan.settings));
          queue.push(friend);
        }
      }
      scan = { ...scan, players, queue, truncated };
      yield* store.log(scan.id, `${player.id}: ${friends.status} friend list, ${friends.values.length} observed friends`);
      yield* checkpoint("Scanning friends");
    }
    const pending = scan.players.filter((p) => p.bansStatus === "pending").map((p) => p.id);
    for (let offset = 0; offset < pending.length; offset += 100) {
      const batch = pending.slice(offset, offset + 100);
      const bans = yield* steam.bans(batch);
      scan = { ...scan, players: scan.players.map((player) => {
        if (!batch.includes(player.id)) return player;
        const ban = bans.find((b) => b.SteamId === player.id);
        return { ...player,
          bans: ban ? { vac: ban.VACBanned, game: ban.NumberOfGameBans, community: ban.CommunityBanned } : null,
          bansStatus: ban ? "public" : "unavailable",
        };
      }) };
      yield* checkpoint("Enriching profiles");
    }
    for (const player of scan.players) {
      let enriched = player;
      if (player.groupsStatus === "pending") {
        const groups = yield* steam.groups(player.id);
        enriched = { ...enriched, groupsStatus: groups.status, groups: groups.values };
      }
      if (player.gamesStatus === "pending") {
        const games = yield* steam.games(player.id);
        enriched = { ...enriched, gamesStatus: games.status, games: games.values };
      }
      if (enriched === player) continue;
      scan = { ...scan, players: scan.players.map((p) => p.id === player.id ? enriched : p) };
      yield* checkpoint("Collecting optional signals");
    }
    yield* publish("Analyzing network");
    yield* Analysis.exportRun(scan);
    scan = { ...scan, status: "complete" };
    yield* checkpoint("Complete");
    yield* store.log(scan.id, "Scan and exports complete");
    return scan;
  });
  // This is the lifecycle boundary: save interrupted work, but do not recover the failed scan.
  return yield* workflow.pipe(Effect.onExit((exit) => Effect.gen(function* () {
    if (exit._tag === "Success") return;
    const cancelled = Cause.hasInterrupts(exit.cause);
    const reason = cancelled ? null : failureMessage(exit.cause);
    scan = { ...scan, status: cancelled ? "cancelled" : "failed", error: reason, updatedAt: new Date().toISOString() };
    yield* store.save(scan);
    yield* store.log(scan.id, cancelled ? "Cancelled; checkpoint saved" : `Failed: ${Cause.pretty(exit.cause)}`);
  })));
});

export const estimate = Effect.fn("Scanner.estimate")(function* (target: string, settings: Settings) {
  const steam = yield* Steam.Service;
  const player = yield* lookup(target, settings);
  const seed = player.id;
  if (settings.skipPrivate && player.visibility === "private") {
    return { seed, available: false, directFriends: null, sampleSize: 0, estimatedNodes: null, cappedAt: settings.maxNodes,
      note: "The private target was skipped by your collection policy." };
  }
  const friends = yield* steam.friends(seed);
  if (friends.status !== "public") return { seed, available: false, directFriends: null, sampleSize: 0, estimatedNodes: null, cappedAt: settings.maxNodes };
  const sampleIds = friends.values.slice(0, 5);
  const sampleSummaries = settings.depth > 1 && settings.skipPrivate && sampleIds.length ? yield* steam.summaries(sampleIds) : [];
  const publicCandidates = sampleIds.filter((id) => !settings.skipPrivate ||
    summary(newPlayer(id, 1, settings), sampleSummaries.find((record) => record.steamid === id)).visibility !== "private");
  const observations = settings.depth > 1 ? yield* Effect.forEach(publicCandidates, steam.friends) : [];
  const known = new Set([seed, ...friends.values]);
  let added = 0;
  const publicSamples = observations.filter((r) => r.status === "public");
  for (const observation of publicSamples) {
    for (const id of observation.values) if (!known.has(id)) { known.add(id); added++; }
  }
  const firstLayer = 1 + friends.values.length;
  const estimate = settings.depth === 1 ? firstLayer : firstLayer + (publicSamples.length ? added / publicSamples.length * friends.values.length : 0);
  return {
    seed, available: true, directFriends: friends.values.length, sampleSize: publicSamples.length,
    estimatedNodes: settings.maxNodes > 0 ? Math.min(settings.maxNodes, Math.round(estimate)) : Math.round(estimate), cappedAt: settings.maxNodes,
    note: settings.depth > 2 ? `Samples only the first two levels, not the full depth ${settings.depth}. Private or skipped profiles and overlap limit coverage.` : "Sampling estimate; private lists and overlapping friends affect coverage.",
  };
});
