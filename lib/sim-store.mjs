// Where sim, fuzz and arena keep what they find: one JSON report per run beside the lab runs, and the
// determinism controls, keyed by seed, start age, mod set and game version so a later run can cite them.
import fs from "node:fs";
import path from "node:path";
import { seedOf } from "./sim-random.mjs";

export const REPORT_KINDS = ["sim-diff", "sim-repeat", "fuzz", "arena"];
const REPORT_NAME = new RegExp(`^(${REPORT_KINDS.join("|")})-[\\w-]+\\.json$`);
// Fields too large for a listing.
const HEAVY = ["curve", "games", "runs", "trials", "series", "curves"];

export const stampNow = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
export const runsDir = (paths) => path.join(path.dirname(paths.evidence), "runs");

/** @param {any} paths @param {string} kind @param {object} record */
export function writeReport(paths, kind, record) {
  if (!REPORT_KINDS.includes(kind)) throw new Error(`unknown report kind ${kind}`);
  const dir = runsDir(paths);
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, `${kind}-${stampNow()}.json`);
  for (let k = 2; fs.existsSync(file); k++) file = path.join(dir, `${kind}-${stampNow()}-${k}.json`);
  fs.writeFileSync(file, JSON.stringify({ kind, ...record }, null, 2));
  return file;
}

/** Saved reports, newest first, without their per-turn data. */
export function listReports(paths, { kinds = REPORT_KINDS, limit = 50 } = {}) {
  let names = [];
  try { names = fs.readdirSync(runsDir(paths)).filter((n) => REPORT_NAME.test(n)); } catch { return []; }
  const kindOf = (n) => REPORT_KINDS.find((k) => n.startsWith(`${k}-`)) ?? "";
  return names.filter((n) => kinds.includes(kindOf(n))).sort((a, b) => b.slice(kindOf(b).length)
    .localeCompare(a.slice(kindOf(a).length))).slice(0, limit).flatMap((name) => {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(runsDir(paths), name), "utf8"));
      for (const k of HEAVY) delete r[k];
      return [{ name, ...r }];
    } catch {
      return [];
    }
  });
}

export function readReport(paths, name) {
  if (!REPORT_NAME.test(String(name ?? ""))) throw new Error("no such report");
  const file = path.join(runsDir(paths), String(name));
  if (!fs.existsSync(file)) throw new Error("no such report");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ---------- determinism controls ----------

/** @param {string[]} mods */
export const modSetKey = (mods) => seedOf(...[...mods].sort()).toString(16).padStart(8, "0");

/**
 * @typedef {{ seed: number, age?: string | null, mods: string[], version?: string | null }} ControlScope
 * @typedef {ControlScope & { turns: number, firstTurn?: number | null, lastTurn: number | null,
 *   verdict: string, divergedAt: number | null, what?: string[], source?: string, report?: string | null,
 *   at?: string }} Control
 */

/** @param {ControlScope} s */
export const controlKey = (s) => `${s.seed}|${s.age ?? "-"}|${modSetKey(s.mods)}|${s.version ?? "-"}`;

const controlsFile = (paths) => path.join(runsDir(paths), "sim-controls.json");

/** @returns {Control[]} */
export function readControls(paths) {
  try { return JSON.parse(fs.readFileSync(controlsFile(paths), "utf8")); } catch { return []; }
}

/**
 * Stores a determinism control. `sim repeat` records its own; a determinism test run some other way records
 * one here with `source` naming it, and sim diff, fuzz and arena cite it like their own.
 * @param {any} paths @param {Control} c
 */
export function recordControl(paths, c) {
  const all = readControls(paths);
  const entry = { ...c, mods: [...c.mods].sort(), key: controlKey(c), source: c.source ?? "sim repeat",
    at: c.at ?? new Date().toISOString() };
  all.push(entry);
  fs.mkdirSync(runsDir(paths), { recursive: true });
  fs.writeFileSync(controlsFile(paths), JSON.stringify(all, null, 2));
  return entry;
}

/**
 * The control that says most about this scope: a divergence found anywhere wins (the game is known not to
 * repeat), otherwise the clean control that reached furthest. Newest first among equals.
 * @param {Control[]} controls @param {ControlScope} scope
 */
export function pickControl(controls, scope) {
  const key = controlKey(scope);
  const mine = controls.filter((c) => controlKey(c) === key).reverse();
  if (!mine.length) return null;
  const diverged = mine.filter((c) => c.divergedAt != null).sort((a, b) => Number(a.divergedAt) - Number(b.divergedAt));
  if (diverged.length) return diverged[0];
  return [...mine].sort((a, b) => Number(b.lastTurn ?? -1) - Number(a.lastTurn ?? -1))[0];
}

/** @param {any} paths @param {ControlScope} scope */
export const findControl = (paths, scope) => pickControl(readControls(paths), scope);
