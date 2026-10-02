// The per-file rules of the localization lint: language codes and locale attributes, placeholders that a
// translation drops or renames, and font lists that cannot draw Chinese, Japanese or Korean text.
import { code, listMore, push, readText } from "./static/util.mjs";

/**
 * @typedef {{ lang: string, tag: string, text: string, file: string, locale: string | null, scope: string }} TextEntry
 * @typedef {{ severity: "error" | "warn" | "info", rule: string, text: string, evidence?: any }} L10nFinding
 */

// The display languages of Civ VII 1.5.0, as the Language column spells them. A row filed under any other
// code (zh_CN for zh_Hans_CN) never loads, so its tag shows untranslated in that language.
export const GAME_LANGUAGES = ["en_US", "de_DE", "es_ES", "fr_FR", "it_IT", "ja_JP", "ko_KR", "pl_PL", "pt_BR",
  "ru_RU", "zh_Hans_CN", "zh_Hant_HK"];
const CANON = new Map(GAME_LANGUAGES.map((l) => [l.toLowerCase(), l]));

/** The game's spelling of a language code, or null when the game has no such language. */
export const canonLang = (lang) => CANON.get(String(lang).toLowerCase()) ?? null;
export const isEnglish = (lang) => String(lang).toLowerCase() === "en_us";
export const isCjk = (lang) => /^(ja|ko|zh)/i.test(String(lang));

// Folder and file-name spellings that name a language, longest first so zh_hans_cn wins over zh.
const HINTS = [
  ...GAME_LANGUAGES.map((l) => [l.toLowerCase(), l]),
  ["zh_hans", "zh_Hans_CN"], ["zh_hant", "zh_Hant_HK"], ["zh_cn", "zh_Hans_CN"], ["zh_tw", "zh_Hant_HK"],
  ["zh_hk", "zh_Hant_HK"],
].sort((a, b) => b[0].length - a[0].length);
const SHORT = new Map(["de", "es", "fr", "it", "ja", "ko", "pl", "pt", "ru"].map((s) => [s, canonLang(GAME_LANGUAGES
  .find((l) => l.startsWith(`${s}_`)))]));

/** The language a text file's path names (text/ja_jp/x.xml, Text_ko_KR.xml, l10n/de/x.xml), or null. */
export function pathLanguage(file) {
  const p = `/${file.toLowerCase().replaceAll("-", "_")}`;
  for (const [hint, lang] of HINTS) {
    if (new RegExp(`[/_.]${hint}(?=[/_.]|$)`).test(p)) return lang;
  }
  const dirs = p.split("/").slice(0, -1);
  return dirs.map((d) => SHORT.get(d)).find(Boolean) ?? null;
}

function byFile(entries) {
  /** @type {Map<string, TextEntry[]>} */
  const out = new Map();
  for (const e of entries) push(out, e.file, e);
  return out;
}

/** What is wrong with one row's language against the game and the item's locale; null when nothing. */
function rowProblem(e) {
  const canon = canonLang(e.lang);
  if (!canon) return { rule: "language-unknown", severity: "warn", detail: `${e.lang}, which is not a game language` };
  if (canon !== e.lang) return { rule: "language-case", severity: "warn", detail: `${e.lang} (the game spells it ${canon})` };
  if (e.locale && canonLang(e.locale) && canonLang(e.locale) !== canon) {
    return { rule: "locale-mismatch", severity: isEnglish(canon) ? "warn" : "error",
      detail: `rows in ${canon} in an item that loads only when the display language is ${e.locale}` };
  }
  return null;
}

const LOCALE_TEXT = {
  "language-unknown": "file(s) hold rows under a language code the game does not have; those rows never load, so players get no translation from them (zh_CN for zh_Hans_CN is the usual slip)",
  "language-case": "file(s) spell a language code in a different case from the game; not verified whether the loader matches it",
  "locale-mismatch": "file(s) are listed with a locale= that differs from the language of their rows. An item with locale= loads only in that display language (watched on 1.5.0), so a row filed under another language never shows",
  "locale-unknown": "UpdateText item(s) carry a locale= that is not a game language, so the file never loads",
  "path-language-mismatch": "file(s) sit in a folder or carry a name for one language and hold rows for another; usually a translation copied without changing its Language attribute",
};

/**
 * Language codes and locale attributes, file by file.
 * @param {TextEntry[]} entries
 * @param {{ item: string, locale: string }[]} declared UpdateText items that carry locale=
 * @returns {L10nFinding[]}
 */
export function localeFindings(entries, declared) {
  /** @type {Map<string, { severity: string, list: string[] }>} */
  const hits = new Map();
  const note = (rule, severity, line) => {
    const h = hits.get(rule) ?? { severity: "info", list: [] };
    if (severity === "error" || (severity === "warn" && h.severity === "info")) h.severity = severity;
    if (!h.list.includes(line)) h.list.push(line);
    hits.set(rule, h);
  };
  for (const d of declared) if (!canonLang(d.locale)) note("locale-unknown", "warn", `${d.item} (locale="${d.locale}")`);
  for (const [file, rows] of byFile(entries)) {
    const p = rows.map(rowProblem).find(Boolean);
    if (p) note(p.rule, p.severity, `${file}: ${p.detail}`);
    const hinted = pathLanguage(file);
    const langs = [...new Set(rows.map((r) => canonLang(r.lang) ?? r.lang))];
    if (hinted && file.endsWith(".modinfo") === false && langs.length === 1 && langs[0] !== hinted) {
      note("path-language-mismatch", isEnglish(langs[0]) ? "warn" : "error", `${file}: named for ${hinted}, rows in ${langs[0]}`);
    }
  }
  return [...hits].map(([rule, h]) => ({ severity: /** @type {any} */ (h.severity), rule,
    text: `${h.list.length} ${LOCALE_TEXT[rule]}: ${listMore(h.list, 3, (x) => x)}.`, evidence: { files: h.list } }));
}

const PLACEHOLDER = /\{([^{}]+)\}/g;

/** The placeholder names in a text: {1_Name}, {2_Amount : number #}; {LOC_OTHER_TAG} references are not. */
export function placeholders(text) {
  return new Set([...String(text).matchAll(PLACEHOLDER)].map((m) => m[1].split(/[:|]/)[0].trim())
    .filter((n) => /^[\w.]+$/.test(n) && !n.startsWith("LOC_")));
}

// The engine fills a placeholder by its number; the name after it ({1_Name}) is a label, so a translation
// may rename it. What matters is which values it uses.
const slots = (text) => new Set([...placeholders(text)].map((n) => n.match(/^\d+/)?.[0] ?? n));
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/** Tags whose translation uses other placeholder slots than English. */
function slotMismatches(english, rows) {
  const bad = [];
  for (const [tag, e] of rows) {
    const en = english.get(tag);
    if (!en || sameSet(slots(en.text), slots(e.text))) continue;
    bad.push({ tag, en: [...placeholders(en.text)], translated: [...placeholders(e.text)] });
  }
  return bad;
}

const braces = (list) => (list.length ? `{${list.join("}, {")}}` : "none");

/**
 * Translations whose placeholders use other values than the English text of the same tag: one finding.
 * @param {Map<string, TextEntry>} english tag -> entry
 * @param {Map<string, Map<string, TextEntry>>} byLang
 * @returns {L10nFinding[]}
 */
export function placeholderFindings(english, byLang) {
  /** @type {Record<string, { tag: string, en: string[], translated: string[] }[]>} */
  const byLangBad = {};
  for (const [lang, rows] of byLang) {
    const bad = slotMismatches(english, rows);
    if (bad.length) byLangBad[lang] = bad;
  }
  const langs = Object.keys(byLangBad);
  if (!langs.length) return [];
  const all = langs.flatMap((l) => byLangBad[l].map((x) => ({ ...x, lang: l })));
  return [{ severity: "warn", rule: "placeholder-mismatch",
    text: `${all.length} translation(s) use other placeholder values than English (${langs.map((l) => `${l} ${byLangBad[l].length}`).join(", ")}): ${listMore(all, 3, (x) => `${code(x.tag)} ${x.lang} (${braces(x.en)} vs ${braces(x.translated)})`)}. A value the script does not pass shows raw; one the translation leaves out is lost.`,
    evidence: { byLang: byLangBad } }];
}

// A face that holds Han, kana or Hangul: the game's -SC/-TC/-JP/-KR faces, or a common system CJK family.
const CJK_FACE = /(?:[-_ ](?:SC|TC|JP|KR|CN|HK|TW)\b)|CJK|Hans|Hant|Gothic|Mincho|Hiragino|PingFang|YaHei|JhengHei|Malgun|Noto Sans (?:SC|TC|JP|KR)/i;
const SKIP_FAMILY = /^(inherit|initial|unset|revert|revert-layer)$/i;

const families = (list) => list.split(",").map((f) => f.replace(/!important/i, "").trim().replace(/^["']|["']$/g, ""))
  .filter((f) => f && !SKIP_FAMILY.test(f));

/**
 * Font lists a mod sets: CSS font-family, inline style fontFamily, and canvas ctx.font shorthands.
 * @param {string} file @param {string} text
 * @returns {{ file: string, kind: "dom" | "canvas", raw: string, families: string[] }[]}
 */
export function fontDecls(file, text) {
  const out = [];
  const add = (kind, raw) => {
    // built at run time ("${font}", "' + FONT + '"): nothing to read
    if (/[$+`]/.test(raw) || (raw.match(/["']/g) ?? []).length % 2) return;
    const fams = families(kind === "canvas" ? raw.replace(/^.*?\d(?:px|pt|em|rem)\b(?:\s*\/\s*\S+)?\s+/i, "") : raw);
    if (fams.length || raw.includes("var(")) out.push({ file, kind, raw: raw.trim(), families: fams });
  };
  for (const m of text.matchAll(/font-family\s*:\s*([^;{}"'`\n]+(?:(["'])[^"'\n]*\2[^;{}"'`\n]*)*)/gi)) add("dom", m[1]);
  for (const m of text.matchAll(/fontFamily\s*[:=]\s*(["'`])([^"'`]*)\1/g)) add("dom", m[2]);
  for (const m of text.matchAll(/\.font\s*=\s*(["'`])([^"'`]*)\1/g)) if (/\d(px|pt|em|rem)\b/i.test(m[2])) add("canvas", m[2]);
  return out;
}

const declLine = (d) => `${d.file}: ${d.kind === "canvas" ? "canvas font" : "font-family"} ${d.raw}`;

/** @param {ReturnType<typeof fontDecls>} all @param {string[]} cjk @returns {L10nFinding[]} */
function cjkFinding(all, cjk) {
  // var() lists are reported on their own: GameFace ignores them, whatever they name
  const decls = all.filter((d) => !d.raw.includes("var("));
  const dom = decls.filter((d) => d.kind === "dom" && d.families.length && !d.families.some((f) => CJK_FACE.test(f)));
  const canvas = decls.filter((d) => d.kind === "canvas" && d.families.length && !CJK_FACE.test(d.families[0]));
  if (!dom.length && !canvas.length) return [];
  const handled = decls.some((d) => d.families.length && CJK_FACE.test(d.families[0]));
  const bad = [...canvas, ...dom];
  return [{ severity: handled ? "info" : "warn", rule: "cjk-font",
    text: `ships ${cjk.join(", ")} text, and ${bad.length} font list(s) the mod sets cannot draw it: ${listMore(bad, 3, (d) => code(declLine(d)))}. BodyFont, TitleFont and sans-serif hold no Han, kana or Hangul glyphs (watched on 1.5.0, 2026-10-01). Page text falls back glyph by glyph only to faces named in its list, so list the CJK faces after the first, as the game's own CSS does ("BodyFont", "BodyFont-JP", "BodyFont-KR", "BodyFont-SC", "BodyFont-TC"), or use the game's font-body / font-title classes. A canvas draws with only the FIRST family, so for a canvas put the display language's face first.${handled ? " The mod puts a CJK face first somewhere, so it may already switch per language; check each list above is covered." : ""}`,
    evidence: { declarations: bad } }];
}

/**
 * Font findings for the CSS and scripts a mod ships: CJK readiness when it ships CJK text, and var() in
 * font-family, which GameFace ignores (watched on 1.5.0, 2026-10-01).
 * @param {string[]} files absolute paths of the CSS and loaded scripts
 * @param {(f: string) => string} label
 * @param {string[]} langs every language the mod ships text in
 * @returns {L10nFinding[]}
 */
export function fontFindings(files, label, langs) {
  const decls = files.flatMap((f) => {
    try { return fontDecls(label(f), readText(f).replace(/\/\*[\s\S]*?\*\//g, "")); } catch { return []; }
  });
  /** @type {L10nFinding[]} */
  const out = [];
  const vars = decls.filter((d) => d.raw.includes("var("));
  if (vars.length) {
    out.push({ severity: "warn", rule: "font-family-var",
      text: `${vars.length} font-family value(s) use var(), which GameFace ignores inside font-family, so the element falls back to the inherited font: ${listMore(vars, 3, (d) => code(declLine(d)))}.`,
      evidence: { declarations: vars } });
  }
  const cjk = langs.filter(isCjk);
  return cjk.length ? [...out, ...cjkFinding(decls, cjk)] : out;
}
