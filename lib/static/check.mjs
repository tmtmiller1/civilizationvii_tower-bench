// Static defects of one mod against the installed game: files the modinfo lists but does not ship, imports
// that resolve nowhere, decorators with no target, files fetched at run time that no action declares, and
// (with a schema) database statements the game rejects.
import fs from "node:fs";
import path from "node:path";
import { databaseFindings, finding, textFindings } from "./checkdb.mjs";
import { vanillaSuffixes } from "./conflicts.mjs";
import { findShipped } from "./jsscan.mjs";
import { code, listMore, push, relPath } from "./util.mjs";

/**
 * @typedef {import("./mod.mjs").Mod} Mod
 * @typedef {import("./checkdb.mjs").Finding} Finding
 */

const ART = /\.(dds|png|jpe?g|blp|tga|svg|webp|gif|ogg|wav|mp3|mp4|webm|ttf|otf|woff2?|fxs|ast|bnk|wem)$/i;
const DATA_ACTIONS = new Set(["UpdateDatabase", "UpdateText", "UpdateIcons", "UpdateColors", "UpdateVisualRemaps"]);

/** @type {WeakMap<object, any>} */
const CONTEXTS = new WeakMap();

/** Facts about the set of analysed mods that a single mod's check needs; built once per list. */
function corpusContext(mods) {
  let c = CONTEXTS.get(mods);
  if (c) return c;
  c = { ids: new Set(), byId: new Map(), defined: new Set(), tableCreators: new Map() };
  for (const m of mods) {
    for (const i of m.ids) {
      c.ids.add(i.toLowerCase());
      if (!c.byId.has(i.toLowerCase())) c.byId.set(i.toLowerCase(), m);
    }
    for (const n of Object.keys(m.js.define)) c.defined.add(n);
    for (const t of m.createdTables) push(c.tableCreators, t, m);
  }
  CONTEXTS.set(mods, c);
  return c;
}

/** @param {import("./mod.mjs").MissingItem} x */
function missingVerdict(x) {
  if (ART.test(x.item)) return "MINOR"; // a listed .dds the mod does not ship was watched loading cleanly
  if (DATA_ACTIONS.has(x.action)) return "BLOCKS GAME";
  return /\.(js|html|css)$/i.test(x.item) ? "FEATURE DEAD" : "MINOR";
}

/** @param {Mod} mod @returns {Finding[]} */
function modinfoFindings(mod) {
  /** @type {Finding[]} */
  const out = [];
  const groups = new Map();
  for (const x of mod.missing) push(groups, `${x.modinfo}\u0001${missingVerdict(x)}`, x);
  for (const [key, list] of groups) out.push(missingFinding(key.split("\u0001")[1], list));
  for (const mi of mod.modinfos) {
    const name = path.basename(mi.path);
    if (mi.xmlError) {
      out.push(finding("modinfo-malformed", "FEATURE DEAD", `${name} is not well-formed XML even after lenient cleanup (${mi.xmlError}); the game's parser may reject the mod.`,
        { file: name, evidence: { error: mi.xmlError } }));
    }
    for (const item of mi.outside) {
      out.push(finding("item-outside-mod", "MINOR", `${name} lists ${code(item)}, which points outside the mod folder; a mod's items are its own files.`,
        { file: name, evidence: { item } }));
    }
  }
  return out;
}

const MISSING_EFFECT = {
  "BLOCKS GAME": "; the failed file rolls the database back (watched on 1.5.0)",
  "FEATURE DEAD": "; those scripts never run",
  MINOR: "",
};

/** @param {import("./mod.mjs").MissingItem[]} list */
function missingFinding(verdict, list) {
  const what = listMore(list, 3, (x) => `${code(x.item)} (${x.action})`);
  const items = list.map(({ item, action }) => ({ item, action }));
  return finding("missing-listed-file", verdict, `${list[0].modinfo} lists ${list.length} file(s) the mod folder does not ship: ${what}${MISSING_EFFECT[verdict]}.`,
    { file: list[0].modinfo, evidence: { modinfo: list[0].modinfo, items } });
}

/** The file's locations in the game's file system: /<id>/<rel>, and any vanilla path it mirrors. */
function importBases(mod, full, vanilla) {
  const bases = [];
  const spec = new Set();
  for (const mi of mod.modinfos) {
    const rel = path.relative(path.dirname(mi.path), full).split(path.sep).join("/");
    if (rel.startsWith("..")) continue;
    bases.push(rel, ...mod.ids.map((i) => `${i}/${rel}`), ...vanillaSuffixes(rel, vanilla));
    // a module-relative file may override a vanilla file that moved: resolve it as if mounted, but never
    // report a defect from these speculative bases
    spec.add(`base-standard/${rel}`);
    spec.add(`core/${rel}`);
  }
  return { bases, spec };
}

/** Resolves a relative import against every base; returns "ok", an escaped vanilla path, or null. */
function resolveRelative(mod, site, s, vanilla) {
  const target = path.normalize(path.join(path.dirname(site.file), s));
  if (fs.existsSync(target) || fs.existsSync(`${target}.js`)) return "ok";
  const escaped = escapedTarget(importBases(mod, site.file, vanilla), s, vanilla);
  // the mod ships the file at the module-relative path (watched: such an import loads)
  if (escaped && escaped !== "ok" && findShipped(mod, escaped.split("/").slice(1).join("/"))) return "ok";
  return escaped;
}

/**
 * "ok" when the import lands on a game file from any base; else the vanilla path it escapes to, or null.
 * @param {{ bases: string[], spec: Set<string> }} where
 */
function escapedTarget({ bases, spec }, s, vanilla) {
  let escaped = null;
  for (const b of [...bases, ...[...spec].sort()]) {
    // URL semantics: ".." clamps at the root
    const t = path.posix.normalize(`/${path.posix.join(path.posix.dirname(b), s)}`).replace(/^\/+/, "");
    if (vanilla.hasPath(t)) return "ok";
    const inGame = !spec.has(b) && vanilla.roots.has(t.split("/")[0].toLowerCase());
    if (inGame && (!escaped || vanilla.hasPath(t.replace(".chunk.js", ".js")))) escaped = t;
  }
  return escaped;
}

class ImportCheck {
  /** @param {Mod} mod @param {import("./game.mjs").Vanilla} vanilla */
  constructor(mod, vanilla, ctx) {
    this.mod = mod;
    this.vanilla = vanilla;
    this.ctx = ctx;
    this.folderIds = new Set([...mod.ids.map((i) => i.toLowerCase()), path.basename(mod.root).toLowerCase()]);
    /** @type {Record<string, Map<string, string[]>>} */
    this.hits = { vanilla: new Map(), dynamic: new Map(), optional: new Map(), local: new Map(), cross: new Map() };
  }

  note(kind, spec, file) { push(this.hits[kind], spec, relPath(this.mod.root, file)); }

  visit(site) {
    let s = site.spec;
    if (s.startsWith("fs://game/")) s = `/${s.slice("fs://game/".length)}`;
    if (/^https?:/.test(s)) return;
    if (s.startsWith(".")) return this.relative(site, s);
    if (s.startsWith("/")) this.absolute(site, s);
  }

  relative(site, s) {
    const r = resolveRelative(this.mod, site, s, this.vanilla);
    if (r === "ok") return;
    if (r) this.note(site.kind === "dynamic" ? "dynamic" : "vanilla", `/${r}`, site.file);
    else this.note(site.kind === "dynamic" ? "optional" : "local", site.spec, site.file);
  }

  absolute(site, s) {
    const parts = s.replace(/^\/+/, "").split("/");
    const first = parts[0].toLowerCase();
    const rest = parts.slice(1).join("/");
    const full = s.replace(/^\/+/, "");
    if (this.vanilla.roots.has(first)) {
      // modules shipped inside this mod at a vanilla-mirroring path are served from the mod
      if (!this.vanilla.hasPath(full) && !this.vanilla.hasPath(`${full}.js`) && !findShipped(this.mod, rest)) {
        this.note(site.kind === "dynamic" ? "dynamic" : "vanilla", site.spec, site.file);
      }
    } else if (this.folderIds.has(first)) {
      if (!findShipped(this.mod, rest) && !fs.existsSync(path.join(this.mod.root, rest))) this.note("local", site.spec, site.file);
    } else if (this.ctx.ids.has(first)) {
      this.note("cross", site.spec, site.file);
    }
  }

  *findings() {
    const v = this.vanilla.version;
    const make = (kind, rule, verdict, text) => [...this.hits[kind]].sort()
      .map(([spec, files]) => finding(rule, verdict, text(spec), { file: files[0], evidence: { spec, files } }));
    yield* make("vanilla", "unresolved-import", "FEATURE DEAD", (s) => `imports ${code(s)}, which does not exist in game ${v}; the importing module fails to load.`);
    yield* make("dynamic", "unresolved-dynamic-import", "MINOR", (s) => `dynamically imports ${code(s)}, which does not exist in game ${v}; the import promise rejects (harmless only if the mod catches it, as version probes usually do).`);
    yield* make("optional", "missing-optional-import", "MINOR", (s) => `dynamically imports its own ${code(s)}, which does not ship; usually a deliberate optional or dev-only file, harmless if the promise's rejection is caught.`);
    yield* make("local", "unresolved-import", "FEATURE DEAD", (s) => `imports ${code(s)}, which is not in the mod folder; the importing module fails to load.`);
    yield* make("cross", "cross-mod-import", "MINOR", (s) => `imports ${code(s)} from another mod; it breaks if that mod is absent or disabled.`);
  }
}

/** @param {Mod} mod */
function decorateFindings(mod, vanilla, ctx) {
  return Object.keys(mod.js.decorate)
    .filter((n) => !n.startsWith("<") && !vanilla.components.has(n) && !vanilla.mentions(n) && !ctx.defined.has(n)
      && !(n in mod.js.define))
    .map((n) => finding("unknown-decorate-target", "FEATURE DEAD", `decorates ${code(n)}, which no ${vanilla.version} component or analysed mod defines; the decorator never attaches.`,
      { evidence: { component: n } }));
}

function declaredMatch(mod, rel) {
  const low = rel.toLowerCase();
  if (mod.declared.has(low)) return true;
  return [...mod.declared].some((d) => /[*?]/.test(d)
    && new RegExp(`^${d.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`).test(low));
}

/**
 * Where a run-time reference lands inside this mod: a mod file path, "skip" when it points elsewhere, or
 * null when the path cannot be placed (a relative URL resolves against the page, not the script).
 * @param {Mod} mod
 */
function runtimeTarget(mod, ref) {
  const v = String(ref.value).split(/[?#]/)[0];
  if (/^(https?|data|blob|about|coui|javascript):/i.test(v) || !v) return "skip";
  const s = v.startsWith("fs://game/") ? v.slice("fs://game".length) : v;
  if (!s.startsWith("/")) return null;
  const [first, ...rest] = s.replace(/^\/+/, "").split("/");
  const mi = mod.modinfos.find((m) => m.id && m.id.toLowerCase() === first.toLowerCase());
  return mi ? path.join(path.dirname(mi.path), rest.join("/")) : "skip";
}

/**
 * Run-time file references in the mod's loaded scripts (XHR, script/link src, import(), fs://game/<id>/
 * literals): which land on a shipped but undeclared file, and how many could not be checked.
 * @param {Mod} mod
 */
export function runtimeRefs(mod) {
  /** @type {{ file: string, path: string, kind: string }[]} */
  const undeclared = [];
  let unresolved = 0;
  let checked = 0;
  for (const ref of mod.js.runtimeRefs) {
    const target = ref.value === null ? null : runtimeTarget(mod, ref);
    if (target === "skip") continue;
    if (target === null) { unresolved++; continue; }
    checked++;
    const rel = relPath(mod.root, target);
    if (rel.startsWith("..") || !fs.existsSync(target) || fs.statSync(target).isDirectory()) continue;
    if (declaredMatch(mod, rel) || undeclared.some((u) => u.path === rel)) continue;
    undeclared.push({ file: relPath(mod.root, ref.file), path: rel, kind: ref.kind });
  }
  return { checked, unresolved, undeclared };
}

// MINOR until the rule is settled in game: one watched test found fs:// serving only declared files to XHR,
// while shipping mods import undeclared modules without trouble.
const runtimeVerdict = () => "MINOR";

/** @param {Mod} mod */
function runtimeFindings(mod) {
  const r = runtimeRefs(mod);
  const unchecked = r.unresolved ? ` ${r.unresolved} computed path(s) in the loaded scripts could not be checked.` : "";
  const byVerdict = new Map();
  for (const u of r.undeclared) push(byVerdict, runtimeVerdict(), u);
  return [...byVerdict].map(([verdict, list]) => finding("undeclared-runtime-file", verdict,
    `loads ${list.length} file(s) at run time that no modinfo action declares: ${listMore(list, 3, (u) => `${code(u.path)} (${u.kind} in ${u.file})`)}. These may fail to load: an XHR of an undeclared file was refused in one watched test (2026-09-15), though module imports of undeclared files work. Declaring them (ImportFiles) removes the doubt.${unchecked}`,
    { file: list[0].file, evidence: { files: list, unresolved: r.unresolved } }));
}

/**
 * Static defects of one mod.
 * @param {Mod} mod
 * @param {{ vanilla: import("./game.mjs").Vanilla, schema?: import("./game.mjs").Schema | null,
 *   otherMods?: Mod[] }} opts
 *   otherMods: the other mods analysed alongside (for declared dependencies, table creators and defined components)
 * @returns {Finding[]}
 */
export function checkMod(mod, { vanilla, schema = null, otherMods = [] }) {
  const ctx = corpusContext(otherMods);
  const imports = new ImportCheck(mod, vanilla, ctx);
  for (const site of mod.js.importSites) imports.visit(site);
  /** @type {Finding[]} */
  const out = [
    ...modinfoFindings(mod), ...imports.findings(), ...decorateFindings(mod, vanilla, ctx), ...runtimeFindings(mod),
  ];
  if (schema) out.push(...databaseFindings(mod, { ...ctx, vanilla, schema, baseRows: vanilla.rowKeys(schema) }));
  out.push(...textFindings(mod, vanilla));
  for (const e of mod.dbErrors) {
    out.push(finding("malformed-data-xml", "FEATURE DEAD", `data file ${code(e.file)} is not well-formed XML even after lenient cleanup (${e.error}); the game likely skips the whole file.`,
      { file: e.file, evidence: e }));
  }
  return out;
}
