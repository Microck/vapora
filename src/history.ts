import { Effect, Schema } from "effect";
import { InputError, SteamId } from "./model.js";

const timestamp = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 4102444800 }));
const HistoricFriend = Schema.Struct({
  Friend: SteamId, FriendDate: timestamp,
  UnfriendDate: Schema.optionalKey(timestamp), Name: Schema.optionalKey(Schema.String),
});
export const Profile = Schema.Struct({
  steamID64: SteamId,
  name: Schema.optionalKey(Schema.String),
  lastChecked: timestamp,
  communityURL: Schema.optionalKey(Schema.String),
  avatarHash: Schema.optionalKey(Schema.String),
  creationDate: Schema.optionalKey(timestamp),
  historic: Schema.Struct({
    friends: Schema.Array(HistoricFriend),
    persona: Schema.optionalKey(Schema.Array(Schema.Json)),
    url: Schema.optionalKey(Schema.Array(Schema.Json)),
    pfp: Schema.optionalKey(Schema.Array(Schema.Json)),
    comments: Schema.optionalKey(Schema.Array(Schema.Json)),
  }),
});
export interface Profile extends Schema.Schema.Type<typeof Profile> {}
export interface DurationRank { readonly id: SteamId; readonly name: string; readonly durationSeconds: number; readonly relativeDuration: number; readonly currentlyFriends: boolean }
export interface HistoryReport { readonly profile: Profile; readonly friends: readonly DurationRank[]; readonly warning: string }
export const HistoryReport = Schema.Struct({
  profile: Profile, warning: Schema.String, friends: Schema.Array(Schema.Struct({
    id: SteamId, name: Schema.String, durationSeconds: Schema.Number, relativeDuration: Schema.Number, currentlyFriends: Schema.Boolean,
  })),
});

/** NDJSON contains normalized profile snapshots, not arbitrary events or scraped HTML. */
export const parse = Effect.fn("History.parse")(function* (contents: string) {
  const json = Schema.fromJsonString(Profile);
  const whole = yield* Schema.decodeUnknownEffect(json)(contents).pipe(Effect.result);
  if (whole._tag === "Success") return whole.success;
  const lines = contents.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return yield* Effect.fail(new InputError({ message: "Import normalized SteamHistory JSON with steamID64, lastChecked, and historic.friends." }));
  const profiles = yield* Effect.forEach(lines, (line) => Schema.decodeUnknownEffect(json)(line).pipe(
    Effect.mapError(() => new InputError({ message: "Each NDJSON line must be a normalized SteamHistory profile snapshot." })),
  ));
  const latest = [...profiles].sort((a, b) => b.lastChecked - a.lastChecked)[0];
  if (!latest || profiles.some((p) => p.steamID64 !== latest.steamID64)) return yield* Effect.fail(new InputError({ message: "Import snapshots of one Steam account at a time." }));
  return latest;
});

export const analyze = Effect.fn("History.analyze")(function* (profile: Profile) {
  const periods = new Map<SteamId, { name: string; current: boolean; intervals: [number, number][] }>();
  for (const friend of profile.historic.friends) {
    const end = friend.UnfriendDate || profile.lastChecked;
    if (friend.Friend === profile.steamID64 || friend.FriendDate === 0 || friend.FriendDate > end || end > profile.lastChecked) {
      return yield* Effect.fail(new InputError({ message: "History contains a self-friend, missing start date, or inconsistent friendship timestamps." }));
    }
    const previous = periods.get(friend.Friend) ?? { name: friend.Name ?? friend.Friend, current: false, intervals: [] };
    previous.intervals.push([friend.FriendDate, end]);
    previous.current ||= !friend.UnfriendDate;
    if (friend.Name) previous.name = friend.Name;
    periods.set(friend.Friend, previous);
  }
  const durations = [...periods].map(([id, record]) => {
    const intervals = record.intervals.sort((a, b) => a[0] - b[0]);
    let start = 0; let end = 0; let seconds = 0;
    for (const interval of intervals) {
      if (interval[0] > end) { seconds += end - start; start = interval[0]; end = interval[1]; }
      else end = Math.max(end, interval[1]);
    }
    seconds += end - start;
    return { id, name: record.name, durationSeconds: seconds, currentlyFriends: record.current };
  }).sort((a, b) => b.durationSeconds - a.durationSeconds || a.id.localeCompare(b.id));
  const maximum = durations[0]?.durationSeconds ?? 0;
  return {
    profile, friends: durations.map((friend) => ({ ...friend, relativeDuration: maximum ? friend.durationSeconds / maximum * 100 : 0 })),
    warning: "Duration measures the supplied history, not closeness or real-life friendship. Overlapping periods count once.",
  } satisfies HistoryReport;
});
