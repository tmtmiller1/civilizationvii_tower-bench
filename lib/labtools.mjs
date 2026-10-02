// One lab game with a chosen mod set, for tools that compare or prove across games (dbdiff, conflict proofs).
// The same discipline as bisect: back up, switch the registry, start a seeded Play Now game, do the work,
// quit, and restore every file and flag. Everything that touches the game comes in through `deps`, so tests
// can drive the whole flow against fakes.
import fs from "node:fs";
import path from "node:path";
import { BenchError } from "./bench.mjs";
import { Lab, applyModSet, candidateMods, gamePid, preflight, registryRows } from "./lab.mjs";
import { sourceOf } from "./mods.mjs";

/**
 * @typedef {{ id: string, path: string }} ModCopy
 * @typedef {{
 *   lab: Lab, preflight: typeof preflight, applyModSet: typeof applyModSet, gamePid: () => number | null,
 *   registryRows: typeof registryRows, candidateMods: typeof candidateMods, wait: (ms: number) => Promise<void>,
 * }} LabDeps
 */

const errorText = (e) => (e instanceof Error ? e.message : String(e));
export const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

/** @param {any} paths @param {Partial<LabDeps>} [deps] @returns {LabDeps} */
export function labDeps(paths, deps = {}) {
  return {
    lab: deps.lab ?? new Lab(paths),
    preflight: deps.preflight ?? preflight,
    applyModSet: deps.applyModSet ?? applyModSet,
    gamePid: deps.gamePid ?? gamePid,
    registryRows: deps.registryRows ?? registryRows,
    candidateMods: deps.candidateMods ?? candidateMods,
    wait: deps.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
}

/** Refuses while a lab run is open, the game is running or another harness runs; returns the warnings. */
export function refuseIfBusy(paths, d) {
  if (d.lab.current) throw new BenchError(`a test run is in progress (${d.lab.current.dir}); "lab stop" first`);
  const pf = d.preflight(paths);
  if (pf.problems.length) throw new BenchError(pf.problems.join("; "));
  return pf.warnings;
}

/**
 * The registry copies of a mod id the lab may switch, preferring the copy under `root`, then an enabled one.
 * @param {any} paths @param {LabDeps} d @param {string} id @param {string} [root]
 */
export function copiesOf(paths, d, id, root) {
  const rows = d.registryRows(paths.modsDb).filter((r) => r.id === id && sourceOf(r.path, paths).kind !== "official");
  const under = (r) => root && (path.dirname(r.path) === root || r.path.startsWith(root + path.sep));
  const chosen = rows.find(under) ?? rows.find((r) => !r.disabled) ?? rows[0] ?? null;
  return { all: rows.map((r) => ({ id: r.id, path: r.path })), chosen: chosen && { id: chosen.id, path: chosen.path } };
}

/**
 * Switches every copy in `off` off, then exactly the copies in `on` on. Two passes because applyModSet is keyed
 * by id: a second registered copy of an id must not ride along with the one chosen.
 * @param {any} paths @param {LabDeps} d @param {ModCopy[]} off @param {ModCopy[]} on
 */
export function setModCopies(paths, d, off, on) {
  if (off.length) d.applyModSet(paths.modsDb, off, []);
  if (on.length) d.applyModSet(paths.modsDb, on, on.map((c) => c.id));
}

async function quitAndRestore(d, dir, log) {
  await d.lab.quit({ log }).catch((e) => {
    throw new BenchError(`${errorText(e)}; your files and mods are not restored yet: run "tower-bench lab stop"`);
  });
  const rep = d.lab.restore(dir);
  d.lab.setCurrent(null);
  return rep;
}

/**
 * Runs `work` in one lab game. `setMods` switches the registry after the backup; `work` gets
 * { dir, started, error } and runs whether or not the game started, so it can read the logs of a game that
 * failed to load. The game is quit and everything restored afterwards, even when `work` throws.
 * @template T
 * @param {any} paths @param {LabDeps} d
 * @param {{ label: string, seed?: number | null, age?: string | null, log?: (line: string) => void,
 *   setMods: () => void }} run
 * @param {(game: { dir: string, started: boolean, error: string | null }) => Promise<T>} work
 */
export async function withLabGame(paths, d, { label, seed = null, age = null, log = () => {}, setMods }, work) {
  const dir = path.join(d.lab.root, `${label}-${stamp()}`);
  d.lab.backup(dir);
  d.lab.setCurrent({ dir, startedAt: new Date().toISOString(), seed, age, tool: label });
  let started = false;
  let error = null;
  /** @type {any} */
  let restore = null;
  let result;
  try {
    setMods();
    try {
      await d.lab.startNewGame({ seed, age, log });
      started = true;
      d.lab.setCurrent({ ...d.lab.current, pid: d.gamePid() });
    } catch (e) {
      error = `the game did not start: ${errorText(e)}`;
    }
    result = await work({ dir, started, error });
  } finally {
    restore = await quitAndRestore(d, dir, log);
  }
  return { dir, started, error, result, restore };
}

/** Copies a log file into the run folder and returns its lines (none when the game wrote no such log). */
export function keepLog(paths, dir, name) {
  const src = path.join(paths.logs, name);
  if (!fs.existsSync(src)) return [];
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.copyFileSync(src, path.join(dir, "logs", name));
  return fs.readFileSync(src, "utf8").split(/\r?\n/);
}
