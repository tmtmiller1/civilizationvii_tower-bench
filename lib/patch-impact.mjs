// Which mods a game update breaks: everything a mod relied on in the old index that the new one no longer
// has. Read from files only; nothing here has run in game.
import path from "node:path";
import { vanillaSuffixes } from "./static/conflicts.mjs";
import { findShipped, stripJsComments } from "./static/jsscan.mjs";
import { code, listMore, readText, relPath } from "./static/util.mjs";
import { techniqueById, techniqueIds } from "./techniques.mjs";

/**
 * @typedef {import("./patch-snapshot.mjs").GameIndex} GameIndex
 * @typedef {import("./patch-diff.mjs").IndexDiff} IndexDiff
 * @typedef {import("./static/mod.mjs").Mod} Mod
 * @typedef {"High" | "Medium" | "Low"} Severity
 * @typedef {{ severity: Severity, rule: string, text: string, was: string, now: string, fix: string,
 *   file?: string, files?: string[], techniques: string[] }} PatchFinding
 * @typedef {{ spec: string, names: string[] | null, dynamic: boolean }} ImportClause
 */

// Offered until the lead's RULE_TECHNIQUES carries "patch:<rule>" keys; only ids the library has survive.
export const PATCH_TECHNIQUES = {
  "removed-file": ["import-current-paths", "version-resilient-binding", "chunk-bundle-imports"],
  "removed-file-dynamic": ["optional-dynamic-import", "import-current-paths"],
  "removed-export": ["version-resilient-binding", "import-current-paths"],
  "removed-component": ["componentregistry-override", "decorate-dont-replace"],
  "removed-table": ["match-current-schema"],
  "removed-column": ["match-current-schema"],
  "newly-required-column": ["match-current-schema"],
  "removed-effect-type": ["match-current-schema"],
  "stale-override": ["same-path-shadowing", "decorate-dont-replace", "line-number-coupling"],
  "override-removed": ["same-path-shadowing", "import-current-paths"],
};

export function techniquesFor(rule) {
  const ids = techniqueIds(`patch:${rule}`);
  return ids.length ? ids : (PATCH_TECHNIQUES[rule] ?? []).filter((id) => techniqueById(id));
}

const SEVERITY = { High: 0, Medium: 1, Low: 2 };
export const bySeverity = (x, y) => SEVERITY[x.severity] - SEVERITY[y.severity] || x.rule.localeCompare(y.rule);

/**
 * The parts of an index the import resolver needs, keyed lower case.
 * @param {GameIndex} idx
 */
export function indexView(idx) {
  const files = new Map(Object.entries(idx.files).map(([k, v]) => [k.toLowerCase(), v]));
  /** @type {Map<string, Set<string>>} */
  const rel = new Map();
  const roots = new Map();
  for (const k of files.keys()) {
    const [mod, ...rest] = k.split("/");
    roots.set(mod, mod);
    const r = rest.join("/");
    if (!rel.has(r)) rel.set(r, new Set());
    /** @type {Set<string>} */ (rel.get(r)).add(mod);
  }
  const exportsOf = new Map(Object.entries(idx.exports).map(([k, v]) => [k.toLowerCase(), v]));
  const stars = new Map(Object.entries(idx.stars ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return { version: idx.version, files, rel, roots, exportsOf, stars, hasPath: (p) => files.has(p.toLowerCase()) };
}

/** @typedef {ReturnType<typeof indexView>} IndexView */

/**
 * Does the module export this name, directly or through `export * from`? null when the index has no
 * exports for it (not a script, or nothing the parser recognised).
 * @param {IndexView} view
 * @returns {boolean | null}
 */
export function exportsName(view, file, name, depth = 0) {
  const names = view.exportsOf.get(file);
  const stars = view.stars.get(file) ?? [];
  if (!names && !stars.length) return null;
  if (names && name in names) return true;
  if (depth > 4 || name === "default") return false;
  return stars.some((s) => exportsName(view, starTarget(file, s), name, depth + 1) === true);
}

const starTarget = (file, spec) => (spec.startsWith(".")
  ? path.posix.normalize(path.posix.join(path.posix.dirname(file), spec))
  : spec.replace(/^fs:\/\/game\//, "").replace(/^\/+/, "")).toLowerCase();

const IMPORT_FROM = /(?:^|[;\s}])import\s*([\w*\s{},$]*?)\s*from\s*['"]([^'"]+)['"]/gm;
const IMPORT_BARE = /(?:^|[;\s}])import\s*['"]([^'"]+)['"]/gm;
const EXPORT_FROM = /(?:^|[;\s}])export\s*(\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/gm;
const DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Imported names of one clause: [] for none, null for a namespace import. */
function clauseNames(clause) {
  const c = clause.trim();
  if (/\*\s*as\s/.test(c) || c === "*" || /^\*\s*as/.test(c)) return null;
  const names = [];
  const braces = c.match(/\{([^}]*)\}/);
  if (braces) {
    for (const part of braces[1].split(",").map((p) => p.trim()).filter(Boolean)) names.push(part.split(/\s+as\s+/)[0].trim());
  }
  if (/^[\w$]+/.test(c.replace(/^\{[^}]*\}/, "").trim())) names.unshift("default");
  return names;
}

/**
 * Every import in comment-stripped source, with the names it takes.
 * @param {string} text
 * @returns {ImportClause[]}
 */
export function importClauses(text) {
  /** @type {ImportClause[]} */
  const out = [];
  for (const m of text.matchAll(IMPORT_FROM)) out.push({ spec: m[2], names: clauseNames(m[1]), dynamic: false });
  for (const m of text.matchAll(IMPORT_BARE)) out.push({ spec: m[1], names: [], dynamic: false });
  for (const m of text.matchAll(EXPORT_FROM)) {
    out.push({ spec: m[2], names: m[1].startsWith("*") ? null : clauseNames(m[1]), dynamic: false });
  }
  for (const m of text.matchAll(DYNAMIC)) out.push({ spec: m[1], names: null, dynamic: true });
  return out;
}

/** The file's locations in the game's file system: /<id>/<rel>, and any vanilla path it mirrors. */
function bases(mod, full, view) {
  const out = [];
  for (const mi of mod.modinfos) {
    const rel = path.relative(path.dirname(mi.path), full).split(path.sep).join("/");
    if (rel.startsWith("..")) continue;
    out.push(rel, ...mod.ids.map((i) => `${i}/${rel}`), ...vanillaSuffixes(rel, view), `base-standard/${rel}`, `core/${rel}`);
  }
  return out;
}

const withJs = (view, t) => (view.files.has(t) ? t : view.files.has(`${t}.js`) ? `${t}.js` : null);

/**
 * The game file (lower case) an import in `from` landed on in this index, or null when it lands in the
 * mod, another mod, or nowhere in the game.
 * @param {Mod} mod @param {string} from absolute path of the importing file @param {IndexView} view
 */
export function gameTarget(mod, from, spec, view) {
  const s = spec.replace(/^fs:\/\/game\//, "/").split(/[?#]/)[0];
  if (/^[a-z]+:/i.test(s)) return null;
  if (s.startsWith("/")) {
    const parts = s.replace(/^\/+/, "").split("/");
    if (!view.roots.has(parts[0].toLowerCase()) || findShipped(mod, parts.slice(1).join("/"))) return null;
    return withJs(view, parts.join("/").toLowerCase());
  }
  if (!s.startsWith(".")) return null;
  const local = path.normalize(path.join(path.dirname(from), s));
  if (mod.files.some((f) => path.join(mod.root, f).toLowerCase() === local.toLowerCase())) return null;
  for (const b of bases(mod, from, view)) {
    // URL semantics: ".." clamps at the root
    const t = path.posix.normalize(`/${path.posix.join(path.posix.dirname(b), s)}`).replace(/^\/+/, "").toLowerCase();
    const hit = withJs(view, t);
    if (hit) return hit;
  }
  return null;
}

/** @returns {PatchFinding} */
export function patchFinding(severity, rule, fields) {
  return { severity, rule, ...fields, techniques: techniquesFor(rule) };
}

/** Collects findings, one per rule and subject, with every file that hits it. */
export class Findings {
  constructor() {
    /** @type {Map<string, PatchFinding>} */
    this.map = new Map();
  }

  add(key, file, make) {
    const cur = this.map.get(key);
    if (cur) {
      if (file && !cur.files?.includes(file)) cur.files = [...(cur.files ?? []), file];
      return;
    }
    this.map.set(key, { ...make(), ...(file ? { file, files: [file] } : {}) });
  }

  list() { return [...this.map.values()].sort(bySeverity); }
}

function successorText(ctx, target, names) {
  const s = ctx.diff.successors[target];
  if (!s) return { now: `gone in ${ctx.b.version}`, fix: "find what replaced it with game diff, or stop importing it" };
  const at = `/${s.to}`;
  const how = { moved: "moved unchanged to", renamed: "renamed to", "same-name": "probably replaced by" }[s.how];
  const lost = (names ?? []).filter((n) => exportsName(ctx.newView, s.to.toLowerCase(), n) === false);
  const exp = Object.keys(ctx.newView.exportsOf.get(s.to.toLowerCase()) ?? {});
  const note = lost.length ? `; it does not export ${lost.map(code).join(", ")} (it exports ${listMore(exp, 6, code) || "nothing"})` : "";
  return { now: `${how} ${code(at)}${note}`, fix: `import from ${code(at)}${lost.length ? " and rebind the names it exports now" : ""}` };
}

/**
 * Imports of files the new version removed or moved, and of names it no longer exports.
 * @param {Mod} mod @param {any} ctx @param {Findings} out
 */
export function importFindings(mod, ctx, out) {
  for (const file of [...mod.loadedJs].sort()) {
    let text = "";
    try { text = stripJsComments(readText(file)); } catch { continue; }
    const rel = relPath(mod.root, file);
    for (const site of importClauses(text)) {
      const t = gameTarget(mod, file, site.spec, ctx.oldView);
      if (!t) continue;
      if (!ctx.newView.files.has(t)) removedImport(ctx, out, { site, t, rel });
      else removedNames(ctx, out, { site, t, rel });
    }
  }
}

function removedImport(ctx, out, { site, t, rel }) {
  const { now, fix } = successorText(ctx, t, site.names);
  const rule = site.dynamic ? "removed-file-dynamic" : "removed-file";
  out.add(`${rule}\u0001${t}`, rel, () => patchFinding(site.dynamic ? "Low" : "Medium", rule, {
    text: site.dynamic
      ? `dynamically imports ${code(`/${t}`)}, which ${ctx.b.version} no longer ships at that path; the promise rejects (harmless only if caught).`
      : `imports ${code(`/${t}`)}, which ${ctx.b.version} no longer ships at that path; the importing module fails to load.`,
    was: `${ctx.a.version}: /${t}`, now: `${ctx.b.version}: ${now}`, fix,
  }));
}

function removedNames(ctx, out, { site, t, rel }) {
  const lost = (site.names ?? [])
    .filter((n) => exportsName(ctx.oldView, t, n) === true && exportsName(ctx.newView, t, n) === false);
  if (!lost.length) return;
  const change = ctx.diff.exports.find((e) => e.file.toLowerCase() === t);
  const renames = lost.map((n) => change?.renamed.find((r) => r.from === n)).filter(Boolean);
  out.add(`removed-export\u0001${t}\u0001${lost.join(",")}`, rel, () => patchFinding("Medium", "removed-export", {
    text: `imports ${lost.map(code).join(", ")} from ${code(`/${t}`)}, which ${ctx.b.version} no longer exports; the importing module fails to load.`,
    was: `${ctx.a.version}: exports ${lost.join(", ")}`,
    now: `${ctx.b.version}: ${renames.length ? renames.map((r) => `${r?.from} is now ${r?.to}`).join(", ") : `exports ${listMore(change?.added ?? [], 6, code) || "other names"}`}`,
    fix: renames.length ? `import ${renames.map((r) => code(r?.to)).join(", ")} instead` : "rebind to what the module exports now, or bind at run time",
  }));
}

/**
 * Decorations, definitions and ui-next registrations of components the new version no longer defines.
 * @param {Mod} mod @param {any} ctx @param {Findings} out
 */
export function componentFindings(mod, ctx, out) {
  const legacy = new Set(ctx.diff.components.legacy.removed);
  const registry = new Set(ctx.diff.components.registry.removed);
  const uses = [["decorate", "decorates", legacy], ["getdef", "reads the definition of", legacy],
    ["define", "redefines", legacy], ["registry", "registers a ui-next override for", registry]];
  for (const [kind, verb, gone] of /** @type {[string, string, Set<string>][]} */ (uses)) {
    for (const name of Object.keys(mod.js[kind] ?? {}).filter((n) => gone.has(n))) {
      out.add(`removed-component\u0001${kind}\u0001${name}`, null, () => patchFinding("Medium", "removed-component", {
        text: `${verb} ${code(name)}, which ${ctx.b.version} no longer defines; that code never attaches.`,
        was: `${ctx.a.version}: ${kind === "registry" ? "ui-next component" : "component"} ${name}`,
        now: `${ctx.b.version}: not defined (${componentHint(ctx, name)})`,
        fix: "find the screen's new component in game diff and decorate or wrap that one",
      }));
    }
  }
}

function componentHint(ctx, name) {
  const words = name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
  const added = [...ctx.diff.components.legacy.added, ...ctx.diff.components.registry.added];
  const near = added.filter((a) => words.some((w) => a.toLowerCase().includes(w)));
  return near.length ? `similar new names: ${listMore(near, 4, code)}` : "no similarly named component was added";
}

/**
 * Replaced game files (ImportFiles at a game path) whose game original changed or went away: the mod's copy
 * now hides the new version's code.
 * @param {Mod} mod @param {any} ctx @param {Findings} out
 */
export function overrideFindings(mod, ctx, out) {
  for (const ov of mod.overrides) {
    for (const p of new Set(vanillaSuffixes(ov.item, ctx.oldView).map((x) => x.toLowerCase()))) {
      const before = ctx.oldView.files.get(p);
      if (!before) continue;
      const after = ctx.newView.files.get(p);
      if (after && (after[0] === before[0] || after[0] === ov.digest)) continue;
      if (!after) {
        const { now, fix } = successorText(ctx, p, null);
        out.add(`override-removed\u0001${p}`, ov.item, () => patchFinding("Medium", "override-removed", {
          text: `replaces ${code(`/${p}`)}, which ${ctx.b.version} no longer ships; the replacement is now dead code.`,
          was: `${ctx.a.version}: /${p}`, now: `${ctx.b.version}: ${now}`, fix: `port the change to the new file (${fix})`,
        }));
        continue;
      }
      const copy = ov.digest === before[0] ? " The mod's copy is the old file unchanged." : "";
      out.add(`stale-override\u0001${p}`, ov.item, () => patchFinding("Medium", "stale-override", {
        text: `replaces ${code(`/${p}`)}, which changed in ${ctx.b.version}; the mod's copy hides the new code.${copy}`,
        was: `${ctx.a.version}: ${before[0].slice(0, 10)} (${before[1]} bytes)`,
        now: `${ctx.b.version}: ${after[0].slice(0, 10)} (${after[1]} bytes)`,
        fix: copy ? "delete the copy, or decorate the component instead" : "re-apply the mod's edits to the new file, or decorate instead of replacing",
      }));
    }
  }
}

