// Localization lint for one mod folder, read from files: the LOC tags it uses against the tags it defines in
// English, each shipped language against English, duplicate tags, language codes and locale attributes,
// placeholders, and fonts that cannot draw CJK text. The live half (scanGlyphs) walks the running UI.
import fs from "node:fs";
import path from "node:path";
import { BenchError } from "./bench.mjs";
import { scanGlyphs } from "./engine-l10n.mjs";
import { canonLang, fontFindings, isEnglish, localeFindings, placeholderFindings } from "./l10n-rules.mjs";
import { textFindings } from "./static/checkdb.mjs";
import { dbOpsForFile } from "./static/dbops.mjs";
import { Vanilla } from "./static/game.mjs";
import { stripJsComments } from "./static/jsscan.mjs";
import { loadMod } from "./static/mod.mjs";
import { code, listMore, readText, relPath } from "./static/util.mjs";
import { techniqueIds } from "./techniques.mjs";

/**
 * @typedef {import("./l10n-rules.mjs").TextEntry} TextEntry
 * @typedef {import("./l10n-rules.mjs").L10nFinding} L10nFinding
 * @typedef {{ files: Set<string>, js: boolean, other: boolean }} Use
 */

const TEXT_TABLES = new Set(["localizedtext", "englishtext"]);
const INSERTS = new Set(["row", "replace", "ignore"]);
const RANK = { error: 0, warn: 1, info: 2 };

/** A text row as an entry, or null when the op inserts no text. @returns {TextEntry | null} */
function opEntry(op, file, locale, scope) {
  const t = op.table.toLowerCase();
  const v = op.values ?? {};
  if (!TEXT_TABLES.has(t) || !INSERTS.has(op.op) || !v.tag) return null;
  return { lang: t === "englishtext" ? "en_US" : String(v.language ?? "en_US"), tag: String(v.tag),
    text: String(v.text ?? ""), file, locale, scope };
}

/** Every text row the mod inserts, from its text files and its modinfo's LocalizedText block. */
export function textEntries(mod) {
  /** @type {TextEntry[]} */
  const out = mod.dbOps.filter((e) => e.db === "localization").map((e) => opEntry(e.op, e.file, e.locale, e.scope))
    .filter((x) => x !== null);
  for (const mi of mod.modinfos) {
    out.push(...modinfoBlockEntries(mi.path));
    for (const file of modinfoTextFiles(mi.path)) out.push(...fileEntries(mod.root, file));
  }
  return out;
}

const localizedBlock = (raw) => raw.replace(/<!--[\s\S]*?-->/g, "").match(/<LocalizedText>([\s\S]*?)<\/LocalizedText>/)?.[1] ?? "";

/** <Text id="LOC_X"><en_US>..</en_US><de_DE>..</de_DE></Text> entries of a modinfo's LocalizedText block. */
function modinfoBlockEntries(modinfoPath) {
  let raw;
  try { raw = readText(modinfoPath); } catch { return []; }
  const file = path.basename(modinfoPath);
  /** @type {TextEntry[]} */
  const out = [];
  for (const t of localizedBlock(raw).matchAll(/<Text\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/Text>/g)) {
    for (const c of t[2].matchAll(/<([A-Za-z_]+)>([\s\S]*?)<\/\1>/g)) {
      out.push({ lang: c[1], tag: t[1], text: c[2].trim(), file, locale: null, scope: "modinfo" });
    }
  }
  return out;
}

/**
 * Text files a modinfo names in its <LocalizedText> block (<File>text/x.xml</File>). These, with the block's
 * own <Text> entries, are the text that reaches Mods.sqlite and the game's mod list. Absolute paths.
 * @param {string} modinfoPath
 */
export function modinfoTextFiles(modinfoPath) {
  let raw;
  try { raw = readText(modinfoPath); } catch { return []; }
  return [...localizedBlock(raw).matchAll(/<File\b[^>]*>([^<]+)<\/File>/g)].map((m) => m[1].trim())
    .filter((rel) => !rel.split(/[\\/]/).includes("..")).map((rel) => path.join(path.dirname(modinfoPath), rel));
}

/**
 * The English text a modinfo carries for the game's mod list: its <LocalizedText> <Text> entries and the
 * files that block names. tag -> text.
 * @param {import("./static/modinfo.mjs").Modinfo} mi
 */
export function modinfoText(mi) {
  const out = new Map(Object.entries(mi.loc));
  const root = path.dirname(mi.path);
  for (const full of modinfoTextFiles(mi.path)) {
    for (const e of fileEntries(root, full)) if (isEnglish(e.lang) && !out.has(e.tag)) out.set(e.tag, e.text);
  }
  return out;
}

/** @returns {TextEntry[]} */
function fileEntries(root, full) {
  let ops;
  try { ops = dbOpsForFile(full).ops; } catch { return []; }
  const file = relPath(root, full);
  return ops.map((o) => opEntry(o, file, null, "modinfo")).filter((x) => x !== null);
}

const TAG = /LOC_[A-Za-z0-9_]+/g;

/** @param {Map<string, Use>} uses */
function scanTags(uses, text, where, js) {
  for (const m of text.matchAll(TAG)) {
    const tag = m[0];
    // a prefix the script completes at run time ("LOC_UNIT_" + type), or part of a longer identifier
    if (tag.endsWith("_") || /[\w$]/.test(text[(m.index ?? 0) - 1] ?? "")) continue;
    const u = uses.get(tag) ?? { files: new Set(), js: false, other: false };
    u.files.add(where);
    if (js) u.js = true;
    else u.other = true;
    uses.set(tag, u);
  }
}

const stripMarkup = (text, rel) => (/\.sql$/i.test(rel)
  ? text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "") : text.replace(/<!--[\s\S]*?-->/g, ""));

/**
 * The LOC tags the mod refers to: in the scripts it loads, its data files, its declared HTML, its modinfo's
 * properties, and {LOC_X} references inside its own English text.
 * @param {import("./static/mod.mjs").Mod} mod @param {TextEntry[]} entries
 */
export function usedTags(mod, entries) {
  /** @type {Map<string, Use>} */
  const uses = new Map();
  const read = (full) => { try { return readText(full); } catch { return ""; } };
  for (const f of mod.loadedJs) scanTags(uses, stripJsComments(read(f)), relPath(mod.root, f), true);
  const dataFiles = new Set(mod.dbOps.filter((e) => e.db !== "localization").map((e) => e.file));
  const html = mod.files.filter((f) => /\.html?$/i.test(f) && mod.declared.has(f.toLowerCase()));
  for (const rel of [...dataFiles, ...html]) {
    scanTags(uses, stripMarkup(read(path.join(mod.root, rel)), rel), rel, false);
  }
  for (const mi of mod.modinfos) {
    for (const v of Object.values(mi.props)) scanTags(uses, v, path.basename(mi.path), false);
  }
  for (const e of entries.filter((x) => isEnglish(x.lang))) {
    for (const m of e.text.matchAll(/\{(LOC_[A-Za-z0-9_]+)/g)) scanTags(uses, m[1], e.file, false);
  }
  return uses;
}

/** Is a tag only a prefix of tags that exist, as a script that appends a suffix would use it? */
function isPrefix(tag, defined) {
  const p = `${tag}_`;
  for (const d of defined) if (d.startsWith(p)) return true;
  return false;
}

function undefinedTag(m, otherLangs) {
  return `${code(m.tag)} (${m.files[0]})${otherLangs.has(m.tag) ? " [only in a translation]" : ""}`;
}

/**
 * Tags the mod uses that nothing defines in English: not the mod, not the base game. A tag only a script
 * names may be one the engine hands back (a failure reason it compares against), so those are warnings.
 * @param {Map<string, Use>} uses @param {Set<string>} english @param {Set<string>} base
 * @param {{ strict: boolean, baseRead: boolean, otherLangs: Set<string> }} ctx
 * @returns {L10nFinding[]}
 */
function undefinedFindings(uses, english, base, ctx) {
  const { shown, scripted, cased } = classifyUndefined(uses, english, base);
  const why = !ctx.baseRead ? " The base game's text was not read (no install found), so some may be base-game tags."
    : ctx.strict ? "" : " The mod depends on other mods, which may define some of them.";
  const list = (xs) => listMore(xs, 4, (m) => undefinedTag(m, ctx.otherLangs));
  /** @type {(L10nFinding | null)[]} */
  const out = [
    shown.length ? { severity: ctx.strict && ctx.baseRead ? "error" : "warn", rule: "undefined-tag",
      text: `names ${shown.length} LOC tag(s) in its data, HTML or modinfo that no English text defines, in the mod or the base game; any of them put on screen shows as the tag itself (watched on 1.5.0): ${list(shown)}.${why}`,
      evidence: { tags: shown } } : null,
    scripted.length ? { severity: "warn", rule: "undefined-script-tag",
      text: `its scripts name ${scripted.length} LOC tag(s) that no English text defines: ${list(scripted)}. Harmless if the script only compares them with values the engine returns; any it puts on screen shows as the raw tag.${why}`,
      evidence: { tags: scripted } } : null,
    cased.length ? { severity: "warn", rule: "tag-case",
      text: `uses ${cased.length} tag(s) defined only in a different case: ${listMore(cased, 3, (m) => `${code(m.tag)} vs ${code(m.defined)}`)}. Not verified whether the game matches tags case-insensitively; use one spelling.`,
      evidence: { tags: cased } } : null,
  ];
  return out.filter((f) => f !== null);
}

/** @param {Map<string, Use>} uses @param {Set<string>} english @param {Set<string>} base */
function classifyUndefined(uses, english, base) {
  const lower = new Map([...english, ...base].map((t) => [t.toLowerCase(), t]));
  /** @type {{ shown: any[], scripted: any[], cased: any[] }} */
  const out = { shown: [], scripted: [], cased: [] };
  for (const [tag, u] of uses) {
    if (english.has(tag) || base.has(tag)) continue;
    if (u.js && (isPrefix(tag, english) || isPrefix(tag, base))) continue;
    const other = lower.get(tag.toLowerCase());
    const hit = { tag, files: [...u.files].slice(0, 3), ...(other ? { defined: other } : {}) };
    (other ? out.cased : u.other ? out.shown : out.scripted).push(hit);
  }
  return out;
}

/** @param {TextEntry[]} entries */
function byLanguage(entries) {
  /** @type {Map<string, Map<string, TextEntry>>} */
  const out = new Map();
  for (const e of entries) {
    const lang = canonLang(e.lang) ?? e.lang;
    if (!out.has(lang)) out.set(lang, new Map());
    const m = /** @type {Map<string, TextEntry>} */ (out.get(lang));
    if (!m.has(e.tag)) m.set(e.tag, e);
  }
  return out;
}

/** Each translation against English: tags it lacks and tags English does not have. */
function languageRows(langs, english, base) {
  return [...langs].filter(([lang]) => !isEnglish(lang)).sort(([a], [b]) => a.localeCompare(b)).map(([lang, rows]) => ({
    lang, tags: rows.size,
    missing: [...english.keys()].filter((t) => !rows.has(t)),
    extra: [...rows.keys()].filter((t) => !english.has(t) && !base.has(t)),
  }));
}

const langCounts = (rows, key) => rows.filter((r) => r[key].length).map((r) => `${r.lang} ${r[key].length}`).join(", ");

/** One finding for the tags translations lack, one for the tags only translations have. @returns {L10nFinding[]} */
function languageFindings(rows) {
  const missing = [...new Set(rows.flatMap((r) => r.missing))];
  const extra = [...new Set(rows.flatMap((r) => r.extra))];
  /** @type {L10nFinding[]} */
  const out = [];
  if (missing.length) {
    out.push({ severity: "warn", rule: "missing-translation",
      text: `translations lack ${missing.length} English tag(s) (${langCounts(rows, "missing")}); players in those languages see them untranslated (English or the raw tag; not verified which): ${listMore(missing, 4, code)}.`,
      evidence: { byLang: Object.fromEntries(rows.filter((r) => r.missing.length).map((r) => [r.lang, r.missing])) } });
  }
  if (extra.length) {
    out.push({ severity: "info", rule: "extra-translation",
      text: `${extra.length} tag(s) are translated but have no English text (${langCounts(rows, "extra")}), so English players see nothing for them: ${listMore(extra, 4, code)}.`,
      evidence: { byLang: Object.fromEntries(rows.filter((r) => r.extra.length).map((r) => [r.lang, r.extra])) } });
  }
  return out;
}

/** Text rows listed under UpdateDatabase: the gameplay and frontend databases have no LocalizedText table. */
function wrongActionFindings(mod) {
  const files = [...new Set(mod.dbOps.filter((e) => e.db !== "localization" && TEXT_TABLES.has(e.op.table.toLowerCase()))
    .map((e) => e.file))];
  return files.length ? [{ severity: "error", rule: "text-in-database-action",
    text: `${files.length} file(s) insert text rows but are listed under UpdateDatabase, whose databases have no LocalizedText table; the statement fails and the file is rolled back. List them under UpdateText: ${listMore(files, 3, code)}.`,
    evidence: { files } }] : [];
}

function declaredLocales(mod) {
  return mod.modinfos.flatMap((mi) => mi.groups.flatMap((g) => g.actions.filter((a) => a.type === "UpdateText")
    .flatMap((a) => a.items.map((item, n) => ({ item, locale: a.locales[n] })).filter((x) => x.locale))));
}

/** Plain inserts of a tag the base game or the mod already defines (the static checker's rule). */
function duplicateFindings(mod, vanilla) {
  const v = vanilla ?? /** @type {any} */ ({ textTags: () => new Map() });
  return textFindings(mod, v).map((f) => ({ severity: /** @type {const} */ ("error"), rule: f.rule, text: f.text,
    evidence: f.evidence }));
}

function strictDeps(mod, vanilla) {
  if (!vanilla) return false;
  const base = new Set(vanilla.modinfos().map((mi) => mi.id).filter(Boolean));
  return mod.modinfos.every((mi) => mi.deps.every((d) => base.has(d.id)));
}

/**
 * The localization report for a loaded mod. `vanilla` is the installed game, or null to skip base-game tags.
 * @param {import("./static/mod.mjs").Mod} mod @param {any} vanilla
 */
export function l10nReport(mod, vanilla) {
  const entries = textEntries(mod);
  const langs = byLanguage(entries);
  const english = langs.get("en_US") ?? new Map();
  const base = new Set(vanilla ? vanilla.textTags().keys() : []);
  const uses = usedTags(mod, entries);
  const otherLangs = new Set(entries.filter((e) => !isEnglish(e.lang)).map((e) => e.tag));
  const rows = languageRows(langs, english, base);
  const styleFiles = [...mod.files.filter((f) => /\.css$/i.test(f)).map((f) => path.join(mod.root, f)), ...mod.loadedJs];
  const shipped = [...new Set([...langs.keys(), ...declaredLocales(mod).map((d) => d.locale)])];
  const ctx = { strict: strictDeps(mod, vanilla), baseRead: !!vanilla, otherLangs };
  const findings = [
    ...undefinedFindings(uses, new Set(english.keys()), base, ctx),
    ...duplicateFindings(mod, vanilla), ...wrongActionFindings(mod),
    ...localeFindings(entries, declaredLocales(mod)), ...languageFindings(rows),
    ...placeholderFindings(english, new Map([...langs].filter(([l]) => !isEnglish(l)))),
    ...fontFindings(styleFiles, (f) => relPath(mod.root, f), shipped),
  ].map((f) => ({ ...f, techniques: techniqueIds(`l10n:${f.rule}`) }))
    .sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  return {
    id: mod.id, folder: mod.root, gameVersion: vanilla?.version ?? null, used: uses.size, english: english.size,
    languages: rows.map((r) => ({ lang: r.lang, tags: r.tags, missing: r.missing.length, extra: r.extra.length })),
    findings,
  };
}

/**
 * Lint one mod folder's localization against the installed game's text.
 * @param {{ paths: any }} bench @param {{ dir: string, vanilla?: any }} opts vanilla: null skips the base game
 */
export async function l10nCheck(bench, { dir, vanilla }) {
  if (!dir) throw new BenchError("which mod folder?");
  const folder = path.resolve(dir);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new BenchError(`no such folder: ${dir}`);
  const install = bench.paths.install;
  const v = vanilla !== undefined ? vanilla : install && fs.existsSync(install) ? Vanilla.load(install) : null;
  const mod = loadMod(folder, v ? { vanilla: v } : {});
  if (!mod.modinfos.length) throw new BenchError(`${dir} has no .modinfo`);
  return l10nReport(mod, v);
}

/**
 * Visible text in the running UI that draws as boxes: a literal replacement character, or CJK text whose
 * font list names no CJK face. Read-only.
 * @param {import("./bench.mjs").Bench} bench @param {{ scope?: string | null }} [opts]
 */
export async function l10nLive(bench, { scope = null } = {}) {
  await bench.requireConnection();
  const r = await bench.cdp.call(scanGlyphs, { scope, max: 20000 }, { timeoutMs: 60000 });
  if (r?.error) throw new BenchError(r.error);
  for (const i of r?.issues ?? []) i.techniques = techniqueIds(`lint:${i.rule}`);
  return r;
}
