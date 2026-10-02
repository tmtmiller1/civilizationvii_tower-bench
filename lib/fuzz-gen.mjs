// Pure: the fuzz generator. Given the live targets (fuzzTargets in engine-sim.mjs) and a seeded generator, it
// picks one step: a verified write or game-state action aimed at something that exists now, or a turn roll.
// Every action it emits passes validateRequest, so the bench's own refusals mean the game said no.
import { validateRequest } from "./writes.mjs";

const TWO_WAY = ["YIELD_GOLD", "YIELD_DIPLOMACY", "YIELD_HAPPINESS"];
const GAIN_ONLY = ["YIELD_SCIENCE", "YIELD_CULTURE"];

/**
 * @typedef {{ owner: number, id: number, x: number, y: number, type?: string | null }} Unit
 * @typedef {{ owner: number, id: number, x: number, y: number, town?: boolean }} City
 * @typedef {{ local: number, w: number, h: number, players: { id: number, major: boolean, human: boolean }[],
 *   units: Unit[], cities: City[] }} Targets
 * @typedef {{ rng: import("./sim-random.mjs").Rng, t: Targets }} GenCtx
 */

const clampX = (t, x) => ((x % t.w) + t.w) % t.w; // the map wraps east-west
const clampY = (t, y) => Math.max(0, Math.min(t.h - 1, y));

/** A plot within `r` of (x, y), on the map. @param {GenCtx} c */
function near({ rng, t }, x, y, r = 2) {
  return { x: clampX(t, x + rng.int(-r, r)), y: clampY(t, y + rng.int(-r, r)) };
}

/** @param {GenCtx} c */
const majors = (c) => c.t.players.filter((p) => p.major);
/** @param {GenCtx} c */
const aiCities = (c) => c.t.cities.filter((x) => !c.t.players.find((p) => p.id === x.owner)?.human);
const unitRef = (u) => ({ player: u.owner, unit: u.id });
const cityRef = (x) => ({ player: x.owner, city: x.id });

/** @type {Record<string, (c: GenCtx) => { op: string, args: any } | null>} */
const GENERATORS = {
  "unit.place": (c) => {
    const u = c.rng.pick(c.t.units.filter((x) => x.type));
    return u ? { op: "unit.place", args: { ...near(c, u.x, u.y, 1), type: u.type, owner: u.owner } } : null;
  },
  "unit.remove": (c) => {
    const u = c.rng.pick(c.t.units);
    return u ? { op: "unit.remove", args: { x: u.x, y: u.y, owner: u.owner, id: u.id } } : null;
  },
  "unit.heal": (c) => one(c, "unit.heal", () => ({})),
  "unit.damage": (c) => one(c, "unit.damage", () => ({ amount: c.rng.int(10, 60) })),
  "unit.xp": (c) => one(c, "unit.xp", () => ({ amount: c.rng.int(5, 50) })),
  "unit.moves": (c) => one(c, "unit.moves", () => ({})),
  "unit.move": (c) => one(c, "unit.move", (u) => {
    const to = near(c, u.x, u.y, 2);
    return { toX: to.x, toY: to.y };
  }),
  "unit.kill": (c) => one(c, "unit.kill", () => ({})),
  "city.production": (c) => city(c, c.t.cities, "city.production", () => ({ amount: c.rng.int(10, 200) })),
  "city.complete": (c) => city(c, c.t.cities, "city.complete", () => ({})),
  // A human player's End Turn stays blocked until a granted population point is placed (watched), so only AI
  // settlements grow.
  "city.grow": (c) => city(c, aiCities(c), "city.grow", () => ({})),
  "player.yield": (c) => {
    const p = c.rng.pick(majors(c));
    if (!p) return null;
    const y = /** @type {string} */ (c.rng.pick([...TWO_WAY, ...GAIN_ONLY]));
    const size = c.rng.int(5, 150);
    const amount = TWO_WAY.includes(y) && c.rng.chance(0.3) ? -size : size;
    return { op: "player.yield", args: { player: p.id, yield: y, amount } };
  },
  // A human celebration waits on a choice at the turn roll, so only AI players celebrate.
  "player.celebrate": (c) => player(c, "player.celebrate", () => ({}), true),
  "progress.complete": (c) => player(c, "progress.complete", () => ({ tree: c.rng.pick(["tech", "civic"]) })),
  "map.owner": (c) => city(c, c.t.cities, "map.owner", (x) => near(c, x.x, x.y, 3)),
  "feature.set": (c) => plotNearUnit(c, "feature.set"),
  "resource.set": (c) => plotNearUnit(c, "resource.set"),
  "town.place": (c) => {
    const u = c.rng.pick(c.t.units.filter((x) => majors(c).some((p) => p.id === x.owner)));
    return u ? { op: "town.place", args: { ...near(c, u.x, u.y, 2), owner: u.owner } } : null;
  },
};

function one(c, op, more) {
  const u = c.rng.pick(c.t.units);
  return u ? { op, args: { ...unitRef(u), ...more(u) } } : null;
}

function city(c, list, op, more) {
  const x = c.rng.pick(list);
  return x ? { op, args: { ...cityRef(x), ...more(x) } } : null;
}

function player(c, op, more, aiOnly = false) {
  const p = c.rng.pick(majors(c).filter((x) => !aiOnly || !x.human));
  return p ? { op, args: { player: p.id, ...more() } } : null;
}

function plotNearUnit(c, op) {
  const u = c.rng.pick(c.t.units);
  return u ? { op, args: { ...near(c, u.x, u.y, 2), type: null } } : null;
}

// Left out on purpose: terrain.set (persists and can strand units for good), town.remove, map.reveal of the
// whole map (queues a camera cinematic per natural wonder), and promote / grant (need type names).
export const FUZZ_OPS = Object.keys(GENERATORS);

/** Shuffles a copy with the seeded generator. */
function shuffled(rng, xs) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * One step: { turns: 1 } with probability `turnChance`, else a write { write: { op, args } } from `ops`.
 * Falls back to a turn roll when no op has a valid target.
 * @param {import("./sim-random.mjs").Rng} rng @param {Targets} t
 * @param {{ ops?: string[], turnChance?: number }} [o]
 */
export function generateStep(rng, t, { ops = FUZZ_OPS, turnChance = 0.35 } = {}) {
  if (rng.chance(turnChance)) return { turns: 1 };
  for (const op of shuffled(rng, ops.filter((x) => Object.hasOwn(GENERATORS, x)))) {
    const req = GENERATORS[op]({ rng, t });
    if (req && !validateRequest(req)) return { write: req };
  }
  return { turns: 1 };
}
