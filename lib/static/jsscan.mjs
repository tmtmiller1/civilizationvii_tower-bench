// Facts about a mod's JavaScript, read from the text: what it decorates, defines, registers and patches,
// the globals and localStorage keys it uses, what it imports and which files it fetches at run time.
// Only files reachable from the modinfo (entry scripts and what they import) are analysed.
import fs from "node:fs";
import path from "node:path";
import { cleanItem } from "./modinfo.mjs";
import { readText, relPath } from "./util.mjs";

const RX = {
  importStatic: /(?:^|[;\s}])(?:import|export)\s+(?:[\w*\s{},$]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
  importDynamic: /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  decorate: /Controls\.decorate\(\s*(['"]?)([\w\-$.]+)\1/g,
  define: /Controls\.define\(\s*(['"]?)([\w\-$.]+)\1/g,
  getdef: /Controls\.getDefinition\(\s*(['"]?)([\w\-$.]+)\1/g,
  registry: /\.register\(\s*\{[^{}]{0,400}?\bname:\s*['"]([^'"]+)['"]/g,
  legacy: /defineLegacyComponent\(\s*['"]([^'"]+)/g,
  jsmodel: /engine\.createJSModel\(\s*['"]([^'"]+)/g,
  on: /engine\.on\(\s*['"]([^'"]+)/g,
  trigger: /engine\.trigger\(\s*['"]([^'"]+)/g,
  proto: /\b([A-Z][\w$]*)\.prototype\.([\w$]+)\s*=(?!=)/g,
  protoDef: /Object\.defineProperty\(\s*([A-Z][\w$]*)\.prototype\s*,\s*['"]([\w$]+)/g,
  getproto: /Object\.getPrototypeOf\(/,
  lsKey: /localStorage\.(?:setItem|getItem|removeItem)\(\s*['"]([^'"]+)/g,
  ls: /\blocalStorage\b/,
  config: /(?:UserConfiguration|GameConfiguration|Configuration\.getUser\(\)|Configuration\.getGame\(\)|Configuration\.editUser\(\)|Configuration\.editGame\(\))/,
  global: /\b(?:globalThis|window)\.([A-Za-z_$][\w$]*)\s*=(?!=)/g,
  send: /\b(?:PlayerOperations|CityOperations|UnitOperations|CityCommands|UnitCommands|PlayerCommands)\.sendRequest\(|\bsendRequest\(\s*\w+\s*,\s*['"]?[A-Z_]+/,
  eval: /\beval\(|new Function\(/,
  interval: /\bsetInterval\(/g,
};

const JS_LEX = /('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g;

/** Comments removed (newlines kept, so line numbers hold); string contents untouched. */
export function stripJsComments(text) {
  return text.replace(JS_LEX, (_all, str, comment) => str ?? "\n".repeat((comment.match(/\n/g) ?? []).length));
}

export const ENTRY_ACTIONS = ["UIScripts", "ImportFiles", "ReplaceUIScript", "MapGenScripts", "ScenarioScripts"];

/**
 * @typedef {{ file: string, spec: string, kind: "static" | "dynamic" }} ImportSite
 * @typedef {{ file: string, kind: string, value: string | null }} RuntimeRef
 * @typedef {{ files: { rel: string, lines: number }[], loc: number, decorate: Record<string, number>,
 *   define: Record<string, number>, getdef: Record<string, number>, registry: Record<string, number>,
 *   jsmodel: Record<string, number>, on: Record<string, number>, trigger: Record<string, number>,
 *   proto: Record<string, string[]>, getprotoFiles: string[], lsKeys: string[], ls: boolean, config: boolean,
 *   globals: Record<string, { coop: boolean }>, sendFiles: string[], evalFiles: string[], interval: number,
 *   importSites: ImportSite[], runtimeRefs: RuntimeRef[] }} JsFacts
 */

/** @returns {JsFacts} */
function emptyFacts() {
  return {
    files: [], loc: 0, decorate: {}, define: {}, getdef: {}, registry: {}, jsmodel: {}, on: {}, trigger: {},
    proto: {}, getprotoFiles: [], lsKeys: [], ls: false, config: false, globals: {}, sendFiles: [], evalFiles: [],
    interval: 0, importSites: [], runtimeRefs: [],
  };
}

const bump = (obj, k) => { obj[k] = (obj[k] ?? 0) + 1; };

/** Import specifiers in comment-stripped source. */
export function importsOf(text, file) {
  /** @type {ImportSite[]} */
  const out = [];
  for (const m of text.matchAll(RX.importStatic)) out.push({ file, spec: m[1], kind: "static" });
  for (const m of text.matchAll(RX.importDynamic)) out.push({ file, spec: m[1], kind: "dynamic" });
  return out;
}

function scanComponents(res, text) {
  for (const k of /** @type {const} */ (["decorate", "define", "getdef"])) {
    for (const m of text.matchAll(RX[k])) bump(res[k], m[1] ? m[2] : `<${m[2]}>`);
  }
  if (text.includes("ComponentRegistry") || text.includes("registry")) {
    for (const m of text.matchAll(RX.registry)) bump(res.registry, m[1]);
  }
  for (const m of text.matchAll(RX.legacy)) bump(res.define, m[1]);
  for (const k of /** @type {const} */ (["jsmodel", "on", "trigger"])) for (const m of text.matchAll(RX[k])) bump(res[k], m[1]);
}

function scanPatches(res, text, rel) {
  for (const rx of [RX.proto, RX.protoDef]) {
    for (const m of text.matchAll(rx)) {
      const key = `${m[1]}.${m[2]}`;
      res.proto[key] ??= [];
      if (!res.proto[key].includes(rel)) res.proto[key].push(rel);
    }
  }
  if (RX.getproto.test(text)) res.getprotoFiles.push(rel);
}

// `globalThis.X = globalThis.X || {}`, `Object.assign(globalThis.X || {}, ...)`, `{ ...(window.X || {}), ... }`
// and assignments under `if (!globalThis.X)` keep what another mod put there; only a plain overwrite clobbers.
function isCooperative(text, m) {
  const name = m[1].replace(/\$/g, "\\$");
  const end = /** @type {number} */ (m.index) + m[0].length;
  const rhs = text.slice(end, end + 240).split(";")[0];
  const self = new RegExp(`(?:\\b(?:globalThis|window|self)\\.${name}\\b|^\\s*${name}\\s*(?:\\|\\||\\?\\?))`);
  if (self.test(rhs)) return true;
  const before = text.slice(Math.max(0, /** @type {number} */ (m.index) - 120), m.index);
  return new RegExp(`(?:!\\s*|typeof\\s+)(?:globalThis|window|self)\\.${name}\\b[^;{}]*\\)\\s*\\{?\\s*$`).test(before);
}

function scanGlobals(res, text) {
  for (const m of text.matchAll(RX.global)) {
    const coop = isCooperative(text, m);
    const g = (res.globals[m[1]] ??= { coop: true });
    g.coop &&= coop;
  }
}

function scanState(res, text, rel) {
  for (const m of text.matchAll(RX.lsKey)) if (!res.lsKeys.includes(m[1])) res.lsKeys.push(m[1]);
  res.ls ||= RX.ls.test(text);
  res.config ||= RX.config.test(text);
  scanGlobals(res, text);
  if (RX.send.test(text)) res.sendFiles.push(rel);
  if (RX.eval.test(text)) res.evalFiles.push(rel);
  res.interval += (text.match(RX.interval) ?? []).length;
}

// A string expression built only from literals ('a' + "b" + `c`) evaluates; anything else is computed.
export function literalValue(expr) {
  let rest = expr.trim().replace(/\)+\s*$/, "").trim();
  let out = "";
  const part = /^(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`([^`$\\]*)`)\s*(\+\s*|$)/;
  while (rest) {
    const m = part.exec(rest);
    if (!m) return null;
    out += m[1] ?? m[2] ?? m[3];
    if (!m[4] && m[0].length < rest.length) return null;
    rest = rest.slice(m[0].length);
  }
  return out || null;
}

const RUNTIME = [
  ["xhr", /\.open\(\s*['"](?:GET|POST|HEAD|PUT)['"]\s*,\s*([^,)]+)/gi],
  ["src", /\.(?:src|href)\s*=(?!=)\s*([^;\n]+)/g],
  ["src", /setAttribute\(\s*['"](?:src|href)['"]\s*,\s*([^)]+)\)/g],
];

function scanRuntime(res, text, file) {
  const seen = new Set();
  for (const [kind, rx] of RUNTIME) {
    for (const m of text.matchAll(/** @type {RegExp} */ (rx))) {
      const value = literalValue(m[1]);
      res.runtimeRefs.push({ file, kind: /** @type {string} */ (kind), value });
      if (value) seen.add(value);
    }
  }
  // an import's specifier, static or dynamic, is the import check's business: shipping mods import files their
  // modinfo never declares, so module loads are served either way
  for (const site of importsOf(text, file)) seen.add(site.spec);
  for (const m of text.matchAll(/(['"`])(fs:\/\/game\/[^'"`$]*)\1/g)) {
    if (!seen.has(m[2])) res.runtimeRefs.push({ file, kind: "literal", value: m[2] });
  }
}

/**
 * Scans the given files (absolute paths); `rel` labels are relative to `root`.
 * @param {string[]} files
 * @param {string} root
 * @param {Map<string, string>} [stripped] comment-stripped text already read, by path
 * @returns {JsFacts}
 */
export function scanJs(files, root, stripped = new Map()) {
  const res = emptyFacts();
  for (const full of files) {
    const rel = relPath(root, full);
    const text = stripped.get(full) ?? stripJsComments(readText(full));
    const lines = (text.match(/\n/g) ?? []).length + 1;
    res.files.push({ rel, lines });
    res.loc += lines;
    res.importSites.push(...importsOf(text, full));
    scanComponents(res, text);
    scanPatches(res, text, rel);
    scanState(res, text, rel);
    scanRuntime(res, text, full);
  }
  res.files.sort((a, b) => a.rel.localeCompare(b.rel));
  return res;
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/**
 * A file shipped in the mod whose path ends with `rest` (case-insensitive), as a recursive glob would find.
 * @param {{ root: string, files: string[] }} mod
 */
export function findShipped(mod, rest) {
  const want = rest.toLowerCase().replace(/^\/+/, "");
  if (!want) return null;
  const hit = mod.files.find((rel) => {
    const low = rel.toLowerCase();
    return low === want || low.endsWith(`/${want}`);
  });
  return hit ? path.join(mod.root, hit) : null;
}

/**
 * Where an import specifier lands inside the mod, or null when it points elsewhere or nowhere.
 * @param {{ root: string, files: string[], ids: string[], modinfos: { path: string }[] }} mod
 * @param {string} from importing file
 * @param {string} spec
 * @param {Map<string, string>} roots vanilla module roots
 */
export function resolveLocal(mod, from, spec, roots) {
  const s = spec.startsWith("fs://game/") ? spec.slice("fs://game".length) : spec;
  if (s.startsWith(".")) {
    const t = path.normalize(path.join(path.dirname(from), s));
    return isFile(t) ? t : null;
  }
  if (!s.startsWith("/")) return null;
  const parts = s.replace(/^\/+|\/+$/g, "").split("/");
  const first = parts[0].toLowerCase();
  const rest = parts.slice(1).join("/");
  const own = new Set([...mod.ids.map((i) => i.toLowerCase()), path.basename(mod.root).toLowerCase()]);
  if (!own.has(first) && !roots.has(first)) return null;
  for (const mi of mod.modinfos) {
    const t = path.join(path.dirname(mi.path), rest);
    if (isFile(t)) return t;
  }
  return own.has(first) ? findShipped(mod, rest) : null;
}

function entryScripts(mod, roots) {
  const todo = [];
  for (const mi of mod.modinfos) {
    const base = path.dirname(mi.path);
    const items = mi.groups.flatMap((g) => g.actions).filter((a) => ENTRY_ACTIONS.includes(a.type))
      .flatMap((a) => a.items.map(cleanItem));
    for (const item of items) {
      if (item.endsWith(".js")) todo.push(path.normalize(path.join(base, item)));
      else if (item.endsWith(".html")) todo.push(...htmlScripts(mod, path.join(base, item), roots));
    }
  }
  return todo;
}

function htmlScripts(mod, file, roots) {
  if (!isFile(file)) return [];
  return [...readText(file).matchAll(/<script[^>]+src=["']([^"']+)/g)]
    .map((m) => resolveLocal(mod, file, m[1].replace("fs://game", ""), roots))
    .filter((t) => t !== null).map((t) => path.normalize(/** @type {string} */ (t)));
}

/**
 * Scripts the modinfo loads, directly or through imports.
 * @param {{ root: string, files: string[], ids: string[], modinfos: import("./modinfo.mjs").Modinfo[],
 *   canon?: (p: string) => string }} mod
 * @param {Map<string, ImportSite[]>} sites import sites of every JS file in the mod, by file
 * @param {Map<string, string>} roots
 * @returns {Set<string>}
 */
export function computeLoaded(mod, sites, roots) {
  const canon = mod.canon ?? path.normalize;
  const todo = entryScripts(mod, roots).map(canon);
  const loaded = new Set();
  while (todo.length) {
    const f = /** @type {string} */ (todo.pop());
    if (loaded.has(f) || !isFile(f)) continue;
    loaded.add(f);
    for (const site of sites.get(f) ?? []) {
      const t = resolveLocal(mod, f, site.spec, roots);
      if (t && !loaded.has(canon(t))) todo.push(canon(t));
    }
  }
  return loaded;
}
