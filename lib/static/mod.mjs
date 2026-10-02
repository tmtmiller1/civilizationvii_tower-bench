// One mod folder read into the facts the conflict finder and the checker work from.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dbOpsForFile } from "./dbops.mjs";
import { computeLoaded, importsOf, scanJs, stripJsComments } from "./jsscan.mjs";
import { cleanItem, groupAges, isConditional, parseModinfo } from "./modinfo.mjs";
import { readText, relPath, walkFiles } from "./util.mjs";
import { textFromModFiles } from "../mods.mjs";

/**
 * @typedef {{ db: string, file: string, scope: string, locale: string | null, op: import("./dbops.mjs").DbOp }} ModDbOp
 * @typedef {{ modinfo: string, item: string, action: string }} MissingItem
 * @typedef {{ folder: string, root: string, id: string, ids: string[], name: string,
 *   modinfos: import("./modinfo.mjs").Modinfo[], files: string[], canon: (p: string) => string,
 *   missing: MissingItem[], overrides: { item: string, action: string, digest: string | null }[],
 *   dbOps: ModDbOp[], dbErrors: { file: string, error: string }[], createdTables: Set<string>,
 *   loc: Map<string, { lang: string, tag: string, text: string }>, declared: Set<string>,
 *   js: import("./jsscan.mjs").JsFacts, loadedJs: Set<string>, unloadedJs: string[] }} Mod
 */

// Actions whose items must ship in the mod folder (UpdateArt names art packages, not files).
const ITEM_CHECK_ACTIONS = new Set(["UpdateDatabase", "UpdateText", "UpdateIcons", "UIScripts", "ImportFiles", "UpdateColors",
  "ReplaceUIScript", "MapGenScripts", "ScenarioScripts", "UpdateVisualRemaps"]);
const DB_ACTIONS = { UpdateDatabase: null, UpdateText: "localization", UpdateIcons: "icons", UpdateColors: "colors" };

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function wildcard(item) {
  const rx = item.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${rx}$`);
}

/** Does `item` (relative to the modinfo's folder) name a shipped file, or match one as a wildcard? */
function ships(mod, base, item) {
  const target = path.join(base, item);
  const rel = relPath(mod.root, target).toLowerCase();
  if (fs.existsSync(target) || mod.files.some((f) => f.toLowerCase() === rel)) return true;
  if (!/[*?]/.test(item)) return false;
  const rx = wildcard(rel);
  return mod.files.some((rel) => rx.test(rel.toLowerCase()));
}

/**
 * @param {string} folder
 * @param {{ vanilla?: import("./game.mjs").Vanilla | null }} [opts]
 * @returns {Mod}
 */
export function loadMod(folder, opts = {}) {
  const root = path.resolve(folder);
  const files = walkFiles(root).map((f) => relPath(root, f));
  const byLower = new Map(files.map((rel) => [path.join(root, rel).toLowerCase(), path.join(root, rel)]));
  const modinfos = files.filter((f) => f.endsWith(".modinfo")).map((f) => parseModinfo(path.join(root, f)));
  const ids = modinfos.map((mi) => mi.id).filter((i) => i !== null);
  /** @type {Mod} */
  const mod = {
    folder, root, id: ids[0] ?? path.basename(root), ids, name: "", modinfos, files,
    canon: (p) => byLower.get(path.normalize(p).toLowerCase()) ?? path.normalize(p),
    missing: [], overrides: [], dbOps: [], dbErrors: [], createdTables: new Set(), loc: new Map(), declared: new Set(),
    js: scanJs([], root), loadedJs: new Set(), unloadedJs: [],
  };
  for (const mi of modinfos) readGroups(mod, mi);
  for (const mi of modinfos) for (const [tag, text] of Object.entries(mi.loc)) setLoc(mod, "en_us", tag, text, false);
  readJs(mod, opts.vanilla?.roots ?? new Map());
  mod.name = modName(mod);
  return mod;
}

function modName(mod) {
  const n = mod.modinfos[0]?.props.Name;
  if (!n) return path.basename(mod.root);
  if (!n.startsWith("LOC_")) return n;
  // The name tag can live in a file the modinfo loads through <LocalizedText>, outside any action group.
  return mod.loc.get(`en_us\u0001${n}`)?.text ?? textFromModFiles(mod.modinfos[0].path, n) ?? mod.ids[0] ?? path.basename(mod.root);
}

function setLoc(mod, lang, tag, text, overwrite = true) {
  const key = `${lang}\u0001${tag}`;
  if (overwrite || !mod.loc.has(key)) mod.loc.set(key, { lang, tag, text });
}

function readGroups(mod, mi) {
  const base = path.dirname(mi.path);
  const miName = path.basename(mi.path);
  for (const g of mi.groups) {
    for (const a of g.actions) {
      a.items.forEach((raw, n) => {
        const item = cleanItem(raw);
        if (mi.outside.includes(item)) return;
        mod.declared.add(relPath(mod.root, path.join(base, item)).toLowerCase());
        readItem(mod, { miName, base, g, action: a.type, item, locale: a.locales[n] });
      });
    }
  }
}

function readItem(mod, { miName, base, g, action, item, locale }) {
  const exists = ships(mod, base, item);
  if (ITEM_CHECK_ACTIONS.has(action) && !exists && !item.startsWith("{")
    && !mod.missing.some((x) => x.item === item && x.action === action && x.modinfo === miName)) {
    mod.missing.push({ modinfo: miName, item, action });
  }
  const target = path.join(base, item);
  if (action === "ImportFiles" || action === "ReplaceUIScript") {
    const digest = isFile(target) ? crypto.createHash("sha1").update(fs.readFileSync(target)).digest("hex") : null;
    mod.overrides.push({ item, action, digest });
  }
  if (action in DB_ACTIONS && isFile(target)) readDbFile(mod, { g, action, target, locale });
}

function readDbFile(mod, { g, action, target, locale }) {
  const db = DB_ACTIONS[action] ?? (g.scope === "shell" ? "frontend" : "gameplay");
  let parsed;
  try { parsed = dbOpsForFile(target); } catch (e) { parsed = { ops: [], error: `analyzer could not parse (${e})` }; }
  const file = relPath(mod.root, target);
  if (parsed.error && !mod.dbErrors.some((x) => x.file === file && x.error === parsed.error)) {
    mod.dbErrors.push({ file, error: parsed.error });
  }
  const ages = groupAges(g);
  const conditional = isConditional(g);
  for (const op of parsed.ops) {
    op.ages = ages;
    op.conditional = conditional;
    mod.dbOps.push({ db, file, scope: g.scope, locale, op });
    if (op.op === "create") mod.createdTables.add(op.table.toLowerCase());
    readLocRow(mod, op);
  }
}

function readLocRow(mod, op) {
  const t = op.table.toLowerCase();
  if ((t !== "localizedtext" && t !== "englishtext") || !["row", "replace", "ignore"].includes(op.op)) return;
  const v = op.values ?? {};
  if (!v.tag) return;
  const lang = t === "englishtext" ? "en_us" : String(v.language ?? "en_US").toLowerCase();
  setLoc(mod, lang, v.tag, v.text ?? "");
}

function readJs(mod, roots) {
  const jsFiles = mod.files.filter((rel) => /\.m?js$/.test(rel) && !/\.(min\.js|d\.ts)$/.test(rel))
    .map((rel) => path.join(mod.root, rel));
  /** @type {Map<string, string>} */
  const stripped = new Map();
  /** @type {Map<string, import("./jsscan.mjs").ImportSite[]>} */
  const sites = new Map();
  for (const f of jsFiles) {
    let text = "";
    try { text = stripJsComments(readText(f)); } catch { /* unreadable */ }
    stripped.set(f, text);
    sites.set(f, importsOf(text, f));
  }
  const loaded = new Set([...computeLoaded(mod, sites, roots)].map(mod.canon));
  mod.loadedJs = loaded;
  mod.unloadedJs = jsFiles.filter((f) => !loaded.has(f)).map((f) => relPath(mod.root, f));
  mod.js = scanJs([...loaded].filter((f) => stripped.has(f)).sort(), mod.root, stripped);
}
