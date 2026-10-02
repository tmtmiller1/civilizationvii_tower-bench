// Pure statistics for the balance arena: bootstrap intervals (seeded, so a report recomputes exactly), mean
// curves over games, paired mod-off/mod-on effects and lead rates with Wilson intervals.
import { makeRng } from "./sim-random.mjs";

export const mean = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
};

function percentile(sorted, q) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (i - lo);
}

/**
 * Percentile bootstrap interval of `stat` over `values`.
 * @param {number[]} values @param {{ iters?: number, alpha?: number, seed?: number,
 *   stat?: (xs: number[]) => number }} [o]
 */
export function bootstrapCI(values, { iters = 2000, alpha = 0.05, seed = 1, stat = mean } = {}) {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return { est: NaN, lo: NaN, hi: NaN, n: 0 };
  const rng = makeRng(seed);
  const stats = [];
  for (let k = 0; k < iters; k++) stats.push(stat(v.map(() => v[rng.int(0, v.length - 1)])));
  stats.sort((a, b) => a - b);
  return { est: stat(v), lo: percentile(stats, alpha / 2), hi: percentile(stats, 1 - alpha / 2), n: v.length };
}

/**
 * Per turn index, the mean over games and its bootstrap interval. `games` holds one per-turn series per game.
 * @param {(number | null)[][]} games @param {number[]} [turns] the turn number of each index
 */
export function meanCurve(games, turns, { iters = 1000, seed = 1 } = {}) {
  const len = Math.max(0, ...games.map((g) => g.length));
  const out = [];
  for (let i = 0; i < len; i++) {
    const at = games.map((g) => g[i]).filter((x) => x != null && Number.isFinite(x));
    out.push({ turn: turns?.[i] ?? i, ...bootstrapCI(/** @type {number[]} */ (at), { iters, seed: seed + i }) });
  }
  return out;
}

/**
 * The mod's effect on one figure: per seed on minus off, the mean difference and its bootstrap interval.
 * Significant when the interval leaves out zero.
 * @param {Map<number, number>} off @param {Map<number, number>} on
 */
export function pairedEffect(off, on, { iters = 2000, seed = 1 } = {}) {
  const diffs = [...off.keys()].filter((k) => on.has(k))
    .map((k) => Number(on.get(k)) - Number(off.get(k))).filter((x) => Number.isFinite(x));
  const ci = bootstrapCI(diffs, { iters, seed });
  return { ...ci, pairs: diffs.length, significant: ci.n > 1 && (ci.lo > 0 || ci.hi < 0) };
}

/** Wilson score interval for k successes in n trials. */
export function wilson(k, n, z = 1.96) {
  if (!n) return { rate: NaN, lo: NaN, hi: NaN };
  const p = k / n;
  const den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return { rate: p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/**
 * How often each civ or leader led (or won) the games it played. `games` is [{ entrants: string[], leader:
 * string | null }]; a key counts once per game it appeared in.
 * @param {{ entrants: string[], leader: string | null }[]} games
 */
export function leadRates(games) {
  /** @type {Map<string, { games: number, leads: number }>} */
  const by = new Map();
  for (const g of games) {
    for (const key of new Set(g.entrants)) {
      const e = by.get(key) ?? { games: 0, leads: 0 };
      e.games += 1;
      if (g.leader === key) e.leads += 1;
      by.set(key, e);
    }
  }
  return [...by].map(([key, e]) => ({ key, ...e, ...wilson(e.leads, e.games) }))
    .sort((a, b) => b.rate - a.rate || b.games - a.games || a.key.localeCompare(b.key));
}
