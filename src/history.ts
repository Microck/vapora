import { Effect, Schema } from "effect";
import { InputError, SteamId, defaults } from "./model.js";
import type { Scan, Ranking } from "./model.js";
import * as Scoring from "./scoring.js";

const Record = Schema.Record(Schema.String, Schema.Json);
export type Record = typeof Record.Type;
const timestamp = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 4102444800 }));
export const Profile = Schema.Struct({
  steamID64: SteamId, name: Schema.String, lastChecked: Schema.NullOr(timestamp), fields: Record,
  historic: Schema.Record(Schema.String, Schema.Array(Record)),
});
export interface Profile extends Schema.Schema.Type<typeof Profile> {}
export const Section = Schema.Literals(["persona", "realName", "url", "pfp", "comments", "friends"]);
export type Section = typeof Section.Type;
export const Coverage = Schema.Struct({ section: Section, captured: Schema.Number, total: Schema.NullOr(Schema.Number),
  expected: Schema.NullOr(Schema.Number), status: Schema.Literals(["complete", "partial", "unavailable"]), error: Schema.NullOr(Schema.String) });
export interface Coverage extends Schema.Schema.Type<typeof Coverage> {}
export const Endpoint = Schema.Struct({ path: Schema.String, contents: Schema.String });
export const Page = Schema.Struct({ section: Section, filter: Schema.Literals(["all", "deleted"]), response: Endpoint });
export const Document = Schema.Struct({ type: Schema.Literal("SteamHistoryCapture"), steamID64: SteamId, capturedAt: Schema.String,
  profile: Endpoint, pages: Schema.Array(Page), coverage: Schema.Array(Coverage) });
export interface Document extends Schema.Schema.Type<typeof Document> {}
const Capture = Schema.Struct({ provider: Schema.Literal("SteamHistory"), capturedAt: Schema.String, contents: Schema.String,
  snapshots: Schema.Array(Profile), coverage: Schema.Array(Coverage) });
export const Bundle = Schema.Struct({ sources: Schema.Array(Capture) });
export interface Bundle extends Schema.Schema.Type<typeof Bundle> {}
/** Repeated imports reuse their exact source; every distinct capture remains retained. */
export function merge(...bundles: readonly Bundle[]): Bundle {
  const known = new Set<string>();
  return { sources: bundles.flatMap((bundle) => bundle.sources).filter((source) => {
    if (known.has(source.contents)) return false;
    known.add(source.contents); return true;
  }) };
}
const Membership = Schema.Literals(["current", "former", "other", "unknown"]);
const DurationRank = Schema.Struct({
  id: SteamId, name: Schema.String, avatar: Schema.NullOr(Schema.String), durationSeconds: Schema.NullOr(Schema.Number),
  relativeDuration: Schema.NullOr(Schema.Number), status: Membership, asOf: Schema.NullOr(Schema.Number),
  periods: Schema.Array(Record), periodSources: Schema.Array(Schema.Struct({ record: Record, asOf: Schema.NullOr(timestamp) })), conflicts: Schema.Array(Schema.String), metadata: Record,
});
const Comment = Schema.Struct({
  key: Schema.String, author: Schema.NullOr(SteamId), timestamp: Schema.NullOr(timestamp), message: Schema.String,
  friendAtComment: Schema.Literals(["yes", "unknown"]),
  estimated: Schema.Boolean, occurrences: Schema.Number, versions: Schema.Array(Schema.Struct({ record: Record, sourceAsOf: Schema.NullOr(timestamp), capturedAt: Schema.String })),
});
const CommentRank = Schema.Struct({
  id: Schema.NullOr(SteamId), name: Schema.String, avatar: Schema.NullOr(Schema.String), count: Schema.Number,
  latest: Schema.NullOr(timestamp), status: Membership, asOf: Schema.NullOr(timestamp), share: Schema.Number,
  index: Schema.NullOr(Schema.Number), inReference: Schema.Boolean,
});
export const HistoryReport = Schema.Struct({
  profile: Profile, sources: Bundle.fields.sources, warning: Schema.String, warnings: Schema.Array(Schema.String),
  friends: Schema.Array(DurationRank), comments: Schema.Array(Comment), commenters: Schema.Array(CommentRank),
  locations: Schema.Array(Scoring.LocationSignal), locationCoverage: Scoring.LocationCoverage, referenceSize: Schema.Number,
});
export interface HistoryReport extends Schema.Schema.Type<typeof HistoryReport> {}
export const HistoryState = Schema.Struct({
  id: SteamId, status: Schema.Literals(["ready", "partial", "unavailable"]), error: Schema.NullOr(Schema.String), report: Schema.NullOr(HistoryReport),
});
export interface HistoryState extends Schema.Schema.Type<typeof HistoryState> {}
const captureTime = (capturedAt: string) => {
  const parsed = Date.parse(capturedAt);
  return Number.isNaN(parsed) ? -Infinity : parsed;
};
export function coverageError(bundle: Bundle): string | null {
  let latest: Bundle["sources"][number] | undefined; let latestDate = -Infinity;
  for (const source of bundle.sources) {
    if (!source.coverage.length) continue;
    const date = captureTime(source.capturedAt);
    if (!latest || date > latestDate) { latest = source; latestDate = date; }
  }
  const issues = latest?.coverage.flatMap((section) => section.error ? [section.error] : []) ?? [];
  return issues.length ? issues.join("\n") : null;
}

const text = (value: typeof Schema.Json.Type | undefined) => Schema.is(Schema.String)(value) ? value : null;
const time = (value: typeof Schema.Json.Type | undefined) => Schema.is(timestamp)(value) ? value : null;
const sid = (value: typeof Schema.Json.Type | undefined) => Schema.is(SteamId)(value) ? value : null;
const records = (value: typeof Schema.Json.Type | undefined): Record[] => {
  const decoded = Schema.decodeUnknownResult(Schema.Array(Schema.NullOr(Record)))(value);
  return decoded._tag === "Success" ? decoded.success.filter((row) => row !== null) : [];
};
const object = (value: typeof Schema.Json.Type | undefined) => Schema.is(Record)(value) ? value : null;
const hashAvatar = (hash: string | null) => hash && /^[a-f0-9]{40}$/i.test(hash) ? `https://avatars.steamstatic.com/${hash}_full.jpg` : null;
export function avatar(record: Record): string | null { return hashAvatar(text(record.AvatarHash) ?? text(record.avatarHash)); }
/** The provider uses numeric and string identifiers; both denote the same comment. */
export function commentId(record: Record): string | null {
  for (const value of [record.CommentID, record.ID]) {
    if (Schema.is(Schema.Number)(value)) {
      if (!Number.isSafeInteger(value)) throw new InputError({ message: "A numeric comment ID cannot be represented exactly. Supply comment IDs as JSON strings." });
      return String(value);
    }
    if (Schema.is(Schema.String)(value) && value.length) return value;
  }
  return null;
}

/** A devalue object/array contains references; a primitive in the value pool is already a value, even if small. */
function unflatten(pool: readonly typeof Schema.Json.Type[], chunks: ReadonlyMap<number, readonly typeof Schema.Json.Type[]>, activeChunks = new Set<number>()): typeof Schema.Json.Type {
  const active = new Set<number>(); const resolved = new Map<number, typeof Schema.Json.Type>();
  const ref = (index: typeof Schema.Json.Type): typeof Schema.Json.Type => {
    if (!Schema.is(Schema.Number)(index) || !Number.isInteger(index)) throw new InputError({ message: "SteamHistory contains an invalid data reference." });
    if (index === -1 || index === -2) return null; // devalue undefined and array hole
    if (index < 0 || index >= pool.length) throw new InputError({ message: "SteamHistory contains an unsupported data reference." });
    if (resolved.has(index)) return resolved.get(index) ?? null;
    if (active.has(index)) throw new InputError({ message: "SteamHistory contains cyclic data. The original file was not changed." });
    active.add(index);
    const value = pool[index]; let decoded: typeof Schema.Json.Type;
    if (Array.isArray(value)) decoded = array(value);
    else if (Schema.is(Record)(value)) decoded = Object.fromEntries(Object.entries(value).map(([key, field]) => [key, ref(field)]));
    else decoded = value ?? null;
    active.delete(index); resolved.set(index, decoded); return decoded;
  };
  const array = (values: readonly typeof Schema.Json.Type[]): typeof Schema.Json.Type => {
    const tag = text(values[0]);
    if (tag === "Promise") {
      const id = values[1];
      if (!Schema.is(Schema.Number)(id)) throw new InputError({ message: "SteamHistory contains an invalid chunk reference." });
      const chunk = chunks.get(id);
      if (!chunk) throw new InputError({ message: "SteamHistory's stream is incomplete. Save the complete response, including its chunks." });
      if (activeChunks.has(id)) throw new InputError({ message: "SteamHistory contains cyclic stream chunks. The original file was not changed." });
      activeChunks.add(id);
      const decoded = unflatten(chunk, chunks, activeChunks); activeChunks.delete(id); return decoded;
    }
    if (tag === "Date" || tag === "BigInt") return { type: tag, value: values[1] ?? null };
    if (tag === "Set") return values.slice(1).map(ref);
    if (tag === "Map") return { type: tag, entries: values.slice(1).map(ref) };
    if (tag) throw new InputError({ message: `SteamHistory returned an unsupported data type: ${tag}. Original input remains unchanged.` });
    return values.map(ref);
  };
  return ref(0);
}
function streamValues(lines: readonly typeof Schema.Json.Type[]): typeof Schema.Json.Type[] {
  const chunks = new Map<number, readonly typeof Schema.Json.Type[]>();
  for (const line of lines) {
    const row = object(line);
    if (row?.type === "chunk" && Schema.is(Schema.Number)(row.id) && Schema.is(Schema.Array(Schema.Json))(row.data)) chunks.set(row.id, row.data);
  }
  return lines.flatMap((line) => {
    const row = object(line);
    if (row?.type !== "data") return [];
    return records(row.nodes).filter((node) => node.type === "data" && Schema.is(Schema.Array(Schema.Json))(node.data))
      .map((node) => unflatten(Schema.decodeUnknownSync(Schema.Array(Schema.Json))(node.data), chunks));
  });
}
function streamProfiles(lines: readonly typeof Schema.Json.Type[]): Record[] {
  const found: Record[] = [];
  const visit = (value: typeof Schema.Json.Type) => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    const row = object(value); if (!row) return;
    if (sid(row.steamID64) && object(row.historic)) { found.push(row); return; }
    for (const item of Object.values(row)) visit(item);
  };
  for (const value of streamValues(lines)) visit(value);
  return found;
}
/** The current route supplies userdata; history is collected from separate endpoints. */
export function summary(contents: string): Record {
  const lines = contents.split(/\r?\n/).filter((line) => line.trim()).map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(line));
  for (const value of streamValues(lines)) {
    const route = object(value); const profile = object(route?.userdata);
    if (profile && sid(profile.steamID64)) {
      const { userdata: _userdata, ...metadata } = route ?? {};
      return { ...profile, steamHistoryRoute: metadata };
    }
  }
  throw new InputError({ message: "SteamHistory did not return a supported account profile." });
}
export const PageResponse = Schema.Struct({ data: Schema.Array(Record), total: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)) });
function documentProfile(document: Document): Profile {
  const profile = summary(document.profile.contents);
  if (profile.steamID64 !== document.steamID64) throw new InputError({ message: "SteamHistory returned another account. Nothing was saved." });
  const historic: { [key: string]: Record[] } = {};
  for (const page of document.pages) {
    const prefix = `/id/${document.steamID64}/history?`;
    if (!page.response.path.startsWith(prefix)) throw new InputError({ message: "The history capture contains another account's endpoint." });
    const response = Schema.decodeUnknownSync(Schema.fromJsonString(PageResponse))(page.response.contents);
    const rows = historic[page.section] ?? []; rows.push(...response.data); historic[page.section] = rows;
  }
  return normalize({ ...profile, historic });
}
function normalize(record: Record): Profile {
  const id = sid(record.steamID64); const historic = object(record.historic);
  if (!id || !historic) throw new InputError({ message: "Import a SteamHistory profile with steamID64 and historic records." });
  const history: { [key: string]: readonly Record[] } = {};
  for (const [key, value] of Object.entries(historic)) {
    if (Schema.is(Schema.Array(Record))(value)) history[key] = value;
    else if (Schema.is(Section)(key)) throw new InputError({ message: `History section ${key} must contain records. The original file was not changed.` });
    // Unknown metadata remains in fields and the original bytes, outside the interpreted record lists.
  }
  for (const comment of history.comments ?? []) commentId(comment);
  for (const key of ["lastChecked", "lastUpdated"]) {
    const value = record[key];
    if (value !== undefined && value !== null && !Schema.is(timestamp)(value)) throw new InputError({ message: `History ${key} must be integer Unix seconds from 0 through 4102444800, or null when unknown. The original file was not changed.` });
  }
  return { steamID64: id, name: text(record.name) ?? id, lastChecked: time(record.lastChecked) ?? time(record.lastUpdated), fields: record, historic: history };
}
/** Preserve the exact input and every snapshot; normalization is a projection, never a replacement of source bytes. */
export const parse = Effect.fn("History.parse")(function* (contents: string) {
  return yield* Effect.try({ try: () => {
    const json = Schema.fromJsonString(Schema.Json);
    let lines: typeof Schema.Json.Type[];
    const whole = Schema.decodeUnknownResult(json)(contents.trim());
    if (whole._tag === "Success") lines = [whole.success];
    else lines = contents.split(/\r?\n/).filter((line) => line.trim()).map((line) => Schema.decodeUnknownSync(json)(line.trim()));
    const document = lines.length === 1 && object(lines[0])?.type === "SteamHistoryCapture"
      ? Schema.decodeUnknownSync(Document)(lines[0]) : null;
    if (document) return { sources: [{ provider: "SteamHistory", capturedAt: document.capturedAt, contents,
      snapshots: [documentProfile(document)], coverage: document.coverage }] } satisfies Bundle;
    const profiles = lines.some((line) => object(line)?.type === "data") ? streamProfiles(lines)
      : lines.map((line) => { const record = object(line); if (!record) throw new InputError({ message: "History must contain profile objects." }); return record; });
    if (!profiles.length) throw new InputError({ message: "No profile was found in this SteamHistory response." });
    const snapshots = profiles.map(normalize);
    if (snapshots.some((profile) => profile.steamID64 !== snapshots[0]?.steamID64)) throw new InputError({ message: "Import snapshots of one Steam account at a time." });
    return { sources: [{ provider: "SteamHistory", capturedAt: new Date().toISOString(), contents, snapshots, coverage: [] }] } satisfies Bundle;
  }, catch: (error) => error instanceof InputError ? error : new InputError({ message: "The history file is not valid JSON or a complete SteamHistory data stream." }) });
});

export interface Filter { readonly from?: number | undefined; readonly to?: number | undefined }
const inRange = (timestamp: number | null, range: Filter) => (range.from === undefined && range.to === undefined) ||
  (timestamp !== null && timestamp >= (range.from ?? 0) && timestamp <= (range.to ?? Infinity));

interface FriendshipVersion { readonly record: Record; readonly capturedAt: number }
function friendshipVersions(bundle: Bundle) {
  const friends = new Map<SteamId, Map<number | null, FriendshipVersion[]>>();
  for (const capture of bundle.sources) {
    const capturedAt = captureTime(capture.capturedAt);
    for (const snapshot of capture.snapshots) {
      for (const row of snapshot.historic.friends ?? []) {
        const id = sid(row.Friend); if (!id || id === snapshot.steamID64) continue;
        const versions = friends.get(id) ?? new Map<number | null, FriendshipVersion[]>();
        const rows = versions.get(snapshot.lastChecked) ?? []; rows.push({ record: row, capturedAt });
        versions.set(snapshot.lastChecked, rows); friends.set(id, versions);
      }
    }
  }
  return friends;
}
function friendshipRecords(versions: ReadonlyMap<number | null, readonly FriendshipVersion[]>) {
  const ordered = [...versions].sort((a, b) => (b[0] ?? -1) - (a[0] ?? -1));
  let metadata: FriendshipVersion | undefined;
  for (const version of ordered[0]?.[1] ?? []) {
    if (!metadata || version.capturedAt > metadata.capturedAt) metadata = version;
  }
  const resolved = new Map<number | null, { record: Record; asOf: number | null }[]>();
  for (const [asOf, rows] of ordered) {
    const starts = new Map<number | null, { record: Record; asOf: number | null }[]>();
    for (const { record } of rows) {
      const start = time(record.FriendDate); const periods = starts.get(start) ?? [];
      periods.push({ record, asOf }); starts.set(start, periods);
    }
    for (const [start, periods] of starts) if (!resolved.has(start)) resolved.set(start, periods);
  }
  const periodSources = [...resolved.values()].flat();
  return { asOf: ordered[0]?.[0] ?? null, periods: periodSources.map((entry) => entry.record), periodSources, metadata: metadata?.record ?? {} };
}
const openPeriod = (row: Record) => row.UnfriendDate === undefined || row.UnfriendDate === null || row.UnfriendDate === 0;
function membership(periods: readonly Record[], asOf: number | null) {
  if (asOf === null || !periods.length) return "unknown" as const;
  const starts = periods.map((row) => time(row.FriendDate)).filter((date) => date !== null);
  const latest = starts.length ? Math.max(...starts) : null;
  const endings = new Set(periods.filter((row) => time(row.FriendDate) === latest).map((row) => openPeriod(row) ? null : time(row.UnfriendDate) ?? undefined));
  if (latest === null || latest > asOf || endings.size !== 1 || endings.has(undefined)) return "unknown" as const;
  const end = [...endings][0];
  return end === null ? "current" as const : end !== undefined && end >= latest && end <= asOf ? "former" as const : "unknown" as const;
}
function unionDuration(periods: readonly { record: Record; asOf: number | null }[], range: Filter) {
  const intervals: [number, number][] = []; const conflicts: string[] = [];
  for (const { record: row, asOf: observed } of periods) {
    if (observed === null) { conflicts.push("Source date unavailable"); continue; }
    const start = time(row.FriendDate); const end = openPeriod(row) ? observed : time(row.UnfriendDate);
    if (!start || end === null || start > end || end > observed) { conflicts.push("Missing or inconsistent friendship dates"); continue; }
    const clippedStart = Math.max(start, range.from ?? 0); const clippedEnd = Math.min(end, range.to ?? observed);
    if (clippedStart <= clippedEnd) intervals.push([clippedStart, clippedEnd]);
  }
  intervals.sort((a, b) => a[0] - b[0]); let seconds = 0; let end = 0;
  for (const [start, stop] of intervals) { seconds += Math.max(0, stop - Math.max(start, end)); end = Math.max(end, stop); }
  return { seconds: conflicts.length ? null : seconds, conflicts };
}
function friends(bundle: Bundle, scan: Scan | undefined, range: Filter) {
  const versions = friendshipVersions(bundle);
  const live = scan?.players.find((player) => player.id === scan.seed);
  const seed = live?.friendsObservedAt ? live : undefined;
  const liveAsOf = seed?.friendsObservedAt ? Math.floor(Date.parse(seed.friendsObservedAt) / 1000) : null;
  const result = [...versions].map(([id, records]) => {
    const { periods, asOf, periodSources, metadata } = friendshipRecords(records);
    // Latest source resolves closures before intervals are unioned. No OR of old open flags.
    const historicalStatus = membership(periods, asOf);
    const livePresence = seed?.friends.includes(id) ?? false;
    const liveAuthority = liveAsOf !== null && liveAsOf >= (asOf ?? -1) && (livePresence || seed?.friendsStatus === "public");
    const liveStatus = livePresence ? "current" as const : "former" as const;
    const contradiction = liveAuthority && liveAsOf === asOf && historicalStatus !== "unknown" && historicalStatus !== liveStatus;
    const status = contradiction ? "unknown" as const : liveAuthority ? liveStatus : historicalStatus;
    const duration = unionDuration(periodSources, range);
    if (historicalStatus === "unknown") duration.conflicts.push("Historical membership unresolved");
    if (contradiction) duration.conflicts.push("Same-date membership observations disagree");
    return { id, name: text(metadata.Name) ?? id, avatar: avatar(metadata), durationSeconds: duration.conflicts.length ? null : duration.seconds,
      relativeDuration: null, status, asOf: liveAuthority ? liveAsOf : asOf,
      periods, periodSources, conflicts: duration.conflicts, metadata };
  });
  const maximum = Math.max(0, ...result.map((friend) => friend.durationSeconds ?? 0));
  return result.map((friend) => ({ ...friend, relativeDuration: friend.durationSeconds === null ? null : maximum ? friend.durationSeconds / maximum * 100 : 0 }))
    .sort((a, b) => (b.durationSeconds ?? -1) - (a.durationSeconds ?? -1) || a.id.localeCompare(b.id));
}
function comments(bundle: Bundle): Omit<typeof Comment.Type, "friendAtComment">[] {
  const all = new Map<string, { author: SteamId | null; timestamp: number | null; message: string; estimated: boolean; occurrences: number; versions: { record: Record; sourceAsOf: number | null; capturedAt: string }[]; selectedDate: number; selectedCapturedAt: number; perCapture: Map<string, number> }>();
  bundle.sources.forEach((capture, captureIndex) => {
    const captureDate = captureTime(capture.capturedAt);
    capture.snapshots.forEach((profile, snapshotIndex) => { for (const row of profile.historic.comments ?? []) {
      const author = sid(row.Commenter); const timestamp = time(row.Timestamp); const message = text(row.Message) ?? "";
      const identity = commentId(row);
      const key = JSON.stringify([capture.provider, profile.steamID64, identity ? ["id", identity] : ["anonymous", author, timestamp, message]]);
      const previous: NonNullable<ReturnType<typeof all.get>> = all.get(key) ?? { author, timestamp, message, estimated: !identity, occurrences: 0, versions: [], selectedDate: -1, selectedCapturedAt: -Infinity, perCapture: new Map<string, number>() };
      previous.versions.push({ record: row, sourceAsOf: profile.lastChecked, capturedAt: capture.capturedAt }); previous.occurrences++; const captureKey = `${captureIndex}:${snapshotIndex}`;
      previous.perCapture.set(captureKey, (previous.perCapture.get(captureKey) ?? 0) + 1);
      // Display the newest captured version, retaining every old version for inspection.
      const sourceDate = profile.lastChecked ?? -1;
      if (sourceDate > previous.selectedDate || sourceDate === previous.selectedDate && captureDate >= previous.selectedCapturedAt) {
        previous.author = author; previous.timestamp = timestamp; previous.message = message; previous.selectedDate = sourceDate; previous.selectedCapturedAt = captureDate;
      }
      all.set(key, previous);
    } });
  });
  return [...all].flatMap(([key, record]) => {
    const { perCapture, selectedDate: _selectedDate, selectedCapturedAt: _selectedCapturedAt, ...comment } = record;
    const count = comment.estimated ? Math.max(...perCapture.values()) : 1;
    return Array.from({ length: count }, (_, index) => ({ ...comment, key: `${key}:${index}` }));
  });
}
/** Display filters never define a scoring population. Date filtering happens before the reference is formed. */
export function view(bundle: Bundle, scan?: Scan, range: Filter = {}, settings: Ranking = scan?.settings ?? defaults): HistoryReport {
  const profiles = bundle.sources.flatMap((source) => {
    const capturedAt = captureTime(source.capturedAt);
    return source.snapshots.map((profile) => ({ profile, capturedAt }));
  });
  const profile = profiles.sort((a, b) => (b.profile.lastChecked ?? -1) - (a.profile.lastChecked ?? -1) || b.capturedAt - a.capturedAt)[0]?.profile;
  if (!profile) throw new InputError({ message: "History has no profile captures." });
  if (scan && scan.seed !== profile.steamID64) throw new InputError({ message: "History belongs to another Steam account." });
  const historicalFriends = friends(bundle, scan, range); const friendsById = new Map(historicalFriends.map((friend) => [friend.id, friend]));
  const captured = comments(bundle).filter((comment) => inRange(comment.timestamp, range)).map((comment) => {
    const friend = comment.author === null ? undefined : friendsById.get(comment.author);
    const eventTime = comment.timestamp;
    const present = eventTime !== null && friend?.periodSources.some(({ record, asOf }) => {
      const start = time(record.FriendDate); const end = openPeriod(record) ? asOf : time(record.UnfriendDate);
      return start !== null && start > 0 && end !== null && start <= eventTime && eventTime < end;
    });
    return { ...comment, friendAtComment: present ? "yes" as const : "unknown" as const };
  });
  const authors = new Map<SteamId | null, { count: number; latest: number | null }>();
  for (const comment of captured) {
    const author = authors.get(comment.author) ?? { count: 0, latest: null };
    author.count++; if (comment.timestamp !== null) author.latest = Math.max(author.latest ?? 0, comment.timestamp); authors.set(comment.author, author);
  }
  const referenceIds = new Set(friendsById.keys());
  const population = [...authors].filter(([id]) => id !== null && referenceIds.has(id)).map(([, author]) => author.count);
  const index = Scoring.countIndex(population, settings.topN, settings.countBaseline);
  const live = scan?.players.find((player) => player.id === scan.seed);
  const liveSeed = live?.friendsObservedAt ? live : undefined;
  const liveAsOf = liveSeed?.friendsObservedAt ? Math.floor(Date.parse(liveSeed.friendsObservedAt) / 1000) : null;
  const commenters = [...authors].map(([id, author]) => {
    const friend = id === null ? undefined : friendsById.get(id);
    const inReference = id !== null && referenceIds.has(id);
    const status = id === null ? "unknown" as const : friend?.status ?? (liveSeed?.friends.includes(id) ? "current" as const : "other" as const);
    return { id, name: friend?.name ?? id ?? "Unknown author", avatar: friend?.avatar ?? null, ...author,
      status, asOf: friend ? friend.asOf : status === "current" ? liveAsOf : null, share: captured.length ? author.count / captured.length * 100 : 0,
      index: inReference ? index(author.count) : null, inReference };
  }).sort((a, b) => b.count - a.count || (b.latest ?? -1) - (a.latest ?? -1) || (a.id ?? "").localeCompare(b.id ?? ""));
  const locationContributors = commenters.filter((author) => author.inReference && author.id !== null).map((author) => {
    const metadata = author.id ? friendsById.get(author.id)?.metadata : undefined;
    return { country: text(metadata?.countryCode), state: text(metadata?.stateCode), city: time(metadata?.cityID), count: author.count };
  });
  const located = locationContributors.filter((record) => record.country && record.city !== null).length;
  const warnings = historicalFriends.flatMap((friend) => friend.conflicts.map((issue) => `${friend.id}: ${issue}`));
  const coverage = coverageError(bundle); if (coverage) warnings.push(coverage);
  if (profile.lastChecked === null) warnings.push("Source observation date unavailable. Capture time is not an observation date.");
  return { profile, sources: bundle.sources, friends: historicalFriends, comments: captured, commenters,
    locations: Scoring.locations(locationContributors, settings), locationCoverage: { referenceSize: population.length, located, missingLocation: population.length - located, uncollected: 0 }, referenceSize: population.length, warnings,
    warning: "Captured history only. Counts are estimated from supplied captures; friendship and location indices are not probabilities." };
}
export const analyze = Effect.fn("History.analyze")((bundle: Bundle) => Effect.try({ try: () => view(bundle),
  catch: (error) => error instanceof InputError ? error : new InputError({ message: "History analysis failed. Check the supplied records." }) }));

/** Fixed account endpoint only. A challenge or provider failure is visible and never replaced with invented data. */
