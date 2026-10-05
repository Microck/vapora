import { Effect, Schema } from "effect";
import { InputError, STEAM_BASE, SteamId } from "./model.js";

/** Steam IDs are strings throughout: Number loses precision for SteamID64. */
export const parse = Effect.fn("Identifiers.parse")(function* (input: string) {
  let value = input.trim();
  if (/^(?:https?:\/\/|(?:www\.)?steamcommunity\.com\/)/i.test(value)) {
    const url = yield* Effect.try({
      try: () => new URL(value.includes("://") ? value : `https://${value}`),
      catch: () => new InputError({ message: "Enter a valid Steam community profile URL." }),
    });
    if (!["https:", "http:"].includes(url.protocol) || !["steamcommunity.com", "www.steamcommunity.com"].includes(url.hostname) || url.username || url.password || url.port) {
      return yield* Effect.fail(new InputError({ message: "Only steamcommunity.com profile URLs are accepted." }));
    }
    const match = /^\/(profiles|id)\/([^/]+)\/?$/.exec(url.pathname);
    if (!match?.[2]) return yield* Effect.fail(new InputError({ message: "Use a Steam /profiles/ID or /id/vanity URL." }));
    value = match[2];
    if (match[1] === "profiles" && !/^\d{17}$/.test(value)) {
      return yield* Effect.fail(new InputError({ message: "The profile URL must contain a SteamID64." }));
    }
  }
  let numeric: string | undefined;
  if (/^\d+$/.test(value)) numeric = value;
  const old = /^STEAM_[01]:([01]):(\d{1,10})$/.exec(value);
  if (old?.[1] && old[2]) numeric = (STEAM_BASE + BigInt(old[2]) * 2n + BigInt(old[1])).toString();
  const modern = /^\[U:1:(\d{1,10})\]$/.exec(value);
  if (modern?.[1]) numeric = (STEAM_BASE + BigInt(modern[1])).toString();
  if (numeric !== undefined) {
    const id = yield* Schema.decodeUnknownEffect(SteamId)(numeric).pipe(
      Effect.mapError(() => new InputError({ message: "Enter a valid individual Steam account ID." })),
    );
    return { kind: "id", id } as const;
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value) || /^STEAM_/i.test(value)) {
    return yield* Effect.fail(new InputError({ message: "Enter a SteamID64, SteamID2, [U:1:ID], vanity name, or Steam profile URL." }));
  }
  return { kind: "vanity", vanity: value } as const;
});
