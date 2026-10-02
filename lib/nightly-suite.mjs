// The nightly suite: which mod folders a regression run covers and, per mod, the recipes to run and the
// checks to make. A plain JSON file the user owns; relative paths resolve against the suite's own folder.
//
// { "format": "tower-bench/nightly-suite", "formatVersion": 1,
//   "defaults": { "seed": 4242, "age": null, "turns": 0, "quietMinutes": 30,
//                 "checks": ["check", "l10n", "impact", "recipes", "logs"] },
//   "mods": [ { "folder": "Mods/my-mod", "recipes": ["recipes/my-mod-loads.json"], "seed": 7 } ] }
import fs from "node:fs";
import path from "node:path";
import { BenchError } from "./bench.mjs";
import { readModinfo } from "./deploy.mjs";
import { modFolders } from "./analysis.mjs";
import { readMods, sourceOf } from "./mods.mjs";
import { validateRecipe } from "./recipes.mjs";

export const SUITE_FORMAT = "tower-bench/nightly-suite";
export const CHECKS = ["check", "l10n", "impact", "recipes", "logs"];
export const DEFAULTS = { seed: 4242, age: null, turns: 0, quietMinutes: 30, checks: CHECKS };

/** The bench's nightly folder: suite, reports and the scheduler's log, beside the evidence log. */
export const nightlyDir = (paths) => path.join(path.dirname(paths.evidence), "nightly");
export const defaultSuiteFile = (paths) => path.join(nightlyDir(paths), "suite.json");

const isInt = (v) => Number.isInteger(v);

const wholeOrNull = (v) => v == null || (isInt(v) && v >= 0);
const OPTION_CHECKS = [
  { bad: (o) => o.seed != null && !isInt(o.seed), why: "seed must be an integer" },
  { bad: (o) => o.age != null && typeof o.age !== "string", why: "age must be a string such as AGE_ANTIQUITY" },
  { bad: (o) => !wholeOrNull(o.turns), why: "turns must be a whole number" },
  { bad: (o) => !wholeOrNull(o.quietMinutes), why: "quietMinutes must be a whole number" },
  { bad: (o) => o.checks != null && !(Array.isArray(o.checks) && o.checks.every((c) => CHECKS.includes(c))),
    why: `checks must be a list drawn from ${CHECKS.join(", ")}` },
];

/** @returns {string | null} what is wrong with one set of options, or null */
function optionsProblem(o, where) {
  const failed = OPTION_CHECKS.find((c) => c.bad(o));
  return failed ? `${where}: ${failed.why}` : null;
}

function modProblem(m, i) {
  const where = `mods[${i}]`;
  if (!m || typeof m.folder !== "string" || !m.folder) return `${where} needs a folder`;
  if (m.recipes != null && !(Array.isArray(m.recipes) && m.recipes.every((r) => typeof r === "string"))) {
    return `${where}: recipes must be a list of recipe file paths`;
  }
  return optionsProblem(m, where);
}

/** @returns {string | null} */
export function validateSuite(s) {
  if (!s || typeof s !== "object") return "a suite is a JSON object";
  if (s.format !== undefined && s.format !== SUITE_FORMAT) return `not a nightly suite (format ${s.format})`;
  if (!Array.isArray(s.mods) || !s.mods.length) return "a suite needs a non-empty mods array";
  return optionsProblem(s.defaults ?? {}, "defaults") ?? s.mods.map(modProblem).find(Boolean) ?? null;
}

/**
 * Each mod with its options merged over the defaults and its paths made absolute.
 * @param {any} suite @param {string} base folder relative paths resolve against
 */
export function resolveSuite(suite, base) {
  const defaults = { ...DEFAULTS, ...(suite.defaults ?? {}) };
  const abs = (p) => path.resolve(base, p);
  const mods = suite.mods.map((m) => ({
    folder: abs(m.folder),
    recipes: (m.recipes ?? []).map(abs),
    seed: m.seed ?? defaults.seed,
    age: m.age ?? defaults.age,
    turns: m.turns ?? defaults.turns,
    checks: m.checks ?? defaults.checks,
  }));
  return { name: suite.name ?? null, quietMinutes: defaults.quietMinutes, defaults, mods };
}

/** Reads, validates and resolves a suite file. */
export function loadSuite(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    const hint = fs.existsSync(file) ? "" : `; "nightly init" writes a starter suite`;
    throw new BenchError(`cannot read suite ${file}: ${e instanceof Error ? e.message : String(e)}${hint}`);
  }
  const problem = validateSuite(raw);
  if (problem) throw new BenchError(`${file}: ${problem}`);
  return { file: path.resolve(file), ...resolveSuite(raw, path.dirname(path.resolve(file))) };
}

/** Reads one recipe for a nightly run; a bad file is evidence for that mod, not a reason to stop the night. */
export function readRecipeFile(file) {
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    const problem = validateRecipe(r);
    return problem ? { error: `${file}: ${problem}` } : { recipe: r };
  } catch (e) {
    return { error: `cannot read recipe ${file}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The smallest useful recipe: a seeded game starts, one turn ends, and the logs are then read for the mod. */
export function sampleRecipe(modId) {
  return {
    name: `${modId}-loads`,
    steps: [{ expect: "typeof Game.turn === 'number'" }, { turns: 1 }],
  };
}

const fileSafe = (id) => id.replace(/[^\w.-]+/g, "_").slice(0, 80) || "mod";

/** Enabled local copies (Mods/ folder, not Workshop, not official, not nested build output). */
export function localEnabledMods(paths, rows = readMods(paths.modsDb)) {
  const local = new Set(rows.filter((r) => sourceOf(r.path, paths).kind === "local").map((r) => path.dirname(r.path)));
  return modFolders(rows, paths).filter((f) => local.has(f.folder) && f.id !== "tower-bench-agent");
}

/**
 * The starter suite: one entry and one sample recipe per enabled local mod. Folders are kept absolute
 * because they live outside the suite's folder; recipes are relative to it.
 * @param {{ id: string, folder: string }[]} mods
 */
export function starterSuite(mods) {
  const recipes = new Map();
  const entries = mods.map((m) => {
    let id = m.id;
    try { id = readModinfo(m.folder).id; } catch { /* the registry's id will do */ }
    const rel = `recipes/${fileSafe(id)}-loads.json`;
    recipes.set(rel, sampleRecipe(id));
    return { folder: m.folder, recipes: [rel] };
  });
  return { suite: { format: SUITE_FORMAT, formatVersion: 1, defaults: { ...DEFAULTS }, mods: entries }, recipes };
}

/**
 * Writes the starter suite into `dir`. An existing suite.json is replaced only with `yes`; existing recipe
 * files are always kept, since the user may have edited them.
 * @param {any} paths @param {{ dir?: string, yes?: boolean, rows?: any[] }} [opts]
 */
export function initSuite(paths, { dir, yes = false, rows } = {}) {
  const folder = path.resolve(dir ?? nightlyDir(paths));
  const file = path.join(folder, "suite.json");
  if (fs.existsSync(file) && !yes) throw new BenchError(`${file} exists; add --yes to replace it (recipes are kept)`);
  const mods = localEnabledMods(paths, rows);
  if (!mods.length) throw new BenchError("no enabled local mods (in Mods/, not Workshop) to put in a suite");
  const { suite, recipes } = starterSuite(mods);
  fs.mkdirSync(path.join(folder, "recipes"), { recursive: true });
  const written = [];
  for (const [rel, recipe] of recipes) {
    const target = path.join(folder, rel);
    if (fs.existsSync(target)) continue;
    fs.writeFileSync(target, `${JSON.stringify(recipe, null, 2)}\n`);
    written.push(target);
  }
  fs.writeFileSync(file, `${JSON.stringify(suite, null, 2)}\n`);
  return { file, mods: suite.mods.length, recipes: written };
}
