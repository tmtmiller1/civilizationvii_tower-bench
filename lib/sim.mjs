// Differential simulation: the same seeded game twice, compared turn by turn. `sim repeat` runs it twice with
// the same mods (the determinism control); `sim diff` runs it with a mod off and then on, and calls the first
// difference the mod's doing only when a control for that seed and mod set stayed identical at least that far.
import { BenchError } from "./bench.mjs";
import { copiesOf, setModCopies } from "./labtools.mjs";
import { attribute, compareSeries, repeatVerdict } from "./sim-compare.mjs";
import { plannedMods, playGame, refuseBusy } from "./sim-game.mjs";
import { findControl, recordControl, writeReport } from "./sim-store.mjs";

/** @typedef {import("./sim-game.mjs").SimDeps} SimDeps */

const gameSummary = (g) => ({ dir: g.dir, started: g.started, sampled: g.samples.length, error: g.error,
  crashReports: g.crashReports, mods: g.mods, firstTurn: g.samples[0]?.turn ?? null,
  lastTurn: g.samples.at(-1)?.turn ?? null });

function keepControl(paths, r, report) {
  recordControl(paths, { seed: r.seed, age: r.age, mods: r.mods, version: r.version, turns: r.turns,
    firstTurn: r.curve[0]?.turn ?? null, lastTurn: r.lastTurn, verdict: r.verdict, divergedAt: r.divergedAt,
    what: r.first?.lines.slice(0, 5) ?? [], report });
}

function repeatRecord(d, o, games, warnings) {
  const cmp = compareSeries(games[0].samples, games[1].samples, { labels: ["run 1", "run 2"] });
  const v = repeatVerdict(cmp);
  return { seed: o.seed, age: o.age ?? null, turns: o.turns, version: d.bench.version ?? null, mods: games[0].mods,
    sameMods: JSON.stringify(games[0].mods) === JSON.stringify(games[1].mods), ...v, first: cmp.first,
    compared: cmp.compared, lastTurn: cmp.lastTurn, missing: cmp.missing, curve: cmp.curve, warnings,
    games: games.map(gameSummary) };
}

/**
 * Two games with the same seed and the same mods, compared. Records the verdict as a determinism control.
 * @param {SimDeps} d
 * @param {{ seed: number, turns: number, age?: string | null, setMods?: () => void, label?: string,
 *   checkBusy?: boolean }} o
 */
export async function runSimRepeat(d, o) {
  const paths = d.bench.paths;
  const warnings = o.checkBusy === false ? [] : refuseBusy(paths, d);
  const setMods = o.setMods ?? (() => {});
  const games = [];
  for (const k of [1, 2]) {
    d.log(`repeat ${k} of 2: seed ${o.seed}, ${o.turns} turn(s)`);
    games.push(await playGame(d, { tool: "sim repeat", label: `sim-repeat-${k}`, seed: o.seed, age: o.age,
      turns: o.turns, world: true, setMods }));
  }
  const record = repeatRecord(d, o, games, warnings);
  const report = writeReport(paths, "sim-repeat", record);
  if (record.sameMods && record.compared) keepControl(paths, record, report);
  d.bench.log({ kind: "sim-repeat", request: { seed: o.seed, age: record.age, turns: o.turns },
    result: { verdict: record.verdict, detail: record.detail, report } });
  return { ...record, report };
}

function armMods(paths, d, copies) {
  const others = copies.all.filter((c) => c.path !== copies.chosen.path);
  return {
    off: () => setModCopies(paths, d, copies.all, []),
    on: () => setModCopies(paths, d, others, [copies.chosen]),
  };
}

async function controlFor(d, o, { copies, set }) {
  const paths = d.bench.paths;
  const scope = { seed: o.seed, age: o.age ?? null, mods: plannedMods(paths, d, copies, false),
    version: d.bench.version ?? null };
  const found = findControl(paths, scope);
  if (found || !o.runControl) return { control: found, ran: false };
  d.log("no determinism control for this seed and mod set; running one first (two games, the mod off)");
  await runSimRepeat(d, { seed: o.seed, age: o.age, turns: o.turns, setMods: set.off, checkBusy: false });
  return { control: findControl(paths, scope), ran: true };
}

/**
 * The mod off, then on, from the same seed; the first turn they differ and a per-turn divergence curve.
 * @param {SimDeps} d
 * @param {{ modId: string, seed: number, turns: number, age?: string | null, runControl?: boolean }} o
 */
export async function runSimDiff(d, o) {
  const paths = d.bench.paths;
  const warnings = refuseBusy(paths, d);
  const copies = copiesOf(paths, d, o.modId);
  if (!copies.chosen) throw new BenchError(`no mod "${o.modId}" in the registry (official content cannot be switched)`);
  const set = armMods(paths, d, copies);
  const { control, ran } = await controlFor(d, o, { copies, set });
  const games = {};
  for (const arm of /** @type {const} */ (["off", "on"])) {
    d.log(`mod ${arm}: seed ${o.seed}, ${o.turns} turn(s)`);
    games[arm] = await playGame(d, { tool: "sim diff", label: `sim-diff-${arm}`, seed: o.seed, age: o.age,
      turns: o.turns, world: true, setMods: set[arm] });
  }
  const cmp = compareSeries(games.off.samples, games.on.samples, { labels: ["off", "on"] });
  const cause = attribute(cmp.first, control);
  const record = { mod: o.modId, copy: copies.chosen.path, seed: o.seed, age: o.age ?? null, turns: o.turns,
    version: d.bench.version ?? null, verdict: cause.verdict, detail: cause.detail, first: cmp.first,
    compared: cmp.compared, missing: cmp.missing, control: control ?? null, controlRanNow: ran, warnings,
    curve: cmp.curve, games: { off: gameSummary(games.off), on: gameSummary(games.on) } };
  const report = writeReport(paths, "sim-diff", record);
  d.bench.log({ kind: "sim-diff", request: { mod: o.modId, seed: o.seed, age: o.age ?? null, turns: o.turns },
    result: { verdict: cause.verdict, firstTurn: cmp.first?.turn ?? null, report } });
  return { ...record, report };
}
