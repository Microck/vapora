import { Schema } from "effect";
import { Scan, SteamId, Availability, RunId, RunStatus, Player } from "./model.js";
import { HistoryReport } from "./history.js";

export const Edge = Schema.Struct({ source: SteamId, target: SteamId, kind: Schema.Literals(["friend", "group"]) });
export interface Edge extends Schema.Schema.Type<typeof Edge> {}
export const Metric = Schema.Struct({ id: SteamId, degree: Schema.Number, betweenness: Schema.Number, community: Schema.Number, hub: Schema.Boolean });
export const FriendRank = Schema.Struct({
  id: SteamId, name: Schema.String, score: Schema.Number, evidenceScore: Schema.Number, mutual: Schema.Number,
  jaccard: Schema.NullOr(Schema.Number), sharedGroups: Schema.NullOr(Schema.Number), sharedGames: Schema.NullOr(Schema.Number), friendsStatus: Availability,
});
export interface FriendRank extends Schema.Schema.Type<typeof FriendRank> {}
export const LocationSignal = Schema.Struct({
  country: Schema.String, state: Schema.NullOr(Schema.String), city: Schema.NullOr(Schema.Number), contributors: Schema.Number, weight: Schema.Number, share: Schema.Number,
});
export interface LocationSignal extends Schema.Schema.Type<typeof LocationSignal> {}
export const Report = Schema.Struct({
  runId: RunId, seed: SteamId, edges: Schema.Array(Edge), metrics: Schema.Array(Metric), friends: Schema.Array(FriendRank), locations: Schema.Array(LocationSignal),
  coverage: Schema.Struct({ nodes: Schema.Number, publicLists: Schema.Number, skippedLists: Schema.Number, unavailableLists: Schema.Number, directFriends: Schema.Number, admittedDirectFriends: Schema.Number, truncated: Schema.Boolean }),
  warnings: Schema.Array(Schema.String),
});
export interface Report extends Schema.Schema.Type<typeof Report> {}
export const Progress = Schema.Struct({ id: RunId, phase: Schema.String, nodes: Schema.Number, scanned: Schema.Number, remaining: Schema.Number });
export interface Progress extends Schema.Schema.Type<typeof Progress> {}
/** operationId identifies one attempt; id identifies its saved run, when one exists. */
export const Job = Schema.Struct({
  operationId: Schema.NullOr(Schema.NonEmptyString),
  status: Schema.Literals(["idle", "running", "complete", "cancelled", "failed"]), id: Schema.NullOr(RunId), error: Schema.NullOr(Schema.String), progress: Schema.NullOr(Progress),
});
export interface Job extends Schema.Schema.Type<typeof Job> {}
export const RunSummary = Schema.Struct({ id: RunId, seed: SteamId, name: Schema.String, avatar: Player.fields.avatar, createdAt: Schema.String, status: RunStatus, nodes: Schema.Number });
export const State = Schema.Struct({
  hasKey: Schema.Boolean, profiles: Schema.Array(Schema.String), runs: Schema.Array(RunSummary), job: Job,
  runIssues: Schema.Array(Schema.Struct({ id: RunId, message: Schema.String })),
});
export interface State extends Schema.Schema.Type<typeof State> {}
export const RunView = Schema.Struct({ scan: Scan, report: Report, history: Schema.NullOr(HistoryReport) });
export interface RunView extends Schema.Schema.Type<typeof RunView> {}
export const Estimate = Schema.Struct({
  seed: SteamId, available: Schema.Boolean, directFriends: Schema.NullOr(Schema.Number), sampleSize: Schema.Number,
  estimatedNodes: Schema.NullOr(Schema.Number), cappedAt: Schema.Number, note: Schema.optionalKey(Schema.String),
});
export const Ok = Schema.Struct({ ok: Schema.Boolean });
export const Failure = Schema.Struct({ error: Schema.String });
