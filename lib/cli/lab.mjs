import fs from "node:fs";
import path from "node:path";
import { BenchError } from "../bench.mjs";
import { bisect } from "../bisect.mjs";
import { Lab, applyModSet, candidateMods, gamePid, preflight } from "../lab.mjs";
import { runRecipe } from "../recipes.mjs";
import { errorText, loadRecipe, num, out, stampNow } from "./common.mjs";

/** @typedef {import("./common.mjs").Ctx} Ctx */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function printRestore(rep) {
  out(`[lab] restored: ${rep.restored.join(", ") || "nothing"}`);
  if (rep.moved.length) out(`[lab] what the test game wrote was moved aside, not deleted: ${rep.moved.join(", ")}`);
  for (const r of rep.registry) out(`[lab] registry: ${r.id} ${r.note ?? `Disabled ${r.from} -> ${r.to}`}`);
  if (!rep.registry.length) out("[lab] registry: unchanged");
  for (const f of rep.crashReports) out(`[lab] CRASH REPORT: ${f}`);
}

/** @param {Ctx["paths"]} paths @param {Lab} lab */
async function labStart(paths, lab, { seed, age, say }) {
  if (lab.current) throw new BenchError(`a test run is already in progress (${lab.current.dir}); "lab stop" first`);
  const pf = preflight(paths);
  for (const w of pf.warnings) say(`warning: ${w}`);
  if (pf.problems.length) throw new BenchError(pf.problems.join("; "));
  const dir = path.join(lab.root, stampNow());
  const b = lab.backup(dir);
  say(`backed up ${b.files.join(", ")} and ${b.registryRows} registry rows to ${dir}`);
  lab.setCurrent({ dir, startedAt: new Date().toISOString(), seed: seed ?? null, age: age ?? null });
  try {
    const r = await lab.startNewGame({ seed, age, log: say });
    lab.setCurrent({ ...lab.current, pid: r.pid, setup: r.setup });
    return r;
  } catch (e) {
    say(`start failed: ${errorText(e)}. Quitting and restoring.`);
    await lab.quit({ log: say });
    printRestore(lab.restore(dir));
    lab.setCurrent(null);
    throw new BenchError("lab start failed; your saves, settings and registry are restored");
  }
}

/** @param {Lab} lab */
async function labStop(lab, say) {
  const cur = lab.current;
  if (!cur) throw new BenchError("no test run in progress");
  const q = await lab.quit({ log: say, onlyPid: cur.pid ?? null });
  if (!q.wasRunning) {
    say("the game had already exited; waiting 50 s for a crash report to land");
    await wait(50000);
  } else {
    say(`game ${q.pid} quit`);
  }
  const rep = lab.restore(cur.dir);
  printRestore(rep);
  lab.setCurrent(null);
  return rep;
}

function blockersNote(rolled) {
  if (!rolled.some((r) => r.blocker)) return "";
  return `; blockers seen: ${[...new Set(rolled.map((r) => r.blocker).filter(Boolean))].join(", ")}`;
}

/** @param {Ctx} ctx @param {Lab} lab */
async function labRun({ bench, paths, opt }, lab, file, say) {
  const recipe = loadRecipe(file);
  await labStart(paths, lab, { seed: num(opt.seed) ?? recipe.seed, age: opt.age ?? recipe.age, say });
  bench.armed = true;
  let r;
  try {
    r = await runRecipe(bench, recipe, { endTurns: (n) => lab.endTurns(n, { log: say }), log: say });
  } finally {
    await labStop(lab, say);
  }
  process.exitCode = r.passed ? 0 : 1;
  return say(r.passed ? "recipe passed" : "recipe FAILED");
}

const LAB_SUBS = {
  status: (_ctx, lab) => {
    const cur = lab.current;
    out(cur ? `test run ${cur.dir}, started ${cur.startedAt}${cur.seed != null ? `, seed ${cur.seed}` : ""}` : "no test run in progress");
    return out(`game ${gamePid() ? `running (pid ${gamePid()})` : "not running"}`);
  },
  start: async ({ paths, opt }, lab, _more, say) => {
    const r = await labStart(paths, lab, { seed: num(opt.seed), age: opt.age, say });
    return say(`ready at turn ${r.turn}. Use the bench as normal; "lab stop" restores everything.`);
  },
  run: (ctx, lab, more, say) => labRun(ctx, lab, more[0], say),
  turns: async (_ctx, lab, more, say) => {
    const cur = lab.current;
    // Never end turns in a game the lab did not start: that could be the player's campaign.
    if (!cur?.pid || gamePid() !== cur.pid) throw new BenchError("the running game is not this lab's test game");
    const rolled = await lab.endTurns(Number(more[0] ?? 1), { log: say });
    return say(`${rolled.length} turn(s) ended${blockersNote(rolled)}`);
  },
  stop: async (_ctx, lab, _more, say) => {
    await labStop(lab, say);
    return undefined;
  },
};

/** @param {Ctx} ctx @param {string[]} args */
async function labCommand(ctx, args) {
  const [sub, ...more] = args;
  const lab = new Lab(ctx.paths);
  const say = (m) => out(`[lab] ${m}`);
  // The lab holds its own debugger socket; left open it keeps the process alive after the command is done.
  try {
    if (!Object.hasOwn(LAB_SUBS, sub)) throw new BenchError("lab start|turns|stop|status");
    return await LAB_SUBS[sub](ctx, lab, more, say);
  } finally {
    lab.cdp.close();
  }
}

function recipeSettings(opt, recipe) {
  return {
    turns: num(opt.turns) ?? (recipe ? null : 20),
    seed: num(opt.seed) ?? recipe?.seed ?? 4242,
    age: opt.age ?? recipe?.age,
    replicates: num(opt.replicates) ?? 2,
  };
}

/** @param {Ctx} ctx */
function bisectPlan({ paths, opt }) {
  const recipe = opt.recipe ? loadRecipe(opt.recipe) : null;
  const settings = recipeSettings(opt, recipe);
  const all = candidateMods(paths.modsDb);
  const wanted = opt.mods ? new Set(opt.mods.split(",")) : null;
  const candidates = wanted ? all.filter((c) => wanted.has(c.id)) : all;
  if (!candidates.length) throw new BenchError("no enabled, non-official mods to bisect over");
  return { recipe, ...settings, candidates };
}

const failedStep = (results) => results.find((x) => !("ok" in x && x.ok))?.step;

/** @param {Ctx} ctx @param {Lab} lab */
async function trialBody({ bench }, lab, plan) {
  if (!plan.recipe) {
    await lab.endTurns(plan.turns);
    return { failed: false, detail: "" };
  }
  bench.armed = true;
  const r = await runRecipe(bench, plan.recipe, { endTurns: (n) => lab.endTurns(n) });
  return r.passed ? { failed: false, detail: "" } : { failed: true, detail: `recipe failed at step ${failedStep(r.results)}` };
}

/** @param {Ctx} ctx @param {Lab} lab */
async function playTrial(ctx, lab, plan) {
  let started = false;
  try {
    await lab.startNewGame({ seed: plan.seed, age: plan.age });
    started = true;
    lab.setCurrent({ ...lab.current, pid: gamePid() });
    return await trialBody(ctx, lab, plan);
  } catch (e) {
    return started ? { failed: false, detail: errorText(e) } : { failed: true, detail: `the game did not start: ${errorText(e)}` };
  }
}

/** @param {Ctx} ctx @param {Lab} lab */
function makeTrial(ctx, lab, plan) {
  return async (enabledIds) => {
    const dir = path.join(lab.root, `bisect-${stampNow()}`);
    lab.backup(dir);
    lab.setCurrent({ dir, startedAt: new Date().toISOString(), seed: plan.seed, age: plan.age ?? null, bisect: true });
    let outcome = { failed: false, detail: "" };
    try {
      applyModSet(ctx.paths.modsDb, plan.candidates, enabledIds);
      outcome = await playTrial(ctx, lab, plan);
      if (!gamePid()) {
        outcome = { failed: true, detail: outcome.detail || "the game exited" };
        await wait(50000);
      }
    } finally {
      await lab.quit().catch((e) => {
        throw new BenchError(`${errorText(e)}; your files and mods are not restored yet: run "tower-bench lab stop"`);
      });
      const rep = lab.restore(dir);
      lab.setCurrent(null);
      if (rep.crashReports.length) outcome = { failed: true, detail: `crash report ${path.basename(rep.crashReports[0])}` };
    }
    return outcome;
  };
}

/** @param {Ctx} ctx */
async function bisectCommand(ctx) {
  const { opt } = ctx;
  const lab = new Lab(ctx.paths);
  const say = (m) => out(`[bisect] ${m}`);
  if (lab.current) throw new BenchError(`a test run is in progress (${lab.current.dir}); "lab stop" first`);
  const pf = preflight(ctx.paths);
  if (pf.problems.length) throw new BenchError(pf.problems.join("; "));
  const plan = bisectPlan(ctx);
  const { seed, age, turns, recipe, replicates, candidates } = plan;
  const what = recipe ? `recipe ${recipe.name ?? opt.recipe}` : `${turns} turns`;
  say(`${candidates.length} candidate mods, seed ${seed}, ${replicates} replicate(s) per configuration, ${what}`);
  const trial = makeTrial(ctx, lab, plan);
  const result = await bisect({ candidates: candidates.map((c) => c.id), trial, replicates, log: say });
  const report = path.join(lab.root, `bisect-${stampNow()}.json`);
  const record = { seed, age, turns, recipe: opt.recipe ?? null, replicates, ...result };
  fs.writeFileSync(report, JSON.stringify(record, null, 2));
  say(`${result.verdict}${result.culprit ? `: ${result.culprit}` : ""}. ${result.detail}`);
  say(`${result.trials.length} game(s) run; report at ${report}`);
  process.exitCode = result.verdict === "ISOLATED" ? 0 : 1;
}

/** @type {Record<string, import("./common.mjs").Handler>} */
export const LAB_COMMANDS = {
  lab: labCommand,
  bisect: bisectCommand,
};
