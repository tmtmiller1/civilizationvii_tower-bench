// The patch-impact report: index the installed game, compare two indexes, and list what an update breaks in
// each mod. Everything is read from files; nothing here touches the running game.
import fs from "node:fs";
import path from "node:path";
import { BenchError } from "./bench.mjs";
import { modFolders } from "./analysis.mjs";
import { readMods } from "./mods.mjs";
import { gameVersion } from "./paths.mjs";
import { dbFindings } from "./patch-db.mjs";
import { diffIndexes } from "./patch-diff.mjs";
import { Findings, componentFindings, importFindings, indexView, overrideFindings } from "./patch-impact.mjs";
import { buildIndex, compareVersions, indexDir, indexFile, listIndexes, readIndex, writeIndex } from "./patch-snapshot.mjs";
import { loadMod } from "./static/mod.mjs";
import { readText, walkFiles } from "./static/util.mjs";

export { compareVersions, indexDir, listIndexes };

/** The installed version: PlistBuddy, else the plist read as text; null when neither works. */
export function installedVersion(paths) {
  const v = gameVersion(paths);
  if (v) return v;
  try {
    const plist = fs.readFileSync(path.join(paths.install ?? "", "Contents", "Info.plist"), "utf8");
    return plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? null;
  } catch {
    return null;
  }
}

const refuse = (fn) => {
  try {
    return fn();
  } catch (e) {
    throw e instanceof BenchError ? e : new BenchError(e instanceof Error ? e.message : String(e));
  }
};

const CREATE = /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?["'`[]?([\w$]+)/gi;

/** Tables any installed mod creates (SQL files of every copy Mods.sqlite lists); none when it cannot be read. */
export function modCreatedTables(paths) {
  let folders = [];
  try { folders = modFolders(readMods(paths.modsDb), paths, { all: true }).map((f) => f.folder); } catch { return []; }
  const out = new Set();
  for (const f of folders.flatMap((d) => walkFiles(d)).filter((x) => /\.sql$/i.test(x))) {
    try { for (const m of readText(f).matchAll(CREATE)) out.add(m[1]); } catch { /* unreadable */ }
  }
  return [...out].sort();
}

/**
 * Indexes the installed game into the store. Replacing an existing index needs `yes`.
 * @param {import("./bench.mjs").Bench} bench
 * @param {{ version?: string, schemaDir?: string, yes?: boolean }} [opts]
 */
export function snapshotGame(bench, { version, schemaDir, yes = false } = {}) {
  const v = version ?? installedVersion(bench.paths);
  if (!v) throw new BenchError("cannot read the installed version here; name the index: game snapshot <version>");
  const dir = indexDir(bench.paths);
  const file = refuse(() => indexFile(dir, v));
  if (fs.existsSync(file) && !yes) throw new BenchError(`an index of ${v} exists (${file}); add --yes to replace it`);
  const modTables = modCreatedTables(bench.paths);
  const idx = refuse(() => buildIndex(bench.paths, { version: v, schemaDir, modTables }));
  const written = writeIndex(dir, idx);
  const result = { version: v, ...written, stats: idx.stats, schemaNote: idx.schemaNote, modTables,
    components: { legacy: idx.components.legacy.length, registry: idx.components.registry.length },
    types: idx.types.length, effectTypes: idx.effectTypes.length };
  bench.log({ kind: "game-snapshot", request: { version: v, schemaDir: schemaDir ?? null }, result });
  return result;
}

/** The two indexes to compare: as named, or the two newest. */
function pickPair(dir, from, to) {
  const have = listIndexes(dir);
  const b = to ?? have.at(-1);
  const a = from ?? have.filter((v) => v !== b && (!b || compareVersions(v, b) < 0)).at(-1);
  if (!a || !b) {
    throw new BenchError(`need two game indexes to compare (have: ${have.join(", ") || "none"}); `
      + "run game snapshot before and after an update");
  }
  return refuse(() => [readIndex(dir, a), readIndex(dir, b)]);
}

/** @param {any} paths @param {{ from?: string, to?: string }} [opts] */
export function diffGame(paths, { from, to } = {}) {
  const [a, b] = pickPair(indexDir(paths), from, to);
  return diffIndexes(a, b);
}

const hasModinfo = (dir) => {
  try { return fs.readdirSync(dir).some((n) => n.endsWith(".modinfo")); } catch { return false; }
};

/** A mod folder, or a folder of mod folders (each child with a modinfo somewhere below it). */
export function expandFolder(dir) {
  const full = path.resolve(dir);
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) throw new BenchError(`no such folder: ${dir}`);
  if (hasModinfo(full)) return [full];
  const kids = fs.readdirSync(full, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => path.join(full, e.name)).filter((d) => containsModinfo(d));
  return kids.length ? kids : [full];
}

function containsModinfo(dir, depth = 0) {
  if (hasModinfo(dir)) return true;
  if (depth > 3) return false;
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .some((e) => e.isDirectory() && containsModinfo(path.join(dir, e.name), depth + 1));
  } catch {
    return false;
  }
}

/** @param {any} paths @param {string | string[]} which "enabled", "all" or folders */
export function selectMods(paths, which) {
  const list = Array.isArray(which) ? which : [which];
  if (list.length === 1 && (list[0] === "enabled" || list[0] === "all")) {
    return modFolders(readMods(paths.modsDb), paths, { all: list[0] === "all" }).map((f) => f.folder);
  }
  return list.flatMap(expandFolder);
}

/**
 * What one mod relied on in `a` that `b` changed.
 * @param {import("./static/mod.mjs").Mod} mod
 * @param {{ a: any, b: any, diff: any, oldView: any, newView: any }} ctx
 */
export function modImpact(mod, ctx) {
  const out = new Findings();
  importFindings(mod, ctx, out);
  componentFindings(mod, ctx, out);
  dbFindings(mod, ctx, out);
  overrideFindings(mod, ctx, out);
  return out.list();
}

/** Builds the context once for many mods. */
export function impactContext(a, b) {
  const oldView = indexView(a);
  const newView = indexView(b);
  // mod scripts resolve against every module either version had
  const roots = new Map([...oldView.roots, ...newView.roots]);
  return { a, b, diff: diffIndexes(a, b), oldView, newView, roots };
}

/**
 * @param {any} ctx from impactContext
 * @param {string[]} folders
 */
export function impactOfFolders(ctx, folders) {
  const mods = [];
  const failed = [];
  for (const folder of folders) {
    try {
      const mod = loadMod(folder, { vanilla: /** @type {any} */ ({ roots: ctx.roots }) });
      const findings = modImpact(mod, ctx);
      mods.push({ id: mod.id, name: mod.name, folder, worst: findings[0]?.severity ?? null, findings });
    } catch (e) {
      failed.push({ folder, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { mods, failed };
}

/**
 * Which mods an update breaks.
 * @param {any} paths
 * @param {{ mods?: string | string[], from?: string, to?: string }} [opts]
 */
export function impactGame(paths, { mods = "enabled", from, to } = {}) {
  const [a, b] = pickPair(indexDir(paths), from, to);
  const ctx = impactContext(a, b);
  const { mods: results, failed } = impactOfFolders(ctx, selectMods(paths, mods));
  const hit = results.filter((m) => m.findings.length);
  return { from: a.version, to: b.version, checked: results.length, affected: hit.length, failed,
    schemaNote: ctx.diff.schema.available ? null : ctx.diff.schema.note, mods: hit };
}

/**
 * Whether the installed game is newer than (or different from) the newest index. Offline; for status and
 * doctor. null when the installed version cannot be read.
 * @param {any} paths
 */
export function versionChanged(paths) {
  const installed = installedVersion(paths);
  if (!installed) return null;
  const newest = listIndexes(indexDir(paths)).at(-1) ?? null;
  if (!newest) {
    return { changed: false, installed, newest, message: `no game index yet: run "game snapshot" so the next update can be compared` };
  }
  if (listIndexes(indexDir(paths)).includes(installed)) return { changed: false, installed, newest, message: null };
  return { changed: true, installed, newest,
    message: `the game updated (${newest} -> ${installed}): run "game snapshot", then "game impact". `
      + "The first launch after an update loads no mods; launch once more to get them back." };
}
