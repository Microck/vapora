import { createServer } from "node:http";
import { once } from "node:events";
import { Schema } from "effect";
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
    bans: { vac: false, game: 0, community: false }, bansStatus: "public", ...extra };
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
  const omittedBans = new Set<SteamId>();
  const omittedAvatars = new Set<string>();
  const privateProfiles = new Set<string>();
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
            personaname: steamid === second ? '=HYPERLINK("bad")' : `Player ${steamid.slice(-2)}`,
            loccountrycode: "ES", locstatecode: "56", loccityid: 123 };
          const visible = omittedVisibility.has(steamid) ? profile : { ...profile, communityvisibilitystate: privateProfiles.has(steamid) ? 1 : 3 };
          if (omittedAvatars.has(steamid)) return visible;
          return { ...visible, avatarfull: `http://${request.headers.host}/avatars/${steamid}.svg` };
        }) } })); return;
      }
      if (url.pathname.includes("GetPlayerBans")) {
        const ids = (url.searchParams.get("steamids") ?? "").split(",").map((id) => Schema.decodeUnknownSync(SteamId)(id));
        response.end(JSON.stringify({ players: ids.filter((id) => !omittedBans.has(id)).map((SteamId) => ({ SteamId, VACBanned: false, NumberOfGameBans: 0, CommunityBanned: false })) })); return;
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
    url: `http://127.0.0.1:${address.port}`, requests, failures, malformed, omittedBans, omittedAvatars, privateProfiles, omittedVisibility, omittedSummaries, interruptedBodies, friends,
    hold: (path: string, id: string) => {
      held.set(path + id, () => {});
      return new Promise<void>((resolve) => waiters.set(path + id, resolve));
    },
    release: (path: string, id: string) => { held.get(path + id)?.(); held.delete(path + id); waiters.delete(path + id); },
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }),
  };
}
