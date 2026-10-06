import { Effect, Schema } from "effect";
import { InputError, STEAM_BASE, SteamId } from "./model.js";

const isVanity = (value: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const individualId = (value: string) => Schema.decodeUnknownEffect(SteamId)(value).pipe(
  Effect.mapError(() => new InputError({ message: "Enter a valid individual Steam account ID." })),
  Effect.map((id) => ({ kind: "id", id } as const)),
);

/** URL namespaces select the identifier grammar, even when a vanity name contains only digits. */
const profileUrl = Effect.fn("Identifiers.profileUrl")(function* (value: string) {
  const url = yield* Effect.try({
    try: () => new URL(value.includes("://") ? value : `https://${value}`),
    catch: () => new InputError({ message: "Enter a valid Steam community profile URL." }),
  });
  if (!["https:", "http:"].includes(url.protocol) || !["steamcommunity.com", "www.steamcommunity.com"].includes(url.hostname) || url.username || url.password || url.port) {
    return yield* Effect.fail(new InputError({ message: "Only steamcommunity.com profile URLs are accepted." }));
  }
  const match = /^\/(profiles|id)\/([^/]+)\/?$/.exec(url.pathname);
  if (!match?.[2]) return yield* Effect.fail(new InputError({ message: "Use a Steam /profiles/ID or /id/vanity URL." }));
  const name = match[2];
  if (match[1] === "id") {
    if (!isVanity(name)) return yield* Effect.fail(new InputError({ message: "The custom profile URL contains an invalid vanity name." }));
    return { kind: "vanity", vanity: name } as const;
  }
  if (!/^\d{17}$/.test(name)) {
    return yield* Effect.fail(new InputError({ message: "The profile URL must contain a SteamID64." }));
  }
  return yield* individualId(name);
});

/** Steam IDs are strings throughout: Number loses precision for SteamID64. */
export const parse = Effect.fn("Identifiers.parse")(function* (input: string) {
  const value = input.trim();
  if (/^(?:https?:\/\/|(?:www\.)?steamcommunity\.com\/)/i.test(value)) return yield* profileUrl(value);
  let numeric: string | undefined;
  if (/^\d+$/.test(value)) numeric = value;
  const old = /^STEAM_[01]:([01]):(\d{1,10})$/.exec(value);
  if (old?.[1] && old[2]) numeric = (STEAM_BASE + BigInt(old[2]) * 2n + BigInt(old[1])).toString();
  const modern = /^\[U:1:(\d{1,10})\]$/.exec(value);
  if (modern?.[1]) numeric = (STEAM_BASE + BigInt(modern[1])).toString();
  if (numeric !== undefined) {
    return yield* individualId(numeric);
  }
  if (!isVanity(value) || /^STEAM_/i.test(value)) {
    return yield* Effect.fail(new InputError({ message: "Enter a SteamID64, SteamID2, [U:1:ID], vanity name, or Steam profile URL." }));
  }
  return { kind: "vanity", vanity: value } as const;
});
