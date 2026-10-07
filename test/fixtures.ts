import { createServer } from "node:http";
import { once } from "node:events";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { OpenSession } from "../src/history-provider.js";
import { InputError } from "../src/model.js";
import { SteamId, newPlayer, defaults } from "../src/model.js";
import type { Player, Scan, Settings } from "../src/model.js";
import type * as Steam from "../src/steam.js";
import * as Storage from "../src/storage.js";

export const seed = Schema.decodeUnknownSync(SteamId)("76561197960265729");
export const second = Schema.decodeUnknownSync(SteamId)("76561197960265730");
export const third = Schema.decodeUnknownSync(SteamId)("76561197960265731");
export const fourth = Schema.decodeUnknownSync(SteamId)("76561197960265732");
export const fifth = Schema.decodeUnknownSync(SteamId)("76561197960265733");
export const key = "a".repeat(32);
export const userAgent = "OpenAI File Downloader, XaiImageApiFetch/1.0";
export function player(id: SteamId, friends: readonly SteamId[], extra: Partial<Player> = {}): Player {
  return { ...newPlayer(id, id === seed ? 0 : 1, defaults), name: `Player ${id.slice(-2)}`, visibility: "public", friendsStatus: "public", friends,
    bans: { vac: false, vacCount: 0, game: 0, community: false }, bansStatus: "public", friendsObservedAt: new Date().toISOString(), bansObservedAt: new Date().toISOString(), ...extra };
}
export function scan(players: readonly Player[], settings: Settings = defaults): Scan {
  return { version: 2, id: Storage.runId(), seed, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: "complete", error: null, settings, players, queue: [], truncated: false };
}

/** Distinct sample profile pictures served by the HTTP fixture, not live Steam accounts. */
export function avatarSvg(id: string): string {
  const pictures = [
    '<rect width="64" height="64" fill="#253445"/><path fill="#d8b667" d="M14 19h10v10h16V19h10v32H14zM24 9h16v14H24z"/><path fill="#253445" d="M29 36h6v15h-6z"/>',
    '<rect width="64" height="64" fill="#49303c"/><path fill="#e6dfcc" d="M20 12h24l9 11v20h-9v9H20v-9h-9V23z"/><path fill="#49303c" d="M18 25h10v11H18zM36 25h10v11H36zM29 38h6v7h-6zM25 47h4v7h-4zM35 47h4v7h-4z"/>',
    '<rect width="64" height="64" fill="#29443d"/><path fill="#a8c49b" d="M13 14h38v24H39v12H25V38H13z"/><path fill="#29443d" d="M19 21h10v10H19zM35 21h10v10H35z"/><path fill="#d9e4c8" d="M27 33h10l-5 8z"/>',
    '<rect width="64" height="64" fill="#292b4b"/><circle cx="33" cy="31" r="16" fill="#bab2dc"/><path fill="#696285" d="M30 18h10v5H30zM21 30h8v8h-8zM34 37h11v5H34z"/><path fill="none" stroke="#d6bc8c" stroke-width="4" d="M14 33C0 44 13 52 38 37S65 20 51 23"/>',
  ];
  const picture = pictures[(Number(id.slice(-2)) - 29 + pictures.length) % pictures.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${picture}</svg>`;
}

/** A real HTTP fixture implements Steam's wire formats. No modules or transports are mocked. */
export async function steamFixture() {
  const friends = new Map<SteamId, readonly SteamId[]>([
    [seed, [second, third, fourth]], [second, [seed, third, fifth]], [third, [seed, second]], [fourth, []], [fifth, [second]],
  ]);
  const requests: { path: string; id: string; ids: string; time: number; agent: string }[] = [];
  const failures = new Map<string, { status: number; remaining: number; retryAfter?: string }>();
  const malformed = new Map<string, string>();
  const vacCounts = new Map<SteamId, number>();
  const omittedBans = new Set<SteamId>();
  const omittedAvatars = new Set<string>();
  const privateProfiles = new Set<string>();
  const names = new Map<string, string>();
  const omittedVisibility = new Set<string>();
  const omittedSummaries = new Set<string>();
  const interruptedBodies = new Map<string, number>();
  const held = new Map<string, () => void>();
  const waiters = new Map<string, () => void>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const id = url.searchParams.get("steamid") ?? "";
    requests.push({ path: url.pathname, id, ids: id || url.searchParams.get("steamids") || url.searchParams.get("input_json") || "", time: Date.now(), agent: request.headers["user-agent"] ?? "" });
    const avatar = /^\/avatars\/(\d{17})\.svg$/.exec(url.pathname);
    if (avatar?.[1]) { response.setHeader("content-type", "image/svg+xml"); response.end(avatarSvg(avatar[1])); return; }
    response.setHeader("content-type", "application/json");
    if (url.searchParams.get("key") !== key) { response.writeHead(403); response.end("{}"); return; }
    const failure = failures.get(url.pathname + id);
    if (failure && failure.remaining > 0) {
      failure.remaining--; response.writeHead(failure.status, failure.retryAfter ? { "retry-after": failure.retryAfter } : {}); response.end("{}"); return;
    }
    const invalid = malformed.get(url.pathname);
    if (invalid !== undefined) { response.end(invalid); return; }
    const interruptions = interruptedBodies.get(url.pathname) ?? 0;
    if (interruptions > 0) {
      interruptedBodies.set(url.pathname, interruptions - 1);
      response.writeHead(200); response.write('{"response":');
      setTimeout(() => response.destroy(), 10); return;
    }
    const reply = () => {
      if (url.pathname.includes("ResolveVanityURL")) { response.end(JSON.stringify({ response: { success: 1, steamid: seed } })); return; }
      if (url.pathname.includes("GetFriendList")) {
        if (id === fourth) { response.writeHead(401); response.end("{}"); return; }
        const account = Schema.decodeUnknownSync(SteamId)(id);
        response.end(JSON.stringify({ friendslist: { friends: (friends.get(account) ?? []).map((friend) => ({ steamid: friend })) } })); return;
      }
      if (url.pathname.includes("GetPlayerSummaries")) {
        const ids = (url.searchParams.get("steamids") ?? "").split(",");
        response.end(JSON.stringify({ response: { players: ids.filter((id) => !omittedSummaries.has(id)).map((steamid) => {
          const profile: Steam.Summary = { steamid: Schema.decodeUnknownSync(SteamId)(steamid),
            personaname: names.get(steamid) ?? (steamid === second ? '=HYPERLINK("bad")' : `Player ${steamid.slice(-2)}`),
            loccountrycode: "ES", locstatecode: "56", loccityid: 123 };
          const visible = omittedVisibility.has(steamid) ? profile : { ...profile, communityvisibilitystate: privateProfiles.has(steamid) ? 1 : 3 };
          if (omittedAvatars.has(steamid)) return visible;
          return { ...visible, avatarfull: `http://${request.headers.host}/avatars/${steamid}.svg` };
        }) } })); return;
      }
      if (url.pathname.includes("GetPlayerBans")) {
        const ids = (url.searchParams.get("steamids") ?? "").split(",").map((id) => Schema.decodeUnknownSync(SteamId)(id));
        response.end(JSON.stringify({ players: ids.filter((id) => !omittedBans.has(id)).map((SteamId) => ({ SteamId, VACBanned: (vacCounts.get(SteamId) ?? 0) > 0, NumberOfVACBans: vacCounts.get(SteamId) ?? 0, NumberOfGameBans: 0, CommunityBanned: false })) })); return;
      }
      if (url.pathname.includes("GetUserGroupList")) { response.writeHead(403); response.end("{}"); return; }
      if (url.pathname.includes("GetOwnedGames")) { response.end(JSON.stringify({ response: { game_count: 2, games: [{ appid: 10 }, { appid: 20 }] } })); return; }
      response.writeHead(404); response.end("{}");
    };
    if (held.has(url.pathname + id)) { held.set(url.pathname + id, reply); waiters.get(url.pathname + id)?.(); }
    else reply();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(server.address());
  return {
    url: `http://127.0.0.1:${address.port}`, requests, failures, malformed, vacCounts, omittedBans, omittedAvatars, privateProfiles, names, omittedVisibility, omittedSummaries, interruptedBodies, friends,
    hold: (path: string, id: string) => {
      held.set(path + id, () => {});
      return new Promise<void>((resolve) => waiters.set(path + id, resolve));
    },
    release: (path: string, id: string) => { held.get(path + id)?.(); held.delete(path + id); waiters.delete(path + id); },
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }),
  };
}

/** Exercise the real HTTP fixture without a browser dependency in domain tests. */
export const historyHttpSession = (baseUrl: string): OpenSession => () => Effect.succeed({
  request: Effect.fn("HistoryFixture.request")((path: string) => Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(HttpClientRequest.get(new URL(path, baseUrl).href).pipe(HttpClientRequest.setHeader("user-agent", userAgent)));
    return { status: response.status, contents: yield* response.text };
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.mapError(() => new InputError({ message: "History fixture request failed." })))),
});
/** Flatten the current Svelte wire format, including numeric scalars as pool values. */
export function historyWire(profile: { [key: string]: typeof Schema.Json.Type }): string {
  const pool: typeof Schema.Json.Type[] = [];
  const add = (value: typeof Schema.Json.Type): number => {
    const index = pool.length; pool.push(null);
    pool[index] = Array.isArray(value) ? value.map(add) : Schema.is(Schema.Record(Schema.String, Schema.Json))(value)
      ? Object.fromEntries(Object.entries(value).map(([key, value]) => [key, add(value)])) : value;
    return index;
  };
  add({ userdata: profile, user: null, needsVerification: false, unknownRouteField: "preserved" });
  return JSON.stringify({ type: "data", nodes: [null, null, { type: "data", data: pool }] });
}

/** A separate real provider keeps history requests out of Steam's request accounting. */
export async function historyFixture() {
  const now = 1791360000;
  const document = {
    steamID64: seed, name: "Alice", lastChecked: now, creationDate: 1400000000,
    vacBanned: true, gameBans: 2, economyBanned: "none", customField: { preserved: "original" },
    historic: {
      friends: [
        { Friend: second, Name: "Bob", FriendDate: now - 400000, AvatarHash: "1".repeat(40), countryCode: "ES", stateCode: "56", cityID: 1 },
        { Friend: third, Name: "Carol", FriendDate: now - 200000, UnfriendDate: now - 100000, countryCode: "ES", stateCode: "56", cityID: 1 },
      ],
      persona: [{ Name: "Old Alice", Timestamp: now - 100000 }, { Name: "Alice", Timestamp: now }],
      url: [{ URL: "alice-old", Timestamp: now - 100000 }],
      pfp: [{ AvatarHash: "2".repeat(40), Timestamp: now - 100000 }],
      comments: [
        { ID: "c1", Commenter: second, Message: "A captured comment", Timestamp: now - 100 },
        { ID: "c2", Commenter: third, Message: "Former friend comment", Timestamp: now - 10000 },
        { Commenter: fifth, Message: "Other commenter", Timestamp: now - 50 },
        { Message: "Undated unknown author" },
      ],
    },
  };
  const sections = ["persona", "realName", "url", "pfp", "comments", "friends"];
  const rows = new Map<string, readonly { [key: string]: typeof Schema.Json.Type }[]>(Object.entries(document.historic));
  rows.set("realName", [{ Name: "Alice Example", Timestamp: now - 100000 }]);
  let status = 200; let requests = 0;
  const paths: string[] = []; const failures = new Map<string, number>(); const replies = new Map<string, string>(); const counts = new Map<string, number>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === `/id/${seed}`) { response.setHeader("content-type", "text/html"); response.end("<!doctype html><title>Alice | SteamHistory.net</title><p>Fixture profile</p>"); return; }
    requests++; paths.push(url.pathname + url.search);
    const section = url.pathname.endsWith("/history") ? sections[Number(url.searchParams.get("type"))] ?? "" : "";
    const code = failures.get(section) ?? status;
    response.writeHead(code, { "content-type": "application/json" });
    if (code !== 200) { response.end("provider unavailable"); return; }
    if (url.pathname === `/id/${seed}/__data.json`) {
      const { historic: _historic, ...profile } = document;
      const totalHistoricCounts = Object.fromEntries([...rows].map(([key, records]) => [key, counts.get(key) ?? records.length]));
      response.end(historyWire({ ...profile, totalHistoricCounts })); return;
    }
    if (url.pathname === `/id/${seed}/history`) {
      const override = replies.get(`${section}:${url.searchParams.get("offset")}`);
      if (override !== undefined) { response.end(override); return; }
      const filtered = (rows.get(section) ?? []).filter((row) => url.searchParams.get("commentFilter") !== "deleted" || row.IsDeleted === true);
      const offset = Number(url.searchParams.get("offset")); const limit = Number(url.searchParams.get("limit"));
      response.end(JSON.stringify({ data: filtered.slice(offset, offset + limit), total: filtered.length, customPageField: "preserved" })); return;
    }
    response.end("{}");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(server.address());
  return { url: `http://127.0.0.1:${address.port}`, document, rows, paths, failures, replies, counts, session: historyHttpSession(`http://127.0.0.1:${address.port}`), requests: () => requests,
    setStatus: (value: number) => { status = value; },
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }),
  };
}
