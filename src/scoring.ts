import { Schema } from "effect";
import type { Ranking } from "./model.js";

/** Authored 2:2:1 count blend. Reference populations are chosen by each source, not by display filters. */
export function countIndex(population: readonly number[], topN: number, baseline: number) {
  if (!population.length) return (_count: number): number | null => null;
  const sorted = [...population].sort((a, b) => b - a);
  const top = sorted.slice(0, topN);
  const mean = top.reduce((sum, count) => sum + count, 0) / top.length;
  const maximum = Math.max(1, sorted[0] ?? 0);
  return (count: number): number | null => 100 * (2 * Math.min(1, count / Math.max(1, mean * 1.5)) +
    2 * Math.min(1, count / maximum) + Math.min(1, count / baseline)) / 5;
}

export const LocationSignal = Schema.Struct({
  country: Schema.String, state: Schema.NullOr(Schema.String), city: Schema.Number,
  contributors: Schema.Number, zeroContributors: Schema.Number, support: Schema.String,
  share: Schema.NullOr(Schema.Number), index: Schema.NullOr(Schema.Number),
});
export interface LocationSignal extends Schema.Schema.Type<typeof LocationSignal> {}
export const LocationCoverage = Schema.Struct({ referenceSize: Schema.Number, located: Schema.Number, missingLocation: Schema.Number, uncollected: Schema.Number });
/** Compact display only; exports and record details retain the exact decimal support. */
export function displaySupport(support: string): string {
  if (support.length <= 18) return support;
  return `≈ ${support[0]}.${support.slice(1, 4)} × 10^${support.length - 1}`;
}
export interface LocationContributor { readonly country: string | null; readonly state: string | null; readonly city: number | null; readonly count: number }

/** Both values stay integers, even for products larger than Number.MAX_VALUE. Convert only the bounded ratio. */
function fraction(numerator: bigint, denominator: bigint): number {
  const scale = 1000000000000000000n;
  return Number(numerator * scale / denominator) / Number(scale);
}
export function locations(contributors: readonly LocationContributor[], settings: Pick<Ranking, "locationAggregation" | "locationBaseline">): LocationSignal[] {
  const cities = new Map<string, { country: string; state: string | null; city: number; counts: number[] }>();
  for (const record of contributors) {
    if (!record.country || record.city === null) continue;
    const key = `${record.country}/${record.state ?? ""}/${record.city}`;
    const city = cities.get(key) ?? { country: record.country, state: record.state, city: record.city, counts: [] };
    city.counts.push(record.count); cities.set(key, city);
  }
  const supports = [...cities.values()].map(({ counts, ...city }) => ({ ...city, contributors: counts.length,
    zeroContributors: counts.filter((count) => count === 0).length,
    support: settings.locationAggregation === "product" ? counts.reduce((product, count) => product * BigInt(count), 1n)
      : counts.reduce((sum, count) => sum + BigInt(count), 0n),
  }));
  const total = supports.reduce((sum, city) => sum + city.support, 0n);
  supports.sort((a, b) => a.support === b.support ? `${a.country}/${a.state}/${a.city}`.localeCompare(`${b.country}/${b.state}/${b.city}`) : a.support > b.support ? -1 : 1);
  return supports.map(({ support, ...city }) => {
    const share = total ? fraction(support, total) : null;
    const baseline = BigInt(settings.locationBaseline);
    const constant = support >= baseline ? 1 : fraction(support, baseline);
    return { ...city, support: support.toString(), share: share === null ? null : share * 100,
      index: share === null ? null : 100 * (2 * share + constant) / 3 };
  });
}
