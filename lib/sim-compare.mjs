// Pure: two games sampled turn by turn, aligned by turn and compared. A sample is { turn, world, numbers }:
// `world` is a worldSnapshot (plots, units, settlements), `numbers` the per-player figures from playerNumbers.
// Game A is the reference (the mod off, or the first of two repeats), game B the other.
import { diffWorlds } from "./world.mjs";

const LAYERS = [["t", "terrains"], ["f", "features"], ["r", "resources"]];
const MAX_LINES = 12;

const nameAt = (snap, table, v) => (v == null || v < 0 ? null : snap.names?.[table]?.[v] ?? `#${v}`);

// A mod that adds a terrain, feature or resource row can shift every index after it, so plots are compared by
// type name. When both games share the tables the snapshots pass through untouched.
function unify(a, b) {
  if (JSON.stringify(a.names ?? null) === JSON.stringify(b.names ?? null)) return [a, b];
  const A = { ...a, names: {} };
  const B = { ...b, names: {} };
  for (const [layer, table] of LAYERS) {
    const all = [...a[layer].map((v) => nameAt(a, table, v)), ...b[layer].map((v) => nameAt(b, table, v))];
    const merged = [...new Set(all)].filter((n) => n != null);
    const index = new Map(merged.map((n, i) => [n, i]));
    const remap = (s) => s[layer].map((v) => (nameAt(s, table, v) == null ? -1 : index.get(nameAt(s, table, v))));
    A[layer] = remap(a);
    B[layer] = remap(b);
    A.names[table] = merged;
    B.names[table] = merged;
  }
  return [A, B];
}

/** Every number in a player's figures, flattened to "path" -> value (strings such as names are skipped). */
export function flattenPlayer(p, prefix = `player ${p.id}`) {
  /** @type {Map<string, number>} */
  const out = new Map();
  const walk = (v, key) => {
    if (typeof v === "number") out.set(key, v);
    else if (typeof v === "boolean") out.set(key, v ? 1 : 0);
    else if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) walk(x, `${key} ${k}`);
  };
  for (const [k, v] of Object.entries(p)) if (k !== "id") walk(v, `${prefix} ${k}`);
  return out;
}

const flattenAll = (numbers) => {
  const out = new Map();
  for (const p of numbers?.players ?? []) for (const [k, v] of flattenPlayer(p)) out.set(k, v);
  return out;
};

/** The per-player figures that differ by more than `tol`, or exist in only one game. */
export function diffNumbers(a, b, tol = 0.01) {
  const [A, B] = [flattenAll(a), flattenAll(b)];
  const out = [];
  for (const key of new Set([...A.keys(), ...B.keys()])) {
    const [x, y] = [A.get(key), B.get(key)];
    if (x === undefined || y === undefined || Math.abs(x - y) > tol) out.push({ key, a: x ?? null, b: y ?? null });
  }
  return out;
}

const unitCount = (u) => u.appeared.length + u.gone.length + u.moved.length;
const cityCount = (c) => c.founded.length + c.lost.length + c.captured.length + c.grew.length;

/** One turn of game A against the same turn of game B. */
export function compareTurn(a, b) {
  let world = null;
  if (a.world && b.world) {
    const [A, B] = unify(a.world, b.world);
    world = diffWorlds(A, B);
  }
  const numbers = diffNumbers(a.numbers, b.numbers);
  const counts = {
    plots: world ? world.plots.length : null,
    units: world ? unitCount(world.units) : null,
    cities: world ? cityCount(world.cities) : null,
    numbers: numbers.length,
  };
  const total = (counts.plots ?? 0) + (counts.units ?? 0) + (counts.cities ?? 0) + counts.numbers;
  return { turn: a.turn, counts: { ...counts, total }, world, numbers };
}

const at = (p) => `(${p.x}, ${p.y})`;
const who = (id) => (id < 0 ? "nobody" : `player ${id}`);

/** @type {((d: any, labels: string[]) => string[])[]} */
const WORLD_LINES = [
  (d, [A, B]) => d.plots.flatMap((p) => [
    p.owner ? `plot ${at(p)}: owner ${who(p.owner[0])} in ${A}, ${who(p.owner[1])} in ${B}` : null,
    ...["terrain", "feature", "resource"].filter((k) => p[k])
      .map((k) => `plot ${at(p)}: ${k} ${p[k][0] ?? "none"} in ${A}, ${p[k][1] ?? "none"} in ${B}`),
  ].filter(Boolean)),
  (d, [A, B]) => d.units.appeared.map((u) => `unit ${u.type} ${u.owner}:${u.id} at ${at(u)} only in ${B} (not in ${A})`),
  (d, [A, B]) => d.units.gone.map((u) => `unit ${u.type} ${u.owner}:${u.id} at ${at(u)} only in ${A} (not in ${B})`),
  (d, [A, B]) => d.units.moved.map((u) => `unit ${u.type} ${u.owner}:${u.id} at ${at(u.from)} in ${A}, ${at(u.to)} in ${B}`),
  (d, [, B]) => d.cities.founded.map((c) => `settlement ${c.name} of ${who(c.owner)} at ${at(c)} only in ${B}`),
  (d, [A]) => d.cities.lost.map((c) => `settlement ${c.name} of ${who(c.owner)} at ${at(c)} only in ${A}`),
  (d, [A, B]) => d.cities.captured.map((c) => `settlement ${c.name} at ${at(c)}: ${who(c.from)} in ${A}, ${who(c.owner)} in ${B}`),
  (d, [A, B]) => d.cities.grew.map((c) => `settlement ${c.name}: population ${c.popFrom} in ${A}, ${c.pop} in ${B}`),
];

/** What differs on one compared turn, a few lines per kind. */
export function divergenceLines(cmp, labels = ["A", "B"]) {
  const lines = [];
  if (cmp.world) for (const section of WORLD_LINES) lines.push(...section(cmp.world, labels).slice(0, MAX_LINES));
  const fmt = (v) => (v === null ? "absent" : Math.round(v * 100) / 100);
  lines.push(...cmp.numbers.slice(0, MAX_LINES).map((n) => `${n.key}: ${fmt(n.a)} in ${labels[0]}, ${fmt(n.b)} in ${labels[1]}`));
  const more = (cmp.world?.plots.length ?? 0) > MAX_LINES || cmp.numbers.length > MAX_LINES;
  if (more) lines.push(`(first ${MAX_LINES} of each kind shown)`);
  return lines;
}

/**
 * Aligns two games by turn and compares every turn both reached.
 * @param {any[]} a @param {any[]} b @param {{ labels?: string[] }} [o]
 */
export function compareSeries(a, b, { labels = ["A", "B"] } = {}) {
  const byTurn = new Map(b.map((s) => [s.turn, s]));
  const shared = a.filter((s) => byTurn.has(s.turn));
  const turns = shared.map((s) => compareTurn(s, byTurn.get(s.turn)));
  const firstCmp = turns.find((t) => t.counts.total > 0) ?? null;
  const onlyIn = (xs, ys) => xs.map((s) => s.turn).filter((t) => !ys.some((y) => y.turn === t));
  return {
    labels,
    curve: turns.map((t) => ({ turn: t.turn, ...t.counts })),
    first: firstCmp ? { turn: firstCmp.turn, counts: firstCmp.counts, lines: divergenceLines(firstCmp, labels) } : null,
    compared: turns.length,
    lastTurn: turns.length ? turns[turns.length - 1].turn : null,
    missing: { [labels[0]]: onlyIn(a, b), [labels[1]]: onlyIn(b, a) },
  };
}

/** The determinism verdict for two games run with the same seed and the same mods. */
export function repeatVerdict(cmp) {
  if (!cmp.compared) return { verdict: "NO DATA", detail: "no turn was sampled in both games", divergedAt: null };
  if (!cmp.first) {
    return { verdict: "DETERMINISTIC", divergedAt: null,
      detail: `${cmp.compared} turn(s) identical through turn ${cmp.lastTurn}: plots, units, settlements and figures` };
  }
  return { verdict: `DIVERGES AT TURN ${cmp.first.turn}`, divergedAt: cmp.first.turn,
    detail: cmp.first.lines.slice(0, 3).join("; ") };
}

/**
 * Whether a divergence between the mod off and on can be put down to the mod. Only when a determinism control
 * (the same seed and the same mods twice) stayed identical at least through the turn the arms first differ.
 * @param {{ turn: number } | null} first @param {any} control
 */
export function attribute(first, control) {
  if (!first) return { verdict: "NO DIVERGENCE", detail: "the two games matched on every compared turn" };
  if (!control) {
    return { verdict: "UNCONTROLLED", detail: `the games differ from turn ${first.turn}, but no determinism control `
      + "exists for this seed and mod set, so the cause may be the game's own run-to-run variation" };
  }
  const clean = control.divergedAt == null ? control.lastTurn >= first.turn : control.divergedAt > first.turn;
  if (clean) {
    return { verdict: "CAUSED BY THE MOD", detail: `the games differ from turn ${first.turn}; the control repeated `
      + `identically through turn ${control.divergedAt == null ? control.lastTurn : control.divergedAt - 1}` };
  }
  const why = control.divergedAt == null ? `only covers turns through ${control.lastTurn}`
    : `itself diverged at turn ${control.divergedAt}`;
  return { verdict: "NOT ATTRIBUTABLE", detail: `the games differ from turn ${first.turn}, but the control ${why}` };
}
