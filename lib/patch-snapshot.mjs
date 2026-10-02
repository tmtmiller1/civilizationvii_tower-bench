// A self-contained index of one installed game version: every module file with its hash, what each script
// exports, the component names the game defines, and the compiled database schema. An update deletes the
// old install, so this index is all that is left of the old version when the next one is compared to it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Schema, moduleRoots } from "./static/game.mjs";
import { stripJsComments } from "./static/jsscan.mjs";
import { readText, relPath, sqliteJson } from "./static/util.mjs";

export const FORMAT = "tower-bench/game-index";
export const FORMAT_VERSION = 1;

/**
 * @typedef {{ name: string, cols: string[], pk: string[], required: string[] }} SnapTable
 * @typedef {{ format: string, formatVersion: number, version: string, createdAt: string,
 *   files: Record<string, [string, number]>, exports: Record<string, Record<string, string>>,
 *   stars: Record<string, string[]>, components: { legacy: string[], registry: string[] },
 *   schema: Record<string, Record<string, SnapTable>> | null, schemaNote: string | null, modTables: string[],
 *   types: string[], effectTypes: string[], stats: Record<string, number> }} GameIndex
 */

/** Where game indexes live: beside the evidence log, like the bench's other stores. */
export const indexDir = (paths) => path.join(path.dirname(paths.evidence), "game-index");

const SAFE_VERSION = /^[\w.+-]{1,64}$/;

/** @param {string} version */
export function indexFile(dir, version) {
  if (!SAFE_VERSION.test(version)) throw new Error(`not a usable version label: "${version}"`);
  return path.join(dir, `${version}.json.gz`);
}

// Numeric segments compare as numbers, so 1.10.0 sorts after 1.9.2.
export function compareVersions(a, b) {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    const d = /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(x) - Number(y) : x.localeCompare(y);
    if (d) return d;
  }
  return 0;
}

/** Versions with an index, oldest first. */
export function listIndexes(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => n.endsWith(".json.gz")).map((n) => n.slice(0, -".json.gz".length))
    .filter((v) => SAFE_VERSION.test(v)).sort(compareVersions);
}

/** @returns {GameIndex} */
export function readIndex(dir, version) {
  const file = indexFile(dir, version);
  if (!fs.existsSync(file)) throw new Error(`no game index for ${version} (have: ${listIndexes(dir).join(", ") || "none"})`);
  const idx = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
  if (idx.format !== FORMAT) throw new Error(`${file} is not a game index`);
  return idx;
}

/** @param {GameIndex} idx @returns {{ file: string, bytes: number }} */
export function writeIndex(dir, idx) {
  fs.mkdirSync(dir, { recursive: true });
  const file = indexFile(dir, idx.version);
  const buf = zlib.gzipSync(JSON.stringify(idx), { level: 9 });
  fs.writeFileSync(`${file}.tmp`, buf);
  fs.renameSync(`${file}.tmp`, file);
  return { file, bytes: buf.length };
}

const EXPORT_LIST = /(?:^|[;\s}])export\s*\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?/g;
const EXPORT_DECL = /(?:^|[;\s}])export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([\w$]+)/g;
const EXPORT_DEFAULT = /(?:^|[;\s}])export\s+default\b/;
const EXPORT_STAR = /(?:^|[;\s}])export\s*\*\s*(?:as\s+([\w$]+)\s*)?from\s*['"]([^'"]+)['"]/g;

/**
 * Exported name -> local name for one module's text ("" when they are the same), and the specifiers of
 * its bare `export * from` lines.
 * @param {string} text
 */
export function parseExports(text) {
  const src = stripJsComments(text);
  /** @type {Record<string, string>} */
  const names = {};
  for (const m of src.matchAll(EXPORT_LIST)) listNames(m[1], names);
  for (const m of src.matchAll(EXPORT_DECL)) {
    const isDefault = /export\s+default/.test(m[0]);
    names[isDefault ? "default" : m[1]] = isDefault ? m[1] : "";
  }
  if (EXPORT_DEFAULT.test(src) && !("default" in names)) names.default = "";
  /** @type {string[]} */
  const stars = [];
  for (const m of src.matchAll(EXPORT_STAR)) {
    if (m[1]) names[m[1]] = "";
    else stars.push(m[2]);
  }
  return { names, stars };
}

function listNames(list, names) {
  for (const part of list.split(",").map((p) => p.trim()).filter(Boolean)) {
    const [local, exported = local] = part.split(/\s+as\s+/).map((s) => s.trim());
    names[exported] = exported === local ? "" : local;
  }
}

const REGISTRY = /\.register\(\s*\{[^{}]{0,400}?\bname:\s*['"]([^'"]+)['"]/g;

/**
 * Legacy component tags (Controls.define, defineLegacyComponent, customElements.define) and ui-next
 * ComponentRegistry names one script defines.
 * @param {string} text
 */
export function componentsOf(text) {
  const legacy = new Set();
  for (const m of text.matchAll(/(?:Controls\.define|defineLegacyComponent|customElements\.define)\(\s*['"]([^'"]+)/g)) {
    legacy.add(m[1]);
  }
  const consts = new Map([...text.matchAll(/\b(\w+TagName)\s*=\s*['"]([^'"]+)['"]/g)].map((m) => [m[1], m[2]]));
  for (const m of text.matchAll(/Controls\.define\(\s*(\w+)/g)) if (consts.has(m[1])) legacy.add(consts.get(m[1]));
  const registry = new Set();
  if (text.includes("ComponentRegistry")) for (const m of text.matchAll(REGISTRY)) registry.add(m[1]);
  return { legacy, registry };
}

// Art packages (Platforms/) are the engine's business; mods never import or replace them.
function moduleFiles(root) {
  /** @type {string[]} */
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = /** @type {string} */ (stack.pop());
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && e.name !== "Platforms") stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  return out.sort();
}

function indexFiles(install) {
  /** @type {Pick<GameIndex, "files" | "exports" | "stars">} */
  const res = { files: {}, exports: {}, stars: {} };
  const legacy = new Set();
  const registry = new Set();
  for (const [mod, root] of moduleRoots(install)) {
    for (const full of moduleFiles(root)) {
      const key = `${mod}/${relPath(root, full)}`;
      const buf = fs.readFileSync(full);
      res.files[key] = [crypto.createHash("sha1").update(buf).digest("hex"), buf.length];
      if (!/\.m?js$/.test(full)) continue;
      const text = readText(full);
      const ex = parseExports(text);
      if (Object.keys(ex.names).length) res.exports[key] = ex.names;
      if (ex.stars.length) res.stars[key] = ex.stars;
      const c = componentsOf(text);
      c.legacy.forEach((n) => legacy.add(n));
      c.registry.forEach((n) => registry.add(n));
    }
  }
  return { ...res, components: { legacy: [...legacy].sort(), registry: [...registry].sort() } };
}

/** @param {Schema} schema @param {Set<string>} skip lower-case names of tables installed mods create */
function schemaTables(schema, skip) {
  /** @type {Record<string, Record<string, SnapTable>>} */
  const out = {};
  for (const [db, tables] of Object.entries(schema.tables)) {
    if (!tables.size) continue;
    out[db] = {};
    for (const [low, t] of [...tables].filter(([n]) => !skip.has(n))) {
      const required = [...(schema.required[db].get(low) ?? [])].sort();
      out[db][low] = { name: t.name, cols: t.cols, pk: t.pk, required };
    }
  }
  return out;
}

const plistFile = (install) => path.join(install, "Contents", "Info.plist");
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

/**
 * The compiled schema, Types and effect types from a folder of *-copy.sqlite files. The user's Debug copy
 * is refused when it is older than the install: after an update it still describes the previous version.
 */
function readSchema(dir, install, explicit, skip) {
  const gameplay = path.join(dir, Schema.DBS.gameplay);
  if (!explicit && mtime(gameplay) && mtime(gameplay) < mtime(plistFile(install))) {
    return { note: "the Debug database predates this install (it describes the previous version); load a game once, "
      + "then snapshot again with --yes" };
  }
  const s = Schema.fromDir(dir);
  if (!s.schema) return { note: s.reason ?? "schema unavailable" };
  const types = sqliteJson(gameplay, "SELECT Type AS t FROM Types ORDER BY Type").map((r) => r.t);
  const effects = sqliteJson(gameplay, `SELECT Type AS t FROM Types WHERE Kind = 'KIND_EFFECT'
    UNION SELECT EffectType FROM DynamicModifiers WHERE EffectType IS NOT NULL ORDER BY 1`).map((r) => r.t);
  return { schema: schemaTables(s.schema, skip), types, effects };
}

/**
 * Indexes an install. `schemaDir` is a folder of *-copy.sqlite files (default: the user's Debug folder).
 * `modTables` are tables installed mods create: the Debug copy holds them too, and they are not the game's.
 * @param {{ install: string, user: string }} paths
 * @param {{ version: string, schemaDir?: string, modTables?: string[] }} opts
 * @returns {GameIndex}
 */
export function buildIndex(paths, { version, schemaDir, modTables = [] }) {
  const t0 = Date.now();
  if (!paths.install || !fs.existsSync(paths.install)) throw new Error(`game install not found at ${paths.install}`);
  const files = indexFiles(paths.install);
  const t1 = Date.now();
  const skip = new Set(modTables.map((t) => t.toLowerCase()));
  const db = readSchema(schemaDir ?? path.join(paths.user, "Debug"), paths.install, !!schemaDir, skip);
  return {
    format: FORMAT, formatVersion: FORMAT_VERSION, version, createdAt: new Date().toISOString(),
    ...files, schema: db.schema ?? null, schemaNote: db.note ?? null, modTables: [...skip].sort(),
    types: db.types ?? [], effectTypes: db.effects ?? [],
    stats: { files: Object.keys(files.files).length, scripts: Object.keys(files.exports).length,
      tables: Object.values(db.schema ?? {}).reduce((n, t) => n + Object.keys(t).length, 0),
      filesMs: t1 - t0, schemaMs: Date.now() - t1 },
  };
}
