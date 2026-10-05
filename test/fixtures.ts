import { createServer } from "node:http";
import { once } from "node:events";
import { Schema } from "effect";
import { SteamId, newPlayer, defaults } from "../src/model.js";
import type { Player, Scan, Settings } from "../src/model.js";
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

/** A real HTTP fixture implements Steam's wire formats. No modules or transports are mocked. */
export async function steamFixture() {
  const friends = new Map<SteamId, readonly SteamId[]>([
    [seed, [second, third, fourth]], [second, [seed, third, fifth]], [third, [seed, second]], [fourth, []], [fifth, [second]],
  ]);
  const requests: { path: string; id: string; time: number; agent: string }[] = [];
  const failures = new Map<string, { status: number; remaining: number; retryAfter?: string }>();
  const malformed = new Map<string, string>();
  const omittedBans = new Set<SteamId>();
  const held = new Map<string, () => void>();
  const waiters = new Map<string, () => void>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const id = url.searchParams.get("steamid") ?? "";
    requests.push({ path: url.pathname, id, time: Date.now(), agent: request.headers["user-agent"] ?? "" });
    response.setHeader("content-type", "application/json");
    if (url.searchParams.get("key") !== key) { response.writeHead(403); response.end("{}"); return; }
    const failure = failures.get(url.pathname + id);
    if (failure && failure.remaining > 0) {
      failure.remaining--; response.writeHead(failure.status, failure.retryAfter ? { "retry-after": failure.retryAfter } : {}); response.end("{}"); return;
    }
    const invalid = malformed.get(url.pathname);
    if (invalid !== undefined) { response.end(invalid); return; }
    const reply = () => {
      if (url.pathname.includes("ResolveVanityURL")) { response.end(JSON.stringify({ response: { success: 1, steamid: seed } })); return; }
      if (url.pathname.includes("GetFriendList")) {
        if (id === fourth) { response.writeHead(401); response.end("{}"); return; }
        const account = Schema.decodeUnknownSync(SteamId)(id);
        response.end(JSON.stringify({ friendslist: { friends: (friends.get(account) ?? []).map((friend) => ({ steamid: friend })) } })); return;
      }
      if (url.pathname.includes("GetPlayerSummaries")) {
        const ids = (url.searchParams.get("steamids") ?? "").split(",");
        response.end(JSON.stringify({ response: { players: ids.map((steamid) => ({ steamid, personaname: steamid === second ? '=HYPERLINK("bad")' : `Player ${steamid.slice(-2)}`,
          communityvisibilitystate: 3, loccountrycode: "ES", locstatecode: "56", loccityid: 123,
        })) } })); return;
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
    url: `http://127.0.0.1:${address.port}`, requests, failures, malformed, omittedBans, friends,
    hold: (path: string, id: string) => {
      held.set(path + id, () => {});
      return new Promise<void>((resolve) => waiters.set(path + id, resolve));
    },
    release: (path: string, id: string) => { held.get(path + id)?.(); held.delete(path + id); waiters.delete(path + id); },
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }),
  };
}
