import { BenchError } from "../bench.mjs";
import { listCostReports, makeLogTail, rssMB, runCost, writeCostReport } from "../cost.mjs";
import { Lab, applyModSet, gamePid, preflight, registryRows } from "../lab.mjs";
import { errorText, num, out } from "./common.mjs";

/** @typedef {import("./common.mjs").Ctx} Ctx */

export const COST_HELP = `  cost <mod-id> --yes [--turns 20] [--seed N] [--replicates 2] [--age AGE_X]
                                       seeded test games with the mod off and on: per-turn wall time,
                                       heap, memory and log errors, and whether the difference is real`;

function printCost(r, file) {
  out(`\n${r.mod}: ${r.verdict}`);
  out(`  ${r.detail}`);
  out(`  ${r.replicates} replicate(s) per arm completed, first ${r.warmup} turn(s) of each game dropped`);
  for (const [name, m] of Object.entries(r.metrics)) {
    const f = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : "-");
    out(`  ${name.padEnd(44)} off ${f(m.off.median)} (p90 ${f(m.off.p90)})  on ${f(m.on.median)} (p90 ${f(m.on.p90)})  `
      + `diff ${f(m.diff)} ±${f(m.noise)}${m.significant ? "  REAL" : ""}`);
  }
  for (const x of r.failures) out(`  ${x.arm} replicate ${x.replicate}: ${x.error ?? ""} ${x.crashReports.join(", ")}`);
  out(`  report: ${file}`);
}

function costLab(paths, modId, opt) {
  if (!modId) throw new BenchError("which mod? cost <mod-id> --yes");
  if (!opt.yes) throw new BenchError("cost starts test games and switches mods for each (restored after); add --yes");
  const lab = new Lab(paths);
  if (lab.current) throw new BenchError(`a test run is in progress (${lab.current.dir}); "lab stop" first`);
  const pf = preflight(paths);
  if (pf.problems.length) throw new BenchError(pf.problems.join("; "));
  for (const w of pf.warnings) out(`[cost] warning: ${w}`);
  return lab;
}

/** @param {Ctx} ctx @param {string[]} args */
async function costCommand(ctx, [modId]) {
  const { bench, paths, opt } = ctx;
  const lab = costLab(paths, modId, opt);
  const say = (m) => out(`[cost] ${m}`);
  const deps = { lab, bench, paths, registryRows, applyModSet, gamePid, rssOf: rssMB, makeTail: makeLogTail(paths),
    log: say };
  let r;
  try {
    r = await runCost(deps, { modId, turns: num(opt.turns) ?? 20, seed: num(opt.seed) ?? 4242, age: opt.age,
      replicates: num(opt.replicates) ?? 2 });
  } catch (e) {
    throw new BenchError(errorText(e));
  } finally {
    lab.cdp.close();
  }
  const file = writeCostReport(paths, r);
  return opt.json ? out({ file, ...r }) : printCost(r, file);
}

/** @type {Record<string, import("./common.mjs").Handler>} */
export const COST_COMMANDS = {
  cost: costCommand,
};

// Each handler is (bench, req, query, readBody). Read-only.
export const COST_ROUTES = {
  "GET /api/cost": (bench) => listCostReports(bench.paths),
};
