import fs from "node:fs";
import path from "node:path";
import { readMods, sourceOf } from "./mods.mjs";
import { checkMod, runtimeRefs } from "./static/check.mjs";
import { findConflicts } from "./static/conflicts.mjs";
import { Schema, Vanilla } from "./static/game.mjs";
import { loadMod } from "./static/mod.mjs";
import { techniqueIds } from "./techniques.mjs";

// Glue between the static analyzer and the bench: which mod folders to read (the copies Mods.sqlite says the
// game loads), the game index and schema, and for every finding the techniques that fix it and the cheapest
// way to prove it in game. Everything here is read from files; nothing has run.

const SEVERITY = { High: 0, Medium: 1, Low: 2 };
const VERDICT = { "BLOCKS GAME": 0, "FEATURE DEAD": 1, MINOR: 2 };

/** The folders of the copies the game will load, or of every installed copy; official content is never read. */
export function modFolders(rows, paths, { all = false } = {}) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const src = sourceOf(r.path, paths);
    if (src.kind === "official" || (!all && r.disabled)) continue;
    const folder = path.dirname(r.path);
    if (seen.has(folder) || !fs.existsSync(folder)) continue;
    seen.add(folder);
    out.push({ id: r.id, folder, label: src.label });
  }
  return out;
}

function gameContext(paths, schemaDir) {
  if (!paths.install || !fs.existsSync(paths.install)) {
    throw new Error(`game install not found at ${paths.install}; set TOWER_BENCH_INSTALL`);
  }
  const vanilla = Vanilla.load(paths.install);
  const s = schemaDir ? Schema.fromDir(schemaDir) : Schema.load(paths.user);
  return { vanilla, schema: s.schema, schemaNote: s.full ? null : s.reason ?? "schema unavailable" };
}

// What would prove a conflict in game. Component collisions show their winner in the running game; anything
// else is a question for bisection over the pair.
function proofFor(c) {
  if (["define-collision", "define-over-decorated", "registry-collision"].includes(c.rule)) {
    return "registry (shows which definition won in the running game)";
  }
  if (c.rule === "same-id") return `mods --filter ${c.a}`;
  return `bisect --mods ${c.a},${c.b} --recipe <a recipe that shows the symptom>`;
}

const annotateConflict = (c) => ({
  ...c, techniques: techniqueIds(`conflict:${c.rule}`), ...(c.severity === "High" ? { prove: proofFor(c) } : {}),
});

const annotateDefect = (d) => ({ ...d, techniques: techniqueIds(`check:${d.rule}`) });

function loadAll(folders, vanilla) {
  const mods = [];
  const failed = [];
  for (const f of folders) {
    try {
      mods.push(loadMod(f.folder, { vanilla }));
    } catch (e) {
      failed.push({ folder: f.folder, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { mods, failed };
}

/**
 * Conflicts among the mods the game will load (or every installed copy with `all`).
 * @param {any} paths @param {{ all?: boolean, schemaDir?: string }} [opts]
 */
export function analyseConflicts(paths, { all = false, schemaDir } = {}) {
  const { vanilla, schema, schemaNote } = gameContext(paths, schemaDir);
  const { mods, failed } = loadAll(modFolders(readMods(paths.modsDb), paths, { all }), vanilla);
  const conflicts = findConflicts(mods, { vanilla, schema }).map(annotateConflict)
    .sort((x, y) => SEVERITY[x.severity] - SEVERITY[y.severity] || x.a.localeCompare(y.a));
  return { mods: mods.length, failed, schemaNote, gameVersion: vanilla.version, conflicts };
}

/**
 * Will this mod start a game on the installed version? Its defects, and its conflicts with the mods the
 * game will load alongside it.
 * @param {any} paths @param {string} dir @param {{ schemaDir?: string }} [opts]
 */
export function analyseMod(paths, dir, { schemaDir } = {}) {
  const folder = path.resolve(dir);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error(`no such folder: ${dir}`);
  const { vanilla, schema, schemaNote } = gameContext(paths, schemaDir);
  const mod = loadMod(folder, { vanilla });
  const others = loadAll(modFolders(readMods(paths.modsDb), paths).filter((f) => path.resolve(f.folder) !== folder
    && !mod.ids.includes(f.id)), vanilla).mods;
  const defects = checkMod(mod, { vanilla, schema, otherMods: others }).map(annotateDefect)
    .sort((x, y) => VERDICT[x.verdict] - VERDICT[y.verdict]);
  const conflicts = findConflicts([mod, ...others], { vanilla, schema })
    .filter((c) => mod.ids.includes(c.a) || mod.ids.includes(c.b)).map(annotateConflict)
    .sort((x, y) => SEVERITY[x.severity] - SEVERITY[y.severity]);
  const worst = defects[0]?.verdict ?? "CLEAN";
  return { id: mod.id, folder, verdict: worst, schemaNote, gameVersion: vanilla.version, defects, conflicts,
    runtime: { checked: runtimeRefs(mod).checked, unresolved: runtimeRefs(mod).unresolved }, against: others.length };
}
