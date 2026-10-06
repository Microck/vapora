import { Cause, Schema } from "effect";

export const STEAM_BASE = 76561197960265728n;
export const SteamId = Schema.String.check(
  Schema.isPattern(/^\d{17}$/),
  Schema.makeFilter((id) => BigInt(id) > STEAM_BASE && BigInt(id) <= STEAM_BASE + 4294967295n),
).pipe(Schema.brand("SteamId"));
export type SteamId = typeof SteamId.Type;

const integer = (min: number, max: number) => Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: min, maximum: max }));
const weight = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
export const Settings = Schema.Struct({
  depth: integer(1, 5),
  maxNodes: integer(1, 1000),
  requestsPerMinute: integer(1, 120),
  includeGroups: Schema.Boolean,
  includeGames: Schema.Boolean,
  skipPrivate: Schema.Boolean,
  hubPercentile: Schema.Number.check(Schema.isBetween({ minimum: 0.5, maximum: 1 })),
  weights: Schema.Struct({ mutual: weight, jaccard: weight, groups: weight, games: weight }),
});
export interface Settings extends Schema.Schema.Type<typeof Settings> {}
export const Ranking = Schema.Struct({ hubPercentile: Settings.fields.hubPercentile, weights: Settings.fields.weights });
export interface Ranking extends Schema.Schema.Type<typeof Ranking> {}
export const defaults: Settings = {
  depth: 2, maxNodes: 500, requestsPerMinute: 120, includeGroups: false, includeGames: false, skipPrivate: false,
  hubPercentile: 0.99, weights: { mutual: 1, jaccard: 1, groups: 0.5, games: 0.5 },
};
export const presets = { inner: { ...defaults, depth: 1, maxNodes: 300 }, community: defaults } satisfies Record<string, Settings>;

export const Availability = Schema.Literals(["pending", "public", "private", "unavailable", "disabled", "skipped"]);
export type Availability = typeof Availability.Type;
export const Bans = Schema.Struct({ vac: Schema.Boolean, game: integer(0, 10000), community: Schema.Boolean });
export const AppId = integer(0, 4294967295);
/** Steam avatar URLs are image sources, never executable or inline URLs. */
export const AvatarUrl = Schema.String.check(Schema.isPattern(/^https?:\/\/[^/\s]+(?:\/[^\s]*)?$/));
export const Player = Schema.Struct({
  id: SteamId,
  level: integer(0, 5),
  name: Schema.String,
  avatar: Schema.NullOr(AvatarUrl),
  visibility: Schema.Literals(["pending", "public", "private", "unavailable"]),
  bans: Schema.NullOr(Bans),
  bansStatus: Schema.Literals(["pending", "public", "unavailable", "skipped"]),
  country: Schema.NullOr(Schema.String),
  state: Schema.NullOr(Schema.String),
  city: Schema.NullOr(integer(0, 2147483647)),
  friendsStatus: Availability,
  friends: Schema.Array(SteamId),
  groupsStatus: Availability,
  groups: Schema.Array(Schema.String),
  gamesStatus: Availability,
  games: Schema.Array(AppId),
});
export interface Player extends Schema.Schema.Type<typeof Player> {}
export const RunId = Schema.String.check(Schema.isPattern(/^\d{8}T\d{6}Z-[a-f0-9]{12}$/));
export const RunStatus = Schema.Literals(["running", "cancelled", "failed", "complete"]);
export const Scan = Schema.Struct({
  version: Schema.Literal(2),
  id: RunId,
  seed: SteamId,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  status: RunStatus,
  error: Schema.NullOr(Schema.String),
  settings: Settings,
  players: Schema.Array(Player),
  queue: Schema.Array(SteamId),
  truncated: Schema.Boolean,
});
export interface Scan extends Schema.Schema.Type<typeof Scan> {}
export class InputError extends Schema.TaggedError<InputError>()("InputError", { message: Schema.String }) {}
export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  message: Schema.String, code: Schema.optional(Schema.String), cause: Schema.optional(Schema.Defect()),
}) {}

/** Typed failures carry user-facing text. Diagnostic traces belong in the run log. */
export function failureMessage<E extends { readonly message: string }>(cause: Cause.Cause<E>): string {
  const failure = Cause.findError(cause);
  return failure._tag === "Success" ? failure.success.message : "The scan failed unexpectedly. Restart Vapora and try again.";
}

export function newPlayer(id: SteamId, level: number, settings: Settings): Player {
  return {
    id, level, name: id, avatar: null, visibility: "pending", bans: null, bansStatus: "pending", country: null, state: null, city: null,
    friendsStatus: "pending", friends: [], groupsStatus: settings.includeGroups ? "pending" : "disabled",
    groups: [], gamesStatus: settings.includeGames ? "pending" : "disabled", games: [],
  };
}

export const artifacts = ["scan.json", "analysis.json", "probable-friends.csv", "gephi/nodes.csv", "gephi/edges.csv", "run.log", "history.json"] as const;
export type Artifact = typeof artifacts[number];
