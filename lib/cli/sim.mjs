import path from "node:path";
import { BenchError } from "../bench.mjs";
import { parseSeeds, runArena } from "../arena.mjs";
import { loadInvariants } from "../fuzz-check.mjs";
import { runFuzz } from "../fuzz.mjs";
import { runSimDiff, runSimRepeat } from "../sim.mjs";
import { errorText, refuseBusy, simDeps } from "../sim-game.mjs";
import { listReports, readControls, readReport } from "../sim-store.mjs";
import { out } from "./common.mjs";

/** @typedef {import("./common.mjs").Ctx} Ctx */

/** A positive whole number from an option, or the default. */
function count(v, def, name) {
  if (v === undefined || v === null || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new BenchError(`--${name} must be a positive whole number`);
  return n;
}

function seedOpt(v) {
  if (v === undefined || v === null || v === "") return 4242;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new BenchError("--seed must be a whole number, 0 or more");
  return n;
}
const opts = (/** @type {any} */ opt) => opt;
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : "-");

function needYes(opt, what) {
  if (!opt.yes) throw new BenchError(`${what}; your saves, settings and registry are restored after each game. Add --yes`);
}

/** Runs one long job with its own lab session, closed afterwards so the process can exit. */
async function withDeps(bench, tag, fn) {
  const d = simDeps(bench, { log: (m) => out(`[${tag}] ${m}`) });
  try {
    return await fn(d);
  } catch (e) {
    throw e instanceof BenchError ? e : new BenchError(errorText(e));
  } finally {
    d.lab.cdp.close();
  }
}

function printCurve(curve) {
  if (!curve?.length) return;
  out("  turn   plots  units  cities  figures");
  for (const c of curve) {
    out(`  ${String(c.turn).padStart(4)}  ${String(c.plots ?? "-").padStart(6)} ${String(c.units ?? "-").padStart(6)} `
      + `${String(c.cities ?? "-").padStart(7)} ${String(c.numbers).padStart(8)}`);
  }
}

function printGames(games) {
  for (const [label, g] of Object.entries(games)) {
    const turns = g.firstTurn == null ? "no turns sampled" : `turns ${g.firstTurn}-${g.lastTurn}`;
    out(`  ${label}: ${turns}${g.error ? `; ${g.error}` : ""}${g.crashReports?.length ? `; CRASH ${g.crashReports[0]}` : ""}`);
  }
}

function printSim(r) {
  out(`\n${r.mod ? `${r.mod}: ` : ""}${r.verdict}`);
  out(`  ${r.detail}`);
  if (r.first) {
    out(`  first difference at turn ${r.first.turn}:`);
    for (const l of r.first.lines) out(`    ${l}`);
  }
  if (r.control) out(`  control: ${r.control.verdict} through turn ${r.control.lastTurn} (${r.control.source}, ${r.control.at})`);
  printGames(Array.isArray(r.games) ? Object.fromEntries(r.games.map((g, i) => [`run ${i + 1}`, g])) : r.games);
  printCurve(r.curve);
  out(`  report: ${r.report}`);
}

const SIM_SUBS = {
  diff: async ({ bench, opt }, [modId]) => {
    if (!modId) throw new BenchError("which mod? sim diff <mod-id> --yes");
    needYes(opt, "sim diff starts two seeded test games (the mod off, then on)");
    const r = await withDeps(bench, "sim", (d) => runSimDiff(d, { modId, seed: seedOpt(opt.seed),
      turns: count(opt.turns, 30, "turns"), age: opt.age ?? null, runControl: !!opts(opt).control }));
    return opt.json ? out(r) : printSim(r);
  },
  repeat: async ({ bench, opt }) => {
    needYes(opt, "sim repeat starts the same seeded test game twice");
    const r = await withDeps(bench, "sim", (d) => runSimRepeat(d, { seed: seedOpt(opt.seed),
      turns: count(opt.turns, 10, "turns"), age: opt.age ?? null }));
    return opt.json ? out(r) : printSim(r);
  },
  controls: ({ paths, opt }) => {
    const all = readControls(paths);
    if (opt.json) return out(all);
    if (!all.length) return out("no determinism controls yet: sim repeat --yes [--seed N] [--turns 10]");
    for (const c of all) {
      out(`${c.verdict.padEnd(26)} seed ${c.seed}${c.age ? ` ${c.age}` : ""}, turns ${c.firstTurn ?? "?"}-`
        + `${c.lastTurn ?? "?"}, ${c.mods.length} mod(s), game ${c.version ?? "?"} (${c.source}, ${c.at})`);
    }
    return undefined;
  },
  runs: ({ paths, opt }) => {
    const list = listReports(paths, { limit: count(opt.limit, 30, "limit") });
    if (opt.json) return out(list);
    if (!list.length) return out("no sim, fuzz or arena reports yet");
    for (const r of list) out(`${r.name}  ${r.mod ?? ""} ${r.verdict ?? ""}`.trimEnd());
    return undefined;
  },
  show: ({ paths, opt }, [name]) => {
    let r;
    try { r = readReport(paths, name); } catch (e) { throw new BenchError(errorText(e), 404); }
    if (opt.json || !String(name).startsWith("sim-")) return out(r);
    return printSim({ ...r, report: name });
  },
};

/** @param {Ctx} ctx @param {string[]} args */
function simCommand(ctx, args) {
  const [sub, ...rest] = args;
  if (!Object.hasOwn(SIM_SUBS, sub)) throw new BenchError("sim diff <mod-id> | repeat | controls | runs | show <name>");
  return SIM_SUBS[sub](ctx, rest);
}

function printFuzz(r) {
  out(`\nfuzz: ${r.verdict} (${r.budget.used} of ${r.budget.max} game(s) used)`);
  for (const run of r.runs) {
    out(`  run ${run.run}: ${run.steps.length} step(s)${run.failure ? `, FAILED at step ${run.failure.step}: `
      + `${run.failure.detail}` : run.error ? `; ${run.error}` : ", invariants held"}`);
  }
  if (r.shrink) out(`  ${r.shrink.status}: ${r.shrink.detail}`);
  out(`  determinism: ${r.determinism.verdict}${r.determinism.detail ? ` (${r.determinism.detail})` : ""}`);
  if (r.recipes?.minimal) out(`  minimal recipe: tower-bench lab run ${r.recipes.minimal}`);
  else if (r.recipes?.failing) out(`  failing recipe: tower-bench lab run ${r.recipes.failing}`);
  out(`  report: ${r.report}`);
}

/** @param {Ctx} ctx */
async function fuzzCommand({ bench, opt }) {
  const o = opts(opt);
  needYes(opt, "fuzz starts seeded test games and changes them with random verified actions");
  const mods = !o.mods || o.mods === "enabled" ? "enabled" : String(o.mods).split(",").map((s) => s.trim()).filter(Boolean);
  let invariants = [];
  try { invariants = loadInvariants(o.invariants); } catch (e) { throw new BenchError(errorText(e)); }
  const runs = count(o.runs, 20, "runs");
  const r = await withDeps(bench, "fuzz", (d) => runFuzz(d, { mods, seed: seedOpt(o.seed), age: o.age ?? null, runs,
    steps: count(o.steps, 15, "steps"), invariants, budget: count(o.budget, runs + 12, "budget") }));
  process.exitCode = r.failure ? 1 : 0;
  return opt.json ? out(r) : printFuzz(r);
}

function printArena(r) {
  out(`\n${r.mod}: ${r.seeds.length} seed(s) x ${r.turns} turn(s), off and on`);
  out(`  ${r.caveat}`);
  out(`  determinism controls: ${r.determinism.deterministic} of ${r.determinism.seeds} seed(s) repeat this far`);
  out("  effect of the mod at the last turn (mean over AI majors; on minus off, 95% bootstrap interval):");
  for (const [m, e] of Object.entries(r.effects)) {
    out(`    ${m.padEnd(11)} ${String(r1(e.est)).padStart(9)}  [${r1(e.lo)}, ${r1(e.hi)}]  n=${e.pairs}${e.significant ? "  REAL" : ""}`);
  }
  for (const arm of ["off", "on"]) {
    const top = r.arms[arm].leadByLeader.slice(0, 5).map((x) => `${x.key} ${x.leads}/${x.games}`).join(", ");
    out(`  led at the end, mod ${arm}: ${top || "none"}`);
  }
  for (const f of r.failed) out(`  seed ${f.seed} ${f.arm}: ${f.error ?? "no turns"}`);
  out(`  report: ${r.report}`);
}

/** @param {Ctx} ctx @param {string[]} args */
async function arenaCommand({ bench, opt }, [modId]) {
  const o = opts(opt);
  if (!modId) throw new BenchError("which mod? arena <mod-id> --yes");
  needYes(opt, "arena starts two seeded test games per seed (the mod off, then on)");
  const games = count(o.games, 10, "games");
  const seed = seedOpt(o.seed);
  const seeds = o.seeds ? parseSeeds(o.seeds) : Array.from({ length: games }, (_, i) => seed + i);
  const r = await withDeps(bench, "arena", (d) => runArena(d, { modId, seeds, turns: count(o.turns, 100, "turns"),
    age: o.age ?? null }));
  return opt.json ? out(r) : printArena(r);
}

/** @type {Record<string, import("./common.mjs").Handler>} */
export const SIM_COMMANDS = {
  sim: simCommand,
  fuzz: fuzzCommand,
  arena: arenaCommand,
};

export const SIM_HELP = `  sim diff <mod-id> --yes [--seed N] [--turns 30] [--age AGE_X] [--control]
                                       the same seeded game with the mod off, then on; the first turn
                                       they differ (plots, units, settlements, player figures) and a
                                       per-turn divergence curve. Called the mod's doing only when a
                                       determinism control passed (--control runs one if missing)
  sim repeat --yes [--seed N] [--turns 10] [--age AGE_X]
                                       the determinism control: one seed twice with the same mods
  sim controls | runs | show <name>    stored controls; saved sim, fuzz and arena reports
  fuzz --yes [--mods enabled|a,b] [--seed N] [--runs 20] [--steps 15] [--invariants FILE] [--budget N]
                                       random verified actions and turn rolls in seeded test games,
                                       invariants checked after each step; a failure is shrunk to a
                                       minimal recipe for "lab run"
  arena <mod-id> --yes [--games 10] [--turns 100] [--seeds a..b]
                                       seeded games with the mod off and on: per-civ lead rates, mean
                                       curves and the mod's effect with bootstrap intervals`;

// ---- Server routes ----

/** @type {{ current: any, last: any }} */
const job = { current: null, last: null };

function requireArmed(bench) {
  if (!bench.armed) throw new BenchError("arm writes first: this starts test games and switches the registry", 409);
}

const JOB_RUNNERS = {
  diff: (d, b) => runSimDiff(d, { modId: String(b.mod ?? ""), seed: seedOpt(b.seed), turns: count(b.turns, 30, "turns"),
    age: b.age || null, runControl: !!b.control }),
  repeat: (d, b) => runSimRepeat(d, { seed: seedOpt(b.seed), turns: count(b.turns, 10, "turns"), age: b.age || null }),
  fuzz: (d, b) => runFuzz(d, { mods: Array.isArray(b.mods) && b.mods.length ? b.mods.map(String) : "enabled",
    seed: seedOpt(b.seed), age: b.age || null, runs: count(b.runs, 20, "runs"), steps: count(b.steps, 15, "steps"),
    invariants: Array.isArray(b.invariants) ? b.invariants : [], budget: b.budget ? count(b.budget, 1, "budget") : undefined }),
  arena: (d, b) => runArena(d, { modId: String(b.mod ?? ""), turns: count(b.turns, 100, "turns"), age: b.age || null,
    seeds: b.seeds ? parseSeeds(b.seeds) : Array.from({ length: count(b.games, 10, "games") }, (_, i) => seedOpt(b.seed) + i) }),
};

// Long runs go to the background: the page polls /api/sim/job and the report list.
function startJob(bench, b) {
  requireArmed(bench);
  if (job.current) throw new BenchError(`a ${job.current.kind} run is already going`, 409);
  const kind = String(b.kind ?? "");
  if (!Object.hasOwn(JOB_RUNNERS, kind)) throw new BenchError("kind must be diff, repeat, fuzz or arena");
  if ((kind === "diff" || kind === "arena") && !b.mod) throw new BenchError("which mod?");
  const j = { kind, startedAt: new Date().toISOString(), lines: /** @type {string[]} */ ([]), done: false,
    error: /** @type {string | null} */ (null), report: /** @type {string | null} */ (null) };
  const d = simDeps(bench, { log: (m) => { j.lines.push(m); if (j.lines.length > 500) j.lines.shift(); } });
  refuseBusy(bench.paths, d);
  job.current = j;
  JOB_RUNNERS[kind](d, b)
    .then((r) => { j.report = path.basename(r.report); }, (e) => { j.error = errorText(e); })
    .finally(() => { j.done = true; d.lab.cdp.close(); job.last = j; job.current = null; });
  return { started: true, kind };
}

export const SIM_ROUTES = {
  "GET /api/sim/runs": (bench, _req, q) => listReports(bench.paths, q.get("kind") ? { kinds: [String(q.get("kind"))] } : {}),
  "GET /api/sim/run": (bench, _req, q) => {
    try { return readReport(bench.paths, q.get("name")); } catch (e) { throw new BenchError(errorText(e), 404); }
  },
  "GET /api/sim/controls": (bench) => readControls(bench.paths),
  "GET /api/sim/job": () => job.current ?? job.last ?? null,
  "POST /api/sim/start": async (bench, _req, _q, readBody) => startJob(bench, await readBody()),
};
