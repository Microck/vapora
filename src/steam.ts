import { Context, Duration, Effect, Layer, Schedule, Schema, Semaphore } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { AppId, Availability, Bans, Player, SteamId } from "./model.js";

export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  message: Schema.String, status: Schema.Number, retryable: Schema.Boolean, retryAfterMs: Schema.Number,
}) {}
const Summary = Schema.Struct({
  steamid: SteamId, personaname: Schema.optionalKey(Schema.String),
  communityvisibilitystate: Schema.optionalKey(Schema.Number),
  loccountrycode: Schema.optionalKey(Schema.String), locstatecode: Schema.optionalKey(Schema.String),
  loccityid: Schema.optionalKey(Player.fields.city),
});
const Ban = Schema.Struct({ SteamId, VACBanned: Schema.Boolean, NumberOfGameBans: Bans.fields.game, CommunityBanned: Schema.Boolean });
export type Summary = typeof Summary.Type;
export type Ban = typeof Ban.Type;
export interface Observation<T> { readonly status: Availability; readonly values: readonly T[] }

export interface Interface {
  readonly resolve: (vanity: string) => Effect.Effect<SteamId, ApiError>;
  readonly friends: (id: SteamId) => Effect.Effect<Observation<SteamId>, ApiError>;
  readonly summaries: (ids: readonly SteamId[]) => Effect.Effect<readonly Summary[], ApiError>;
  readonly bans: (ids: readonly SteamId[]) => Effect.Effect<readonly Ban[], ApiError>;
  readonly groups: (id: SteamId) => Effect.Effect<Observation<string>, ApiError>;
  readonly games: (id: SteamId) => Effect.Effect<Observation<number>, ApiError>;
}
export class Service extends Context.Service<Service, Interface>()("Vapora/Steam") {}
export interface Options { readonly key: string; readonly requestsPerMinute: number; readonly baseUrl?: string | undefined; readonly retryBaseMs?: number | undefined }

/** Only read-only Steam endpoints are retried. Provider errors never retain credential-bearing URLs. */
export const layer = (options: Options) => Layer.effect(Service, Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const gate = yield* Semaphore.make(1);
  let nextRequest = 0;
  let groupAccessDenied = false;
  const request = Effect.fn("Steam.request")(function* (path: string, parameters: Readonly<Record<string, string>>) {
    const response = yield* gate.withPermit(Effect.gen(function* () {
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      if (nextRequest > now) yield* Effect.sleep(nextRequest - now);
      const start = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      nextRequest = start + 60000 / options.requestsPerMinute;
      const url = new URL(path, options.baseUrl ?? "https://api.steampowered.com");
      url.search = new URLSearchParams({ ...parameters, key: options.key }).toString();
      return yield* client.execute(HttpClientRequest.get(url.toString()).pipe(
        HttpClientRequest.setHeader("user-agent", "OpenAI File Downloader, XaiImageApiFetch/1.0"),
      )).pipe(Effect.timeout("25 seconds"), Effect.mapError(() => new ApiError({
        message: "Steam could not be reached. Retry or resume the saved run.", status: 0, retryable: true, retryAfterMs: 0,
      })));
    }));
    if (response.status >= 400) {
      const retryAfter = response.headers["retry-after"];
      const delay = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : 0;
      return yield* Effect.fail(new ApiError({
        message: response.status === 403 ? "Steam denied access. Check the API key and this endpoint's permissions." : `Steam returned HTTP ${response.status}.`,
        status: response.status, retryable: [408, 429, 500, 502, 503, 504].includes(response.status),
        retryAfterMs: Number.isFinite(delay) ? Math.max(0, Math.min(delay, 300000)) : 0,
      }));
    }
    return yield* response.json.pipe(Effect.timeout("25 seconds"), Effect.mapError((error) => new ApiError({
      message: error._tag === "TimeoutError" ? "Steam's response body timed out. Resume the saved run." : "Steam returned invalid JSON. The run checkpoint is preserved.",
      status: response.status, retryable: error._tag === "TimeoutError", retryAfterMs: 0,
    })));
  });
  const policy = Schedule.exponential(options.retryBaseMs ?? 1000).pipe(
    Schedule.upTo({ times: 3 }), Schedule.setInputType<ApiError>(),
    Schedule.modifyDelay(({ input, duration }) => Effect.succeed(Duration.max(duration, Duration.millis(input.retryAfterMs)))),
  );
  const get = <T>(path: string, parameters: Readonly<Record<string, string>>, schema: Schema.ConstraintDecoder<T>) =>
    request(path, parameters).pipe(
      Effect.retry({ schedule: policy, while: (error) => error.retryable }),
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError((error) => error._tag === "ApiError" ? error : new ApiError({
        message: `Steam returned an unexpected response for ${path}.`, status: 200, retryable: false, retryAfterMs: 0,
      })),
    );
  const unavailable = <T>(effect: Effect.Effect<Observation<T>, ApiError>) => effect.pipe(Effect.catchIf(
    (error) => error.status === 401,
    () => Effect.succeed({ status: "private", values: [] } satisfies Observation<T>),
  ));
  return Service.of({
    resolve: Effect.fn("Steam.resolve")(function* (vanity: string) {
      const payload = yield* get("/ISteamUser/ResolveVanityURL/v1/", { vanityurl: vanity }, Schema.Struct({
        response: Schema.Struct({ success: Schema.Number, steamid: Schema.optionalKey(SteamId) }),
      }));
      if (payload.response.success !== 1 || !payload.response.steamid) return yield* Effect.fail(new ApiError({
        message: "Steam could not resolve that vanity name. Use the profile's SteamID64.", status: 404, retryable: false, retryAfterMs: 0,
      }));
      return payload.response.steamid;
    }),
    summaries: Effect.fn("Steam.summaries")((ids: readonly SteamId[]) => get("/ISteamUser/GetPlayerSummaries/v2/", { steamids: ids.join(",") },
      Schema.Struct({ response: Schema.Struct({ players: Schema.Array(Summary) }) })).pipe(Effect.map((r) => r.response.players))),
    bans: Effect.fn("Steam.bans")((ids: readonly SteamId[]) => get("/ISteamUser/GetPlayerBans/v1/", { steamids: ids.join(",") },
      Schema.Struct({ players: Schema.Array(Ban) })).pipe(Effect.map((r) => r.players))),
    friends: Effect.fn("Steam.friends")((id: SteamId) => unavailable(get("/ISteamUser/GetFriendList/v1/", { steamid: id, relationship: "friend" },
      Schema.Struct({ friendslist: Schema.Struct({ friends: Schema.Array(Schema.Struct({ steamid: SteamId })) }) })).pipe(
      Effect.map((r) => ({ status: "public", values: [...new Set(r.friendslist.friends.map((f) => f.steamid))] } satisfies Observation<SteamId>)),
    ))),
    groups: Effect.fn("Steam.groups")(function* (id: SteamId) {
      if (groupAccessDenied) return { status: "unavailable", values: [] } satisfies Observation<string>;
      return yield* unavailable(get("/ISteamUser/GetUserGroupList/v1/", { steamid: id }, Schema.Struct({ response: Schema.Struct({
        success: Schema.optionalKey(Schema.Boolean), groups: Schema.optionalKey(Schema.Array(Schema.Struct({ gid: Schema.String }))),
      }) })).pipe(Effect.map((r) => ({
        status: r.response.success === false ? "unavailable" : "public", values: (r.response.groups ?? []).map((g) => g.gid),
      } satisfies Observation<string>)), Effect.catchIf((error) => error.status === 403, () => Effect.sync(() => {
        groupAccessDenied = true;
        return { status: "unavailable", values: [] } satisfies Observation<string>;
      }))));
    }),
    games: Effect.fn("Steam.games")((id: SteamId) => unavailable(get("/IPlayerService/GetOwnedGames/v1/", {
      input_json: JSON.stringify({ steamid: id, include_appinfo: false, include_played_free_games: true }),
    }, Schema.Struct({ response: Schema.Struct({ game_count: Schema.optionalKey(Schema.Number), games: Schema.optionalKey(Schema.Array(Schema.Struct({ appid: AppId }))) }) })).pipe(
      Effect.map((r) => ({ status: r.response.game_count === undefined ? "private" : "public", values: (r.response.games ?? []).map((g) => g.appid) } satisfies Observation<number>)),
    ))),
  });
})).pipe(Layer.provide(FetchHttpClient.layer));
