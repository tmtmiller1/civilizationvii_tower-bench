// The offline half of the API atlas: every `Root.member` the installed game's own scripts use, read from the
// text. A root is a capitalised identifier (or `engine`) that no game script declares and that is not a
// JavaScript or DOM built-in, so what is left is what the engine puts on the page.
import fs from "node:fs";
import path from "node:path";
import { moduleRoots } from "./static/game.mjs";
import { stripJsComments } from "./static/jsscan.mjs";
import { readText, relPath, walkFiles } from "./static/util.mjs";

// Always treated as roots, even if a script happens to declare the name.
export const KNOWN_ROOTS = [
  "engine", "UI", "Game", "Players", "GameplayMap", "Database", "Configuration", "Modding", "Controls", "Locale",
  "Network", "Automation", "WorldBuilder", "MapCities", "MapUnits", "MapConstructibles", "Visibility", "GameInfo",
  "GameContext",
];

const DOM_NAMES = new Set([
  "Node", "Element", "Document", "Window", "Image", "Audio", "Option", "Text", "Comment", "Range", "Selection",
  "MutationObserver", "ResizeObserver", "IntersectionObserver", "NodeFilter", "XMLHttpRequest", "FileReader",
  "ShadowRoot", "DocumentFragment", "CanvasRenderingContext2D", "Path2D", "ImageData", "FontFace", "Worker",
  "DOMParser", "XMLSerializer", "Storage", "Location", "History", "Navigator", "Screen", "Animation", "KeyframeEffect",
]);

const isBuiltin = (name) => name in globalThis || DOM_NAMES.has(name) || /^(HTML|SVG|DOM|CSS|WebGL)/.test(name)
  || /(Event|Error|Array|Observer)$/.test(name);

const DECL = [
  /\b(?:class|function\*?|enum|namespace)\s+([A-Z][\w$]*)/g,
  /\b(?:const|let|var)\s+([A-Z][\w$]*)/g,
  /\bimport\s+([A-Z][\w$]*)\s*(?:,|from)/g,
  /\bimport\s*\*\s*as\s+([A-Z][\w$]*)/g,
  /(?<![\w$.])([A-Z][\w$]*)\s*=>/g,
];

// Names in a declarator or parameter list: `let a, B = 1, C` or `(A, b = 2, ...C)`.
const LIST_PARTS = /(?:^|,)\s*(?:\.\.\.)?([A-Z][\w$]*)\s*(?==(?!=)|,|$)/g;

function listNames(out, list) {
  for (const m of list.matchAll(LIST_PARTS)) out.add(m[1]);
}

// The local name of each `{ A, b as C }` import/export part or `{ x: D, E }` destructuring part.
function braceNames(out, list, sep) {
  for (const part of list.split(",")) {
    const local = part.split(sep).pop()?.trim();
    if (local && /^[A-Z][\w$]*$/.test(local)) out.add(local);
  }
}

/** Capitalised names a script declares itself: classes, functions, variables, parameters and imports. */
export function declaredNames(text) {
  const out = new Set();
  for (const rx of DECL) for (const m of text.matchAll(rx)) out.add(m[1]);
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([^;{}()\n]{1,300})/g)) listNames(out, m[1]);
  for (const m of text.matchAll(/\(([^()]{0,300})\)\s*(?:=>|\{)/g)) listNames(out, m[1]);
  for (const m of text.matchAll(/\b(?:import|export)\s*\{([^}]*)\}/g)) braceNames(out, m[1], /\s+as\s+/);
  for (const m of text.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) braceNames(out, m[1], ":");
  return out;
}

const blankRange = (text, a, b) => text.slice(a, b).replace(/[^\n]/g, " ");

// Index of the closing delimiter of the string or regex literal opened at i (or the end of its line).
function literalEnd(text, i, close) {
  let inClass = false;
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") j++;
    else if (c === "\n") return j - 1;
    else if (close === "/" && (c === "[" || c === "]")) inClass = c === "[";
    else if (c === close && !inClass) return j;
  }
  return text.length - 1;
}

const REGEX_BEFORE = /(?:[(,=:[!&|?{};+\-*%<>~^]|\breturn)$/;

const regexStarts = (text, i) => {
  const prev = text.slice(Math.max(0, i - 40), i).trimEnd();
  return prev === "" || REGEX_BEFORE.test(prev);
};

const CODE_MARK = /['"`/{}]/g;
const TPL_MARK = /[\\`$]/g;

/**
 * @typedef {{ text: string, out: string[], at: number, tpl: number[], inTpl: boolean }} LexState
 * at: how far `out` covers; tpl: brace depth of each open `${`
 */

// From inside template text to its next mark: the text before it is blanked.
function templateStep(st, i) {
  const { text } = st;
  st.out.push(blankRange(text, st.at, i));
  const c = text[i];
  if (c === "\\") { st.out.push(blankRange(text, i, i + 2)); st.at = i + 2; return i + 1; }
  st.at = i;
  if (c === "`") st.inTpl = false;
  else if (text[i + 1] === "{") { st.tpl.push(0); st.inTpl = false; return i + 1; }
  else { st.out.push(" "); st.at = i + 1; }
  return i;
}

// Brace tracking inside `${...}`: a `}` at depth 0 returns to the template text.
function braceStep(st, c) {
  const { tpl } = st;
  if (!tpl.length) return;
  if (c === "{") tpl[tpl.length - 1]++;
  else if (tpl[tpl.length - 1] > 0) tpl[tpl.length - 1]--;
  else { tpl.pop(); st.inTpl = true; }
}

// At a code mark: a literal to blank, a template start, or brace tracking for `${...}`.
function codeStep(st, i) {
  const { text } = st;
  const c = text[i];
  if (c === "'" || c === "\"" || (c === "/" && regexStarts(text, i))) {
    const end = literalEnd(text, i, c);
    st.out.push(text.slice(st.at, i + 1), blankRange(text, i + 1, end));
    st.at = end;
    return end;
  }
  if (c === "`") st.inTpl = true;
  else if (c === "{" || c === "}") braceStep(st, c);
  if (st.inTpl) { st.out.push(text.slice(st.at, i + 1)); st.at = i + 1; }
  return i;
}

/**
 * String, template and regex text becomes spaces (same length, newlines kept), so names, commas and dots
 * inside text are not read as code. Template `${...}` expressions stay code.
 * @param {string} text comment-free source
 */
export function blankLiterals(text) {
  /** @type {LexState} */
  const st = { text, out: [], at: 0, tpl: [], inTpl: false };
  for (let i = 0; i < text.length; i++) {
    const rx = st.inTpl ? TPL_MARK : CODE_MARK;
    rx.lastIndex = i;
    const m = rx.exec(text);
    if (!m) break;
    i = st.inTpl ? templateStep(st, m.index) : codeStep(st, m.index);
  }
  st.out.push(st.inTpl ? blankRange(text, st.at, text.length) : text.slice(st.at));
  return st.out.join("");
}

const CLOSE = { "(": ")", "[": "]", "{": "}" };

/** Argument count of the call whose `(` is at `open`, or null when it does not close within reach. */
export function argCount(code, open) {
  const stack = [];
  let commas = 0;
  let empty = true;
  const end = Math.min(code.length, open + 6000);
  for (let i = open + 1; i < end; i++) {
    const c = code[i];
    if (c in CLOSE) stack.push(CLOSE[c]);
    else if (stack.length) { if (c === stack.at(-1)) stack.pop(); }
    else if (c === ")") return empty ? 0 : commas + 1;
    else if (c === ",") commas++;
    empty &&= /\s/.test(c);
  }
  return null;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

function lineAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

const CHAIN = /(?<![\w$.])([A-Z][\w$]*|engine)((?:\.[A-Za-z_$][\w$]*)+)(\s*\()?/g;
const EVENT_CALL = /^engine\.(on|off|once|trigger|call)$/;
export const MAX_SEGMENTS = 3;
const MAX_EXAMPLES = 3;

/**
 * @typedef {{ count: number, called: number, args: Record<string, number>, files: number, examples: string[] }} Use
 * @typedef {{ on: number, trigger: number, other: number, examples: string[] }} EventUse
 * @typedef {{ uses: { path: string, root: string, line: number, args: number | null, call: boolean }[],
 *   events: { name: string, verb: string, line: number }[], declared: Set<string> }} FileScan
 */

/**
 * Every `Root.a(.b)` chain in one file's source (comments removed), with call argument counts and the
 * event names of engine.on / engine.trigger calls.
 * @param {string} text
 * @returns {FileScan}
 */
export function scanSource(text) {
  const stripped = stripJsComments(text);
  const code = blankLiterals(stripped);
  const starts = lineStarts(code);
  /** @type {FileScan} */
  const res = { uses: [], events: [], declared: declaredNames(code) };
  for (const m of code.matchAll(CHAIN)) {
    const segs = m[2].slice(1).split(".");
    const parts = [m[1], ...segs].slice(0, MAX_SEGMENTS);
    const line = lineAt(starts, /** @type {number} */ (m.index));
    const call = !!m[3] && segs.length < MAX_SEGMENTS;
    const open = /** @type {number} */ (m.index) + m[0].length - 1;
    for (let n = 2; n <= parts.length; n++) {
      const last = n === parts.length;
      res.uses.push({ path: parts.slice(0, n).join("."), root: m[1], line, call: last && call,
        args: last && call ? argCount(code, open) : null });
    }
    const verb = EVENT_CALL.exec(parts.join("."))?.[1];
    if (verb && call) res.events.push({ name: eventName(stripped, open), verb, line });
  }
  return res;
}

function eventName(text, open) {
  const m = /^\(\s*(?:'([^'\n]*)'|"([^"\n]*)"|`([^`$\n]*)`)/.exec(text.slice(open, open + 200));
  return m ? (m[1] ?? m[2] ?? m[3]) : "(computed)";
}

/** @returns {Use} */
const emptyUse = () => ({ count: 0, called: 0, args: {}, files: 0, examples: [] });

function addUse(members, u, where, seenInFile) {
  const m = (members[u.path] ??= emptyUse());
  m.count++;
  if (u.call) m.called++;
  if (u.args !== null) m.args[u.args] = (m.args[u.args] ?? 0) + 1;
  if (!seenInFile.has(u.path)) {
    seenInFile.add(u.path);
    m.files++;
    if (m.examples.length < MAX_EXAMPLES) m.examples.push(where);
  }
}

function addEvent(events, e, where) {
  const ev = (events[e.name] ??= { on: 0, trigger: 0, other: 0, examples: [] });
  if (e.verb === "on" || e.verb === "once") ev.on++;
  else if (e.verb === "trigger") ev.trigger++;
  else ev.other++;
  if (ev.examples.length < MAX_EXAMPLES && !ev.examples.includes(where)) ev.examples.push(where);
}

/**
 * Merges per-file scans into the usage index. Roots are chains whose first name no file declares and that
 * is not a built-in, plus KNOWN_ROOTS.
 * @param {{ label: string, scan: FileScan }[]} scans
 */
export function indexUsage(scans) {
  const declared = new Set(scans.flatMap((s) => [...s.scan.declared]));
  const known = new Set(KNOWN_ROOTS);
  const isRoot = (r) => known.has(r) || (r !== "engine" && !declared.has(r) && !isBuiltin(r));
  /** @type {Record<string, Use>} */
  const members = {};
  /** @type {Record<string, EventUse>} */
  const events = {};
  for (const { label, scan } of scans) {
    const seen = new Set();
    for (const u of scan.uses) if (isRoot(u.root)) addUse(members, u, `${label}:${u.line}`, seen);
    for (const e of scan.events) addEvent(events, e, `${label}:${e.line}`);
  }
  /** @type {Record<string, { count: number, members: number }>} */
  const roots = {};
  for (const [p, u] of Object.entries(members)) {
    const r = (roots[p.split(".")[0]] ??= { count: 0, members: 0 });
    r.members++;
    if (p.split(".").length === 2) r.count += u.count;
  }
  return { roots, members, events };
}

/** The game's script files: module-relative label and absolute path. @param {string} install */
export function gameScripts(install) {
  const out = [];
  for (const [mod, root] of moduleRoots(install)) {
    for (const full of walkFiles(root, { all: true })) if (full.endsWith(".js")) out.push({ label: `${mod}/${relPath(root, full)}`, full });
  }
  return out;
}

/**
 * The usage index for an install, read-only.
 * @param {string | null | undefined} install
 */
export function usageIndex(install) {
  if (!install || !fs.existsSync(install)) throw new Error("the game install was not found; set TOWER_BENCH_INSTALL");
  const t0 = Date.now();
  const files = gameScripts(path.resolve(install));
  let bytes = 0;
  const scans = files.map((f) => {
    const text = readText(f.full);
    bytes += text.length;
    return { label: f.label, scan: scanSource(text) };
  });
  const idx = indexUsage(scans);
  return { files: files.length, bytes, ms: Date.now() - t0, ...idx };
}

/**
 * Root list and per-object probe names for the live crawl: for each object path the game reads, the member
 * names its scripts use on it (a native object can hide them from getOwnPropertyNames).
 * @param {{ members: Record<string, Use> }} usage
 */
export function crawlPlan(usage) {
  const roots = new Set(KNOWN_ROOTS);
  /** @type {Record<string, string[]>} */
  const probe = {};
  for (const p of Object.keys(usage.members)) {
    const parts = p.split(".");
    roots.add(parts[0]);
    const parent = parts.slice(0, -1).join(".");
    (probe[parent] ??= []).push(/** @type {string} */ (parts.at(-1)));
  }
  return { roots: [...roots].sort(), probe };
}
