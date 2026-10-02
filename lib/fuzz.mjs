// Property-based testing in lab games: seeded games, a random sequence of verified actions with turn rolls in
// between, and every invariant checked after each step. A failing sequence is replayed once from the same seed
// to confirm it, then shrunk by delta debugging to a minimal recipe that still fails.
import fs from "node:fs";
import path from "node:path";
import { BenchError } from "./bench.mjs";
import { copiesOf, setModCopies, withLabGame } from "./labtools.mjs";
import { fuzzTargets, pageErrors } from "./engine-sim.mjs";
import { ROLLBACK, checkInvariants, logFailure, sameFailure } from "./fuzz-check.mjs";
import { FUZZ_OPS, generateStep } from "./fuzz-gen.mjs";
import { shrink } from "./fuzz-shrink.mjs";
import { makeRng, seedOf } from "./sim-random.mjs";
import { enabledMods, errorText, refuseBusy } from "./sim-game.mjs";
import { findControl, runsDir, stampNow, writeReport } from "./sim-store.mjs";
import { sourceOf } from "./mods.mjs";

/** @typedef {import("./sim-game.mjs").SimDeps} SimDeps */
/** @typedef {import("./fuzz-check.mjs").Failure} Failure */

async function execStep(d, step) {
  if (step.turns) {
    const rolled = await d.lab.endTurns(step.turns, { log: d.log });
    return { verdict: "ROLLED", detail: `to turn ${rolled.at(-1)?.to ?? "?"}` };
  }
  try {
    const w = await d.bench.write(step.write, { waitMs: 3000 });
    return { verdict: w.verdict, detail: w.description };
  } catch (e) {
    // A refusal is the bench or the game saying no; the run goes on.
    if (e instanceof BenchError) return { verdict: "REFUSED", detail: errorText(e) };
    throw e;
  }
}

async function startContext(d, o) {
  const tail = d.makeTail();
  // Load-time lines: only a rollback counts here (the game's own load noise is not a finding).
  const failure = logFailure(tail.poll().filter((l) => ROLLBACK.has(l.signature)));
  await d.bench.cdp.ensure();
  const pe = await d.bench.cdp.call(pageErrors, { since: 0 }, { timeoutMs: 20000 });
  return { tail, errSeen: pe.total, pid: d.gamePid(), invariants: o.invariants ?? [], failure };
}

async function nextStep(d, o, rng, i) {
  if (o.steps) return o.steps[i];
  const t = await d.bench.cdp.call(fuzzTargets, {}, { timeoutMs: 30000 });
  return generateStep(rng, t, { ops: o.ops, turnChance: o.turnChance });
}

async function stepLoop(d, o, ctx) {
  const rng = makeRng(o.genSeed ?? 1);
  const n = o.steps ? o.steps.length : o.count;
  const executed = [];
  for (let i = 0; i < n; i++) {
    try {
      const step = await nextStep(d, o, rng, i);
      executed.push({ ...step, outcome: await execStep(d, step) });
      const failure = await checkInvariants(d, ctx);
      if (failure) return { executed, failure: { ...failure, step: i + 1 }, error: null };
    } catch (e) {
      if (!d.gamePid()) {
        return { executed, failure: { kind: "game-exited", key: "game-exited", detail: errorText(e), step: i + 1 }, error: null };
      }
      return { executed, failure: null, error: errorText(e) };
    }
  }
  return { executed, failure: null, error: null };
}

async function driveGame(d, o) {
  d.bench.cdp.close(); // re-attach to the new game's page
  const was = d.bench.armed;
  d.bench.armed = true;
  try {
    const ctx = await startContext(d, o);
    if (ctx.failure) return { executed: [], failure: { ...ctx.failure, step: 0 }, error: null };
    return await stepLoop(d, o, ctx);
  } finally {
    d.bench.armed = was;
  }
}

/**
 * One fuzz game: generated steps (`count` with `genSeed`) or a given list (`steps`, for replays).
 * @param {SimDeps} d
 * @param {{ label: string, seed: number, age?: string | null, setMods: () => void, count?: number,
 *   steps?: any[], genSeed?: number, invariants?: any[], ops?: string[], turnChance?: number }} o
 */
export async function fuzzGame(d, o) {
  const paths = d.bench.paths;
  const run = await withLabGame(paths, d, { label: o.label, seed: o.seed, age: o.age ?? null, log: d.log,
    setMods: o.setMods }, async ({ started, error }) => ({ mods: enabledMods(paths, d),
    ...(started ? await driveGame(d, o) : { executed: [], failure: null, error }) }));
  const r = run.result ?? { executed: [], failure: null, error: run.error, mods: [] };
  const crashReports = run.restore?.crashReports ?? [];
  /** @type {Failure | null} */
  let failure = r.failure;
  if (!failure && crashReports.length) {
    failure = { kind: "game-exited", key: "game-exited", detail: `crash report ${path.basename(crashReports[0])}`,
      step: r.executed.length };
  }
  d.bench.log({ kind: "fuzz-game", request: { label: o.label, seed: o.seed, genSeed: o.genSeed ?? null,
    steps: o.steps ? o.steps.length : o.count }, result: { dir: run.dir, started: run.started,
    executed: r.executed.length, failure, error: r.error, crashReports } });
  return { dir: run.dir, started: run.started, executed: r.executed, failure, error: r.error, crashReports,
    mods: r.mods };
}

const stripOutcome = ({ outcome: _o, ...step }) => step;

/** The mod-set switch for --mods: "enabled" leaves the registry alone; a list enables exactly those ids. */
export function modSetter(paths, d, mods) {
  if (mods === "enabled" || !mods?.length) return () => {};
  const rows = d.registryRows(paths.modsDb).filter((r) => sourceOf(r.path, paths).kind !== "official"
    && r.id !== "tower-bench-agent");
  const unknown = mods.filter((id) => !rows.some((r) => r.id === id));
  if (unknown.length) throw new BenchError(`not registered user mods: ${unknown.join(", ")}`);
  const chosen = mods.map((id) => copiesOf(paths, d, id).chosen).filter((c) => c !== null);
  return () => setModCopies(paths, d, rows.map((r) => ({ id: r.id, path: r.path })), chosen);
}

/** A failing sequence as a recipe for `lab run`. */
export function toRecipe(seq, { name, seed, age, failure, invariants = [], mods = null }) {
  const steps = seq.map((s) => (s.turns ? { turns: s.turns } : { write: s.write }));
  const pre = [];
  const post = [];
  let check = `fails when: ${failure.kind} (${failure.key})`;
  if (failure.kind === "invariant") {
    const inv = invariants.find((v) => `invariant:${v.name}` === failure.key);
    if (inv) post.push({ expect: inv.expr });
  } else if (failure.kind === "page-error") {
    pre.push({ eval: `(${pageErrors.toString()})({})` });
    post.push({ expect: `(globalThis.__tbSimErrors?.list ?? []).every((e) => !String(e.file + " " + e.message)`
      + `.includes(${JSON.stringify(`fs://game/${failure.mod}/`)}))` });
  } else {
    check += failure.kind === "game-exited" ? "; the game exits" : `; check the logs (tower-bench logs --mod ${failure.mod ?? "?"})`;
  }
  return { name, seed, age: age ?? undefined, stopOnFail: false, fuzz: { failure, mods, check },
    steps: [...pre, ...(steps.length ? steps : [{ turns: 1 }]), ...post] };
}

function writeRecipe(paths, label, recipe) {
  const dir = path.join(runsDir(paths), "fuzz-recipes");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${label}.json`);
  fs.writeFileSync(file, JSON.stringify(recipe, null, 2));
  return file;
}

export { FUZZ_OPS };

async function confirmAndShrink(d, o, found, budget) {
  if (found.failure.step === 0) {
    return { status: "BEFORE ANY ACTION", detail: "the failure is there at load, before any action: the mod set itself",
      minimal: [] };
  }
  const replay = async (seq) => {
    budget.used += 1;
    const g = await fuzzGame(d, { ...o.game, label: "fuzz-replay", steps: seq });
    return sameFailure(g.failure, found.failure);
  };
  if (budget.used >= budget.max) return { status: "NOT CONFIRMED", detail: "no game left in the budget to replay it", minimal: null };
  d.log(`replaying the ${found.steps.length}-step sequence once from seed ${o.game.seed} to confirm it`);
  if (!(await replay(found.steps))) {
    return { status: "FLAKY", detail: "the same sequence from the same seed did not fail again; not shrunk", minimal: null };
  }
  const s = await shrink(found.steps, replay, { maxTests: budget.max - budget.used, log: d.log });
  return { status: s.exhausted ? "PARTLY SHRUNK" : "SHRUNK", minimal: s.minimal, tests: s.tests,
    detail: `${found.steps.length} step(s) -> ${s.minimal.length}${s.exhausted ? " (budget ran out; smallest found so far)" : ""}` };
}

async function exploreRuns(d, o, budget) {
  const runs = [];
  let found = null;
  for (let k = 1; k <= o.runs && budget.used < budget.max && !found; k++) {
    const genSeed = seedOf(o.game.seed, k);
    budget.used += 1;
    d.log(`run ${k} of ${o.runs}: ${o.steps} step(s), generator seed ${genSeed}`);
    const g = await fuzzGame(d, { ...o.game, label: `fuzz-${k}`, count: o.steps, genSeed });
    runs.push({ run: k, genSeed, dir: g.dir, started: g.started, mods: g.mods, steps: g.executed, failure: g.failure,
      error: g.error });
    if (!g.started) break; // the game itself would not start: nothing to fuzz
    if (g.failure) found = { run: k, genSeed, failure: g.failure, steps: g.executed.map(stripOutcome) };
  }
  return { runs, found };
}

function writeRecipes(paths, o, found, shrunk) {
  if (!found) return null;
  const stamp = stampNow();
  const meta = { seed: o.seed, age: o.age, failure: found.failure, invariants: o.invariants ?? [], mods: o.mods };
  const minimal = shrunk?.minimal?.length ? shrunk.minimal : null;
  return {
    failing: writeRecipe(paths, `fuzz-${stamp}-failing`, toRecipe(found.steps, { ...meta, name: "fuzz-failing" })),
    minimal: minimal && writeRecipe(paths, `fuzz-${stamp}-minimal`, toRecipe(minimal, { ...meta, name: "fuzz-minimal" })),
  };
}

function determinismOf(paths, d, o, runs) {
  if (!runs.length) return { verdict: "UNCONTROLLED", detail: "no game ran" };
  const scope = { seed: o.seed, age: o.age ?? null, mods: runs[0].mods ?? [], version: d.bench.version ?? null };
  const c = findControl(paths, scope);
  return c ? { verdict: c.verdict, lastTurn: c.lastTurn, at: c.at, source: c.source }
    : { verdict: "UNCONTROLLED", detail: "no determinism control for this seed and mod set; a failure is replayed once "
      + "from the same seed before it is shrunk" };
}

function fuzzPlan(paths, d, o) {
  const mods = o.mods ?? "enabled";
  const game = { seed: o.seed, age: o.age ?? null, setMods: modSetter(paths, d, mods),
    invariants: o.invariants ?? [], ops: o.ops ?? FUZZ_OPS, turnChance: o.turnChance };
  return { mods, game, budget: { used: 0, max: o.budget ?? o.runs + 12 } };
}

function verdictOf(found, runs) {
  if (found) return `FAILS: ${found.failure.kind}`;
  return runs.some((r) => !r.started) ? "NO GAME" : "NO FAILURE";
}

/**
 * @param {SimDeps} d
 * @param {{ mods?: "enabled" | string[], seed: number, age?: string | null, runs: number, steps: number,
 *   invariants?: any[], budget?: number, ops?: string[], turnChance?: number }} o
 */
export async function runFuzz(d, o) {
  const paths = d.bench.paths;
  const warnings = refuseBusy(paths, d);
  const { mods, game, budget } = fuzzPlan(paths, d, o);
  const { runs, found } = await exploreRuns(d, { ...o, game }, budget);
  const shrunk = found ? await confirmAndShrink(d, { game }, found, budget) : null;
  const recipes = writeRecipes(paths, { ...o, mods }, found, shrunk);
  const verdict = verdictOf(found, runs);
  const record = { verdict, mods, seed: o.seed, age: game.age, requestedRuns: o.runs, steps: o.steps, budget,
    invariants: game.invariants.map((v) => v.name), warnings, failure: found ? found.failure : null,
    failingRun: found ? found.run : null,
    shrink: shrunk && { ...shrunk, minimal: undefined, minimalSteps: shrunk.minimal },
    recipes, determinism: determinismOf(paths, d, o, runs), runs };
  const report = writeReport(paths, "fuzz", record);
  d.bench.log({ kind: "fuzz", request: { seed: o.seed, runs: o.runs, steps: o.steps, mods },
    result: { verdict, games: budget.used, report, minimal: recipes ? recipes.minimal : null } });
  return { ...record, report };
}
