// Balance arena: seeded games with a mod off and on, every player's figures recorded each turn, and the mod's
// effect estimated over seeds with bootstrap intervals. No all-AI observer game is known to work on this
// engine, so the local player takes part passively: its turns are ended with sendTurnComplete (never Autoplay,
// which spends the treasury) and it makes no choices. It is left out of every rate, mean and effect.
import { BenchError } from "./bench.mjs";
import { copiesOf, setModCopies } from "./labtools.mjs";
import { leadRates, meanCurve, pairedEffect } from "./arena-stats.mjs";
import { plannedMods, playGame, refuseBusy } from "./sim-game.mjs";
import { findControl, writeReport } from "./sim-store.mjs";

/** @typedef {import("./sim-game.mjs").SimDeps} SimDeps */

export const OBSERVER_CAVEAT = "No all-AI observer game is watched on this engine: Autoplay spends the treasury and "
  + "reads localPlayerID -1 (engine-closed.md), and no observer slot has been seen to start. The local player took "
  + "part passively: its turns were ended with sendTurnComplete and it made no choices. It is left out of the lead "
  + "rates, the means and the effects, but its passivity still shapes the AI's world (an easy neighbour).";

/** @type {Record<string, (p: any) => number | null | undefined>} */
export const ARENA_METRICS = {
  score: (p) => p.score,
  techs: (p) => p.techs,
  civics: (p) => p.civics,
  cities: (p) => p.cities,
  pop: (p) => p.pop,
  units: (p) => p.units,
  treasury: (p) => p.gold,
  gold: (p) => p.yields?.gold,
  science: (p) => p.yields?.science,
  culture: (p) => p.yields?.culture,
  production: (p) => p.yields?.production,
  food: (p) => p.yields?.food,
};

/** "4242..4251" or "1,5,9" to a list of seeds. */
export function parseSeeds(text) {
  const range = String(text).match(/^\s*(\d+)\s*\.\.\s*(\d+)\s*$/);
  if (range) {
    const [a, b] = [Number(range[1]), Number(range[2])];
    if (b < a || b - a > 999) throw new BenchError("seeds a..b needs a <= b and at most 1000 seeds");
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }
  const list = String(text).split(",").map((s) => Number(s.trim()));
  if (!list.length || list.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new BenchError(`bad seeds "${text}": use a..b or a,b,c`);
  }
  return list;
}

const contenders = (players, local) => players.filter((p) => p.major && !p.human && p.id !== local);
const keyOf = (p) => p.leader ?? p.civ ?? `player ${p.id}`;

function finalLeader(players) {
  const rank = (p) => [p.score ?? -1, (p.techs ?? 0) + (p.civics ?? 0), p.pop ?? 0];
  const sorted = [...players].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  });
  return sorted[0] ?? null;
}

// A claimed victory, where the engine reports one (its shape is not watched: any numeric player field counts).
function victor(victories) {
  for (const v of Array.isArray(victories) ? victories : []) {
    const id = ["playerID", "player", "Player", "team"].map((k) => v?.[k]).find((x) => Number.isInteger(x));
    if (id != null) return id;
  }
  return null;
}

const entrant = (p) => ({ id: p.id, civ: p.civ ?? null, leader: p.leader ?? null, final: { score: p.score ?? null,
  techs: p.techs ?? null, civics: p.civics ?? null, cities: p.cities ?? null, pop: p.pop ?? null } });

function aggregateOf(samples, aiOf) {
  /** @type {Record<string, (number | null)[]>} */
  const out = {};
  for (const [m, get] of Object.entries(ARENA_METRICS)) {
    out[m] = samples.map((s) => {
      const v = aiOf(s).map(get).filter((x) => typeof x === "number" && Number.isFinite(x));
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    });
  }
  return out;
}

function outcome(last, aiOf) {
  const finalists = last ? aiOf(last) : [];
  const lead = finalLeader(finalists);
  const winner = victor(last?.numbers?.victories);
  const winnerP = winner == null ? null : finalists.find((p) => p.id === winner) ?? { id: winner };
  return { entrants: finalists.map(entrant), leader: lead ? keyOf(lead) : null, leaderCiv: lead?.civ ?? null,
    winner, winnerKey: winnerP ? keyOf(winnerP) : null };
}

/** One game's samples reduced to what the arena compares: per-turn means over the AI majors, and who led. */
export function compactGame(samples, { seed, arm, error = null, dir = null }) {
  const local = samples[0]?.numbers?.local ?? null;
  const aiOf = (s) => contenders(s.numbers?.players ?? [], local);
  return { seed, arm, dir, error, local, turns: samples.map((s) => s.turn), aggregate: aggregateOf(samples, aiOf),
    ...outcome(samples.at(-1), aiOf) };
}

function armStats(games) {
  const turns = games.reduce((best, g) => (g.turns.length > best.length ? g.turns : best), /** @type {any[]} */ ([]));
  const curves = Object.fromEntries(Object.keys(ARENA_METRICS)
    .map((m) => [m, meanCurve(games.map((g) => g.aggregate[m]), turns)]));
  return {
    games: games.length,
    curves,
    leadByLeader: leadRates(games.map((g) => ({ entrants: g.entrants.map(keyOf), leader: g.leader }))),
    leadByCiv: leadRates(games.map((g) => ({ entrants: g.entrants.map((e) => e.civ ?? keyOf(e)),
      leader: g.leaderCiv }))),
    victories: games.filter((g) => g.winner != null).length,
  };
}

const finalOf = (g, m) => {
  const xs = g.aggregate[m].filter((x) => x != null);
  return xs.length ? xs[xs.length - 1] : NaN;
};

/** Pure: the whole arena report from compacted games. */
export function arenaReport(games) {
  const ok = games.filter((g) => g.turns.length > 1);
  const by = (arm) => ok.filter((g) => g.arm === arm);
  const finals = (arm, m) => new Map(by(arm).map((g) => [g.seed, finalOf(g, m)]));
  const effects = Object.fromEntries(Object.keys(ARENA_METRICS)
    .map((m) => [m, pairedEffect(finals("off", m), finals("on", m))]));
  return { arms: { off: armStats(by("off")), on: armStats(by("on")) }, effects,
    failed: games.filter((g) => g.turns.length <= 1 || g.error)
      .map((g) => ({ seed: g.seed, arm: g.arm, error: g.error })) };
}

/** The seeds' determinism controls for the mod-off set: how many repeat at least as far as the arena plays. */
function controls(paths, d, copies, o) {
  const mods = plannedMods(paths, d, copies, false);
  const version = d.bench.version ?? null;
  const found = o.seeds.map((seed) => findControl(paths, { seed, age: o.age ?? null, mods, version }));
  const clean = found.filter((c) => c && c.divergedAt == null && (c.lastTurn ?? 0) >= o.turns).length;
  return { seeds: o.seeds.length, controlled: found.filter(Boolean).length, deterministic: clean };
}

/**
 * @param {SimDeps} d
 * @param {{ modId: string, seeds: number[], turns: number, age?: string | null }} o
 */
export async function runArena(d, o) {
  const paths = d.bench.paths;
  const warnings = refuseBusy(paths, d);
  const copies = copiesOf(paths, d, o.modId);
  if (!copies.chosen) throw new BenchError(`no mod "${o.modId}" in the registry (official content cannot be switched)`);
  const others = copies.all.filter((c) => c.path !== copies.chosen.path);
  const set = { off: () => setModCopies(paths, d, copies.all, []),
    on: () => setModCopies(paths, d, others, [copies.chosen]) };
  const determinism = controls(paths, d, copies, o);
  const games = [];
  for (const [k, seed] of o.seeds.entries()) {
    for (const arm of k % 2 ? ["on", "off"] : ["off", "on"]) {
      d.log(`seed ${seed} (${k + 1} of ${o.seeds.length}), mod ${arm}: ${o.turns} turn(s)`);
      const g = await playGame(d, { tool: "arena", label: `arena-${arm}`, seed, age: o.age, turns: o.turns,
        world: false, setMods: set[/** @type {"on" | "off"} */ (arm)] });
      games.push(compactGame(g.samples, { seed, arm, error: g.error, dir: g.dir }));
    }
  }
  const record = { mod: o.modId, copy: copies.chosen.path, seeds: o.seeds, turns: o.turns, age: o.age ?? null,
    version: d.bench.version ?? null, observer: false, caveat: OBSERVER_CAVEAT, determinism, warnings,
    ...arenaReport(games), games };
  const report = writeReport(paths, "arena", record);
  const headline = Object.fromEntries(Object.entries(record.effects)
    .map(([m, e]) => [m, { est: e.est, lo: e.lo, hi: e.hi }]));
  d.bench.log({ kind: "arena", request: { mod: o.modId, seeds: o.seeds, turns: o.turns },
    result: { report, effects: headline } });
  return { ...record, report };
}
