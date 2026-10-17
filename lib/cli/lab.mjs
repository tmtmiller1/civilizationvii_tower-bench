import fs from "node:fs";
import path from "node:path";
import { BenchError } from "../bench.mjs";
import { bisect } from "../bisect.mjs";
import { Lab, applyModSet, candidateMods, gamePid, preflight } from "../lab.mjs";
import { applyQuickOptions, pageDriveStart, pageDriveStatus, pageDriveStop, pagePopups, pageReady, pageSetupCheck, parseSetup, CONTEXT_MODULE, QUEUE_MODULE } from "../engine-lab.mjs";
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

/**
 * @param {Ctx["paths"]} paths @param {Lab} lab
 * @param {{ seed?: number, age?: string, setup?: any, quick?: boolean, say: (m: string) => void }} o
 */
async function labStart(paths, lab, { seed, age, setup = null, quick = false, say }) {
  if (lab.current) throw new BenchError(`a test run is already in progress (${lab.current.dir}); "lab stop" first`);
  const pf = preflight(paths);
  for (const w of pf.warnings) say(`warning: ${w}`);
  if (pf.problems.length) throw new BenchError(pf.problems.join("; "));
  const dir = path.join(lab.root, stampNow());
  const b = lab.backup(dir);
  say(`backed up ${b.files.join(", ")} and ${b.registryRows} registry rows to ${dir}`);
  if (quick) applyQuickOptions(paths.user).forEach((line) => say(`quick: ${line}`));
  lab.setCurrent({ dir, startedAt: new Date().toISOString(), seed: seed ?? null, age: age ?? null, setup, quick });
  try {
    const r = await lab.startNewGame({ seed, age, setup, log: say });
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

// Never drive a game the lab did not start: that could be the player's campaign.
function requireLabGame(lab) {
  const cur = lab.current;
  if (!cur?.pid || gamePid() !== cur.pid) throw new BenchError("the running game is not this lab's test game");
}

const splitList = (s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);

async function reportSetup(lab, setup, say) {
  await lab.cdp.ensure();
  const check = await lab.cdp.call(pageSetupCheck, { setup });
  for (const [k, v] of Object.entries(check)) {
    if (v !== "ok") say(`warning: setup ${k}: ${v} (asked ${setup.game[k] ?? setup.player[k]})`);
  }
  say(`setup in the game: ${Object.entries(check).map(([k, v]) => `${k} ${v}`).join(", ")}`);
}

// The driver's state when it stops for --stop-before-age-end (pageDriveStart).
const NEAR_AGE_END = "near the age's end";

function ageEndMargin(opt) {
  const margin = num(opt["stop-before-age-end"]) ?? null;
  if (margin !== null && !(Number.isInteger(margin) && margin >= 0)) {
    throw new BenchError("--stop-before-age-end takes a whole number of age progress points");
  }
  return margin;
}

function driveConfig(opt, more) {
  const turns = Number(more[0] ?? opt.turns ?? 10);
  if (!Number.isInteger(turns) || turns < 1) {
    throw new BenchError("lab drive <turns> [--every 5] [--sample file.js] [--settle ms] [--timeout s] [--stop-before-age-end points]");
  }
  return {
    stopBeforeAgeEnd: ageEndMargin(opt),
    turns, every: num(opt.every) ?? 5, sample: opt.sample ? fs.readFileSync(opt.sample, "utf8") : null,
    settleMs: num(opt.settle) ?? 1000, popups: !opt["no-popups"], keep: splitList(opt.keep),
    stuckMs: (num(opt.timeout) ?? 240) * 1000, queueModule: QUEUE_MODULE,
  };
}

// Follows one page's driver until it stops or the page goes (a new age rebuilds it). Returns its last status.
async function followDriver(lab, logFile) {
  let seen = 0;
  let st = null;
  for (let gone = 0; gone <= 12;) {
    await wait(5000);
    if (!gamePid()) throw new BenchError(`the game exited during "lab drive"; run "lab stop" to restore`);
    const now = await lab.cdp.ensure()
      .then(() => lab.cdp.call(pageDriveStatus, { since: seen })).catch(() => undefined);
    if (now === undefined) continue; // the page is busy (an AI turn or a new age loading)
    if (now === null) {
      gone++;
      if ((await lab.scope()) === "game" && gone > 1) return { ...st, state: "page gone" };
      continue;
    }
    st = now;
    for (const l of st.lines) out(l);
    if (st.lines.length) fs.appendFileSync(logFile, `${st.lines.join("\n")}\n`);
    seen = st.logLength;
    if (st.state !== "running") return st;
  }
  throw new BenchError("the driver is gone from the page and no new game page came up");
}

// Runs the in-page driver and follows it from one debugger socket. When a new age takes the driver with the
// old page, it's put back for the turns that are left; turns finished after the last status read are lost
// from the count. With --stop-before-age-end a new age ends the drive instead: the age ended inside it.
async function labDrive(lab, opt, more, say) {
  requireLabGame(lab);
  const cfg = driveConfig(opt, more);
  const logFile = path.join(lab.current.dir, "drive.log");
  /** @type {{ t0: number, closed: Record<string, number>, total: number, st: any }} */
  const run = { t0: Date.now(), closed: {}, total: 0, st: null };
  while (run.total < cfg.turns && (!run.st || run.st.state === "page gone")) {
    await lab.waitFor("the game page", async () => (await lab.scope()) === "game", 360000, 2000);
    await lab.cdp.ensure();
    await lab.waitFor("the game to be ready", () => lab.cdp.call(pageReady), 240000, 1000);
    const s = await lab.cdp.call(pageDriveStart, { ...cfg, turns: cfg.turns - run.total });
    say(`driving ${cfg.turns - run.total} turn(s) from turn ${s.startTurn}`);
    run.st = await followDriver(lab, logFile);
    run.total += run.st.done ?? 0;
    for (const [k, v] of Object.entries(run.st.closed ?? {})) run.closed[k] = (run.closed[k] ?? 0) + v;
    run.st = ageEndedInside(cfg, run.st);
  }
  finishDrive(run, logFile, say);
}

function finishDrive(run, logFile, say) {
  say(driveSummary(run));
  if (run.st.state === NEAR_AGE_END) say(`stopped before the age's end: ${run.st.reason}. "lab age-change" crosses it`);
  say(`lines in ${logFile}`);
  if (run.st.state !== "done" && run.st.state !== NEAR_AGE_END) process.exitCode = 1;
}

// With --stop-before-age-end, a new age's page means the age ended inside the drive, so the drive ends there.
function ageEndedInside(cfg, st) {
  if (cfg.stopBeforeAgeEnd === null || st.state !== "page gone") return st;
  return { ...st, state: "age ended", reason: `the age ended inside the drive; progress jumped past the `
    + `${cfg.stopBeforeAgeEnd}-point margin in one turn, so a wider --stop-before-age-end leaves more room` };
}

function driveSummary({ t0, closed, total, st }) {
  const secs = Math.round((Date.now() - t0) / 1000);
  const shut = Object.entries(closed).map(([k, v]) => `${k} ${v}`).join(", ");
  const pace = total ? `${(secs / total).toFixed(1)} s a turn` : "no turns";
  return `${st.state}: ${total} turn(s) in ${secs} s (${pace})${st.reason ? `; ${st.reason}` : ""}`
    + `${shut ? `; pop-ups closed: ${shut}` : ""}`;
}

const LAB_SUBS = {
  status: (_ctx, lab) => {
    const cur = lab.current;
    out(cur ? `test run ${cur.dir}, started ${cur.startedAt}${cur.seed != null ? `, seed ${cur.seed}` : ""}` : "no test run in progress");
    return out(`game ${gamePid() ? `running (pid ${gamePid()})` : "not running"}`);
  },
  start: async ({ paths, opt }, lab, _more, say) => {
    let setup;
    try { setup = parseSetup(opt.setup); } catch (e) { throw new BenchError(errorText(e)); }
    const r = await labStart(paths, lab, { seed: num(opt.seed), age: opt.age, setup, quick: !!opt.quick, say });
    if (setup) await reportSetup(lab, setup, say);
    return say(`ready at turn ${r.turn}. Use the bench as normal; "lab stop" restores everything.`);
  },
  popups: async ({ opt }, lab, more, say) => {
    requireLabGame(lab);
    const action = more[0] ?? "clear";
    if (!["clear", "list", "suspend", "resume"].includes(action)) throw new BenchError("lab popups [clear|list|suspend|resume] [--keep a,b]");
    await lab.cdp.ensure();
    const r = await lab.cdp.call(pagePopups, {
      action, keep: splitList(opt.keep), queueModule: QUEUE_MODULE, contextModule: CONTEXT_MODULE,
    });
    return say(JSON.stringify(r));
  },
  drive: async ({ opt }, lab, more, say) => labDrive(lab, opt, more, say),
  "age-change": async ({ opt }, lab, _more, say) => {
    requireLabGame(lab);
    const r = await lab.ageChange({
      maxTurns: num(opt["max-turns"]) ?? 10, graceMs: (num(opt.grace) ?? 10) * 1000, civ: opt.civ ?? null,
      timeoutMs: (num(opt.timeout) ?? 600) * 1000, log: say,
    });
    say(`end-of-age screens seen: ${r.screens.join(", ") || "none"}`);
    return say(`into ${r.to.ageType}, turn ${r.to.turn} (age progress ${r.to.points} of ${r.to.max}), after `
      + `${r.turns} turn(s) from ${r.from.ageType} turn ${r.from.turn}`);
  },
  run: (ctx, lab, more, say) => labRun(ctx, lab, more[0], say),
  turns: async (_ctx, lab, more, say) => {
    requireLabGame(lab);
    const rolled = await lab.endTurns(Number(more[0] ?? 1), { log: say });
    return say(`${rolled.length} turn(s) ended${blockersNote(rolled)}`);
  },
  stop: async (_ctx, lab, _more, say) => {
    if (gamePid()) await lab.cdp.ensure().then(() => lab.cdp.call(pageDriveStop)).catch(() => null);
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
    if (!Object.hasOwn(LAB_SUBS, sub)) throw new BenchError("lab start|turns|drive|age-change|popups|stop|status");
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
