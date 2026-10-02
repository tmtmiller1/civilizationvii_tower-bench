import fs from "node:fs";
import path from "node:path";
import { BenchError } from "../bench.mjs";
import { describeDbDiff, diffDatabases, runDbdiff } from "../dbdiff.mjs";
import { analyseConflicts } from "../analysis.mjs";
import { loadProofs, matchProof, proofLabel, proveConflicts } from "../prove.mjs";
import { num, out } from "./common.mjs";

/** @typedef {import("./common.mjs").Ctx} Ctx */

const tablesOpt = (opt) => (opt.filter ? String(opt.filter).split(",").map((t) => t.trim()).filter(Boolean) : undefined);
const DEFAULT_LIMIT = 5;

function printRun(r, limit) {
  out(`${r.mod} (${r.copy}), seed ${r.seed}${r.age ? `, ${r.age}` : ""}: mod off vs on`);
  for (const w of r.warnings) out(`  warning: ${w}`);
  const names = Object.keys(r.diffs);
  if (!names.length) out("  no Debug database was copied from both games");
  for (const name of names) out(describeDbDiff(r.diffs[name], { limit, label: name }));
  out(`report: ${r.report}`);
}

function filesCommand(opt, args, { limit, tables }) {
  if (args.length !== 2) throw new BenchError("dbdiff --files <before.sqlite> <after.sqlite>");
  let d;
  try { d = diffDatabases(args[0], args[1], { limit, tables }); } catch (e) {
    throw new BenchError(e instanceof Error ? e.message : String(e));
  }
  return opt.json ? out(d) : out(describeDbDiff(d, { limit }));
}

/** @param {Ctx} ctx @param {string[]} args */
async function dbdiffCommand({ bench, opt }, args) {
  const limit = num(opt.limit) ?? DEFAULT_LIMIT;
  const tables = tablesOpt(opt);
  // "files" is a new parseCli boolean option.
  if (/** @type {any} */ (opt).files) return filesCommand(opt, args, { limit, tables });
  const mod = args[0];
  if (!mod) throw new BenchError("which mod? dbdiff <mod-id> --yes, or dbdiff --files <a.sqlite> <b.sqlite>");
  if (!opt.yes) {
    throw new BenchError(`dbdiff ${mod} starts two seeded test games (mod off, then on), switching the registry for `
      + "each and restoring it after; add --yes to run it");
  }
  const say = (m) => out(`[dbdiff] ${m}`);
  const r = await runDbdiff(bench, mod, { seed: num(opt.seed) ?? 4242, age: opt.age ?? null, limit, tables, log: say });
  return opt.json ? out(r) : printRun(r, limit);
}

function printProofs(r) {
  for (const w of r.warnings) out(`warning: ${w}`);
  for (const p of r.proofs) {
    out(`  ${p.verdict.padEnd(12)} ${p.severity.padEnd(6)} ${p.a} / ${p.b} (${p.rule}): ${p.detail}`);
    if (p.command) out(`      try: ${p.command}`);
    if (p.run) out(`      run: ${p.run}`);
  }
  if (r.skipped) out(`  (${r.skipped} lower-severity finding(s) not proved; --level medium includes Medium)`);
  out(r.store ? `stored in ${r.store}` : "nothing to prove at this level");
}

/**
 * `mods conflicts --prove [--level medium] --yes`: the lead routes the flag here.
 * @param {Ctx} ctx
 */
export async function proveCommand({ bench, paths, opt }) {
  if (!opt.yes) {
    throw new BenchError("conflicts --prove starts one seeded test game per mod pair, with only that pair enabled, "
      + "and restores the registry after each; add --yes to run it");
  }
  const r = analyseConflicts(paths, { all: !!opt.all, schemaDir: opt.schema });
  const proved = await proveConflicts(bench, r.conflicts, {
    level: opt.level ?? "high", seed: num(opt.seed) ?? 4242, age: opt.age ?? null, log: (m) => out(`[prove] ${m}`),
  });
  return opt.json ? out(proved) : printProofs(proved);
}

/**
 * Each conflict with its newest stored proof, for `mods conflicts` to print "confirmed on <date>".
 * @param {any} paths @param {any[]} conflicts
 */
export function withProofs(paths, conflicts) {
  const proofs = loadProofs(paths);
  return conflicts.map((c) => {
    const p = matchProof(proofs, c);
    return p ? { ...c, proof: { verdict: p.verdict, date: p.date, detail: p.detail, label: proofLabel(p) } } : c;
  });
}

/** @type {Record<string, import("./common.mjs").Handler>} */
export const LABTOOLS_COMMANDS = {
  dbdiff: dbdiffCommand,
};

export const LABTOOLS_HELP = `  dbdiff <mod-id> --yes [--seed N] [--age AGE_X] [--limit 5] [--filter T1,T2]
                                       two seeded test games, the mod off then on; diff their compiled
                                       databases: rows added, removed and changed per table
  dbdiff --files <a.sqlite> <b.sqlite> [--limit 5] [--filter T1,T2]
                                       the same diff between any two SQLite files
  mods conflicts --prove --yes [--level medium]
                                       prove High (and Medium) conflicts in one test game per pair;
                                       verdicts are stored and shown next to the findings`;

// ---- Server routes ----

const runsDir = (bench) => path.join(path.dirname(bench.paths.evidence), "runs");

function listReports(bench) {
  const dir = runsDir(bench);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /^dbdiff-.*\.json$/.test(n)).sort().reverse().map((name) => {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      return { name, mod: r.mod, seed: r.seed, age: r.age };
    } catch {
      return { name, mod: null };
    }
  });
}

function readReport(bench, name) {
  if (!/^dbdiff-[\w-]+\.json$/.test(name ?? "")) throw new BenchError("no such report");
  const file = path.join(runsDir(bench), name);
  if (!fs.existsSync(file)) throw new BenchError("no such report", 404);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function filesDiff(q) {
  const a = q.get("a");
  const b = q.get("b");
  if (!a || !b) throw new BenchError("two database files are needed: a and b");
  const tables = q.get("tables") ? String(q.get("tables")).split(",").filter(Boolean) : undefined;
  try {
    return diffDatabases(a, b, { limit: Number(q.get("limit")) || DEFAULT_LIMIT, tables });
  } catch (e) {
    throw new BenchError(e instanceof Error ? e.message : String(e));
  }
}

// Runs that launch the game are gated like other writes: the page must have writes armed.
function requireArmed(bench) {
  if (!bench.armed) throw new BenchError("arm writes first: this starts test games and switches the registry", 409);
}

export const LABTOOLS_ROUTES = {
  "GET /api/dbdiff/files": (_bench, _req, q) => filesDiff(q),
  "GET /api/dbdiff/reports": (bench) => listReports(bench),
  "GET /api/dbdiff/report": (bench, _req, q) => readReport(bench, q.get("name")),
  "POST /api/dbdiff/run": async (bench, _req, _q, readBody) => {
    requireArmed(bench);
    const b = await readBody();
    if (!b.mod) throw new BenchError("which mod?");
    return runDbdiff(bench, String(b.mod), { seed: Number(b.seed) || 4242, age: b.age || null,
      limit: Number(b.limit) || DEFAULT_LIMIT });
  },
  "GET /api/proofs": (bench) => loadProofs(bench.paths),
  "POST /api/proofs/run": async (bench, _req, _q, readBody) => {
    requireArmed(bench);
    const b = await readBody();
    const r = analyseConflicts(bench.paths, {});
    return proveConflicts(bench, r.conflicts, { level: b.level === "medium" ? "medium" : "high" });
  },
};
