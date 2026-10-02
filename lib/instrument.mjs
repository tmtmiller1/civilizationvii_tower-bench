// Finds the function bodies and branch blocks in a JavaScript file from its tokens, and writes a copy that
// counts each one: `globalThis.__tbCov?.(file, site);` right after the opening brace. Nothing is inserted with
// a newline, so line numbers in the game's logs still point at the source. A file the finder cannot read, or
// whose copy no longer parses, is left plain.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fnv1a } from "./deploy.mjs";
import { lineIndex, lineOf, tokenize } from "./instrument-lex.mjs";

/**
 * @typedef {import("./instrument-lex.mjs").Token} Token
 * @typedef {{ k: "f" | "b", kind: string, name: string, head: number, body: number, at: number, line: number,
 *   col: number, end?: number, outer?: number, semi?: boolean }} Site
 * @typedef {{ ch: string, open: number, kind: string, q: number, name?: string | null, start?: number,
 *   site?: Site }} Frame
 */

const CONTROL = { if: "if", for: "loop", while: "loop", with: "block", switch: "switch", catch: "catch" };
const AFTER_WORD = { else: "else", try: "block", finally: "block", do: "loop", catch: "catch" };
const OBJECT_AFTER = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "yield", "await", "extends",
  "default",
]);
const ASSIGN = new Set(["=", "||=", "??=", "&&="]);
const MODIFIERS = new Set(["get", "set", "static", "async", "*"]);
export const BLOCK_KINDS = new Set(["if", "else", "case", "catch"]);
const FUNCTION_KINDS = new Set(["function", "method", "arrow"]);
export const PROLOGUE_END = "/*tb-cov*/";

const isPunct = (t, v) => t?.t === "punct" && t.v === v;
const isName = (t, v) => t?.t === "name" && (v === undefined || t.v === v);
const unquote = (t) => (t.t === "str" ? t.v.slice(1, -1) : t.v);

class Finder {
  /** @param {string} src @param {Token[]} tokens */
  constructor(src, tokens) {
    this.src = src;
    this.tok = tokens;
    // The root frame holds top-level ternaries; it is never popped.
    /** @type {Frame[]} */
    this.frames = [{ ch: "root", open: -1, kind: "root", q: 0 }];
    /** @type {Map<number, number>} closing ) or ] index -> opening index */
    this.match = new Map();
    /** @type {Set<number>} colons that end a ternary's middle */
    this.ternary = new Set();
    /** @type {{ depth: number, name: string | null, at: number } | null} */
    this.pendingClass = null;
    /** @type {Site[]} */
    this.sites = [];
    this.esm = false;
    this.lines = lineIndex(src);
  }

  get top() { return this.frames.at(-1); }

  run() {
    for (let i = 0; i < this.tok.length; i++) this.visit(i);
    return this.sites;
  }

  visit(i) {
    const t = this.tok[i];
    if (t.t === "tpl") return this.template(t, i);
    if (t.t === "name") return this.word(t, i);
    if (t.t !== "punct") return undefined;
    if (t.v === "(" || t.v === "[") return this.frames.push({ ch: t.v, open: i, kind: t.v, q: 0 });
    if (t.v === ")" || t.v === "]") return this.close(i);
    if (t.v === "{") return this.brace(i);
    if (t.v === "}") return this.pop(i);
    return this.ternaryMark(t, i);
  }

  // A closed function or block records where it ends, for nesting in coverage reports.
  pop(i = -1) {
    const f = this.frames.length > 1 ? this.frames.pop() : undefined;
    if (f?.site && i >= 0) f.site.end = this.tok[i].e;
  }

  template(t, i) {
    if (t.v.startsWith("}")) this.pop();
    if (t.v.endsWith("${")) this.frames.push({ ch: "${", open: i, kind: "tpl", q: 0 });
  }

  word(t, i) {
    const prev = this.tok[i - 1];
    if (isPunct(prev, ".") || isPunct(prev, "?.")) return;
    const next = this.tok[i + 1];
    if (t.v === "class") this.classWord(t, next);
    const moduleWord = t.v === "import" || t.v === "export";
    if (moduleWord && this.frames.length === 1 && !isPunct(next, "(") && !isPunct(next, ".")) this.esm = true;
  }

  // `get class() {}` and `{ class: x }` name a property; a class is followed by its name, extends or {.
  classWord(t, next) {
    if (!isName(next) && !isPunct(next, "{")) return;
    this.pendingClass = {
      depth: this.frames.length, name: isName(next) && next.v !== "extends" ? next.v : null, at: t.s,
    };
  }

  ternaryMark(t, i) {
    const top = this.top;
    if (!top) return;
    if (t.v === "?") top.q++;
    else if (t.v === ":" && top.q > 0) { top.q--; this.ternary.add(i); }
  }

  close(i) {
    const want = this.tok[i].v === ")" ? "(" : "[";
    while (this.frames.length > 1 && this.top?.ch !== want && this.top?.ch !== "${") this.frames.pop();
    if (this.top?.ch === want) this.match.set(i, /** @type {Frame} */ (this.frames.pop()).open);
  }

  brace(i) {
    const kind = this.classify(i);
    /** @type {Frame} */
    const frame = { ch: "{", open: i, kind, q: 0, name: null };
    if (kind === "class") {
      frame.name = this.pendingClass?.name ?? null;
      frame.start = this.pendingClass?.at;
      this.pendingClass = null;
    } else if (kind === "object") {
      const name = this.nameBefore(i);
      frame.name = name.startsWith("(") ? null : name;
    }
    const before = this.sites.length;
    if (FUNCTION_KINDS.has(kind)) this.addFunction(i, kind);
    else if (BLOCK_KINDS.has(kind)) this.addSite("b", kind, kind, i, i);
    if (this.sites.length > before) frame.site = this.sites.at(-1);
    this.frames.push(frame);
  }

  classify(i) {
    const prev = this.tok[i - 1];
    if (this.pendingClass && this.pendingClass.depth === this.frames.length) return "class";
    if (!prev) return "block";
    if (prev.t === "punct") return this.afterPunct(prev, i);
    if (prev.t === "name") return this.afterWord(prev);
    return prev.t === "tpl" ? "object" : "block";
  }

  afterWord(prev) {
    if (Object.hasOwn(AFTER_WORD, prev.v)) return AFTER_WORD[prev.v];
    if (prev.v === "static" && this.top?.kind === "class") return "static";
    return OBJECT_AFTER.has(prev.v) ? "object" : "block";
  }

  afterPunct(prev, i) {
    if (prev.v === "=>") return "arrow";
    if (prev.v === ")") return this.afterParen(i - 1);
    if (prev.v === ":") return this.afterColon(i - 1);
    return [";", "}", "{", "]"].includes(prev.v) ? "block" : "object";
  }

  afterColon(c) {
    if (this.ternary.has(c)) return "object";
    const kind = this.top?.kind;
    if (kind === "switch") return "case";
    return kind === "object" || kind === "class" ? "object" : "block";
  }

  afterParen(p) {
    const open = this.match.get(p);
    if (open === undefined) return "block";
    const before = this.tok[open - 1];
    if (this.functionHead(open) !== null) return "function";
    if (this.top?.kind === "class" || this.top?.kind === "object") return "method";
    const dotted = isPunct(this.tok[open - 2], ".");
    if (isName(before) && Object.hasOwn(CONTROL, before.v) && !dotted) return CONTROL[before.v];
    return "block";
  }

  /** Index of `function` (or the `async` before it) for a parameter list opening at `open`, else null. */
  functionHead(open) {
    let j = open - 1;
    if (isName(this.tok[j]) && this.tok[j].v !== "function") j--;
    if (isPunct(this.tok[j], "*")) j--;
    if (!isName(this.tok[j], "function") || isPunct(this.tok[j - 1], ".")) return null;
    return isName(this.tok[j - 1], "async") ? j - 1 : j;
  }

  addFunction(i, kind) {
    const { head, name } = kind === "arrow" ? this.arrowInfo(i) : kind === "function" ? this.functionInfo(i)
      : this.methodInfo(i);
    this.addSite("f", kind, name, head, i);
    // A class constructor's code range, to V8, is the whole class.
    const top = this.top;
    if (kind === "method" && top?.kind === "class" && top.start !== undefined) {
      /** @type {Site} */ (this.sites.at(-1)).outer = top.start;
    }
  }

  addSite(k, kind, name, head, i) {
    const body = this.tok[i];
    const { line, col } = lineOf(this.lines, this.tok[head].s);
    /** @type {Site} */
    const site = { k, kind, name, head: this.tok[head].s, body: body.s, at: body.e, line, col };
    if (k === "f") Object.assign(site, this.directive(i));
    this.sites.push(site);
  }

  // A body that opens with "use strict" keeps it first, or it would stop being a directive.
  directive(i) {
    const d = this.tok[i + 1];
    const after = this.tok[i + 2];
    if (d?.t !== "str") return {};
    if (isPunct(after, ";")) return { at: after.e };
    const nextLine = after && lineOf(this.lines, after.s).line > lineOf(this.lines, d.e).line;
    if (isPunct(after, "}") || (nextLine && isName(after))) return { at: d.e, semi: true };
    return {};
  }

  arrowInfo(i) {
    let j = i - 2;
    if (isPunct(this.tok[j], ")")) j = this.match.get(j) ?? j;
    if (isName(this.tok[j - 1], "async")) j--;
    return { head: j, name: this.nameBefore(j) };
  }

  functionInfo(i) {
    const open = /** @type {number} */ (this.match.get(i - 1));
    const head = /** @type {number} */ (this.functionHead(open));
    const own = this.tok[open - 1];
    const name = isName(own) && own.v !== "function" ? own.v : this.nameBefore(head);
    return { head, name };
  }

  methodInfo(i) {
    const open = /** @type {number} */ (this.match.get(i - 1));
    let j = open - 1;
    const key = this.tok[j];
    if (isPunct(key, "]")) j = this.match.get(j) ?? j;
    return this.modifiers(j, isPunct(key, "]") ? "[computed]" : unquote(key));
  }

  // static, async, get, set and * before a method name: the head starts at the first, get/set name it.
  modifiers(j, key) {
    let label = key;
    for (let n = 0; n < 3; n++) {
      const m = this.tok[j - 1];
      if (!m || !MODIFIERS.has(m.v) || (m.t !== "name" && m.v !== "*")) break;
      if (m.v === "get" || m.v === "set") label = `${m.v} ${label}`;
      j--;
    }
    return { head: j, name: this.qualify(label) };
  }

  qualify(label) {
    const owner = this.top?.name;
    return owner ? `${owner}.${label}` : label;
  }

  // What an anonymous function is called: the variable or property it is assigned to, or the call it is
  // passed to.
  nameBefore(j) {
    const p = this.tok[j - 1];
    if (!p) return "(anonymous)";
    if (p.t === "punct" && ASSIGN.has(p.v)) return this.assignedName(j - 2);
    if (isPunct(p, ":")) return this.keyName(j - 1);
    if (isPunct(p, "(") || isPunct(p, ",")) return this.calleeName();
    return isName(p, "default") ? "default" : "(anonymous)";
  }

  keyName(colon) {
    const key = this.tok[colon - 1];
    if (this.ternary.has(colon) || !["name", "str", "num"].includes(key?.t)) return "(anonymous)";
    return this.qualify(unquote(key));
  }

  calleeName() {
    const top = this.top;
    const callee = top?.ch === "(" ? this.tok[top.open - 1] : null;
    return isName(callee) ? `(${callee?.v} callback)` : "(anonymous)";
  }

  assignedName(k) {
    const target = this.tok[k];
    if (!isName(target)) return "(anonymous)";
    const owner = isPunct(this.tok[k - 1], ".") ? this.tok[k - 2] : null;
    if (owner && isName(owner)) return `${owner.v}.${target.v}`;
    return this.top?.kind === "class" ? this.qualify(target.v) : target.v;
  }
}

/**
 * The function bodies and branch blocks of a file, in source order. `esm` says whether it has top-level
 * import or export.
 * @param {string} src
 * @returns {{ sites: Site[], esm: boolean, top: { at?: number, semi?: boolean }, error: string | null }}
 */
export function findSites(src) {
  const { tokens, error } = tokenize(src);
  if (error) return { sites: [], esm: false, top: {}, error };
  const finder = new Finder(src, tokens);
  const sites = finder.run();
  const top = finder.directive(-1);
  // Code the instrumenter wrote itself (the counter's own functions) is not the mod's.
  const skip = src.indexOf(PROLOGUE_END);
  return { sites: skip < 0 ? sites : sites.filter((s) => s.head > skip), esm: finder.esm, top, error: null };
}

/** A number for a file that is the same every time the same mod and path are instrumented. */
export function fileIdOf(modId, rel) {
  return parseInt(fnv1a(`${modId}/${rel}`), 16) & 0x7fffffff;
}

/**
 * One line, idempotent: the first instrumented file to run installs the counter; every file registers
 * its own table entry. __tbCovDump() writes compact count lines to UI.log, for after a crash.
 */
export function prologue({ fileId, modId, rel, n }) {
  const dump = "function(){var d=Date.now().toString(36),n=0;for(var f in C.files){var e=C.files[f],"
    + "ls=[],l=\"\";for(var s in e.c){var x=s+\":\"+e.c[s];if(l.length+x.length>700){ls.push(l);l=\"\";}"
    + "l+=(l?\",\":\"\")+x;}ls.push(l);for(var k=0;k<ls.length;k++){console.error(\"[TB-COVERAGE] d=\"+d+"
    + "\" f=\"+f+\" \"+ls[k]);n++;}}return n;}";
  return "(function(g){if(!g.__tbCov){var C=g.__tbCoverage={v:1,started:Date.now(),files:{}};"
    + "g.__tbCov=function(f,s){var e=C.files[f];if(e)e.c[s]=(e.c[s]||0)+1;};"
    + `g.__tbCovDump=${dump};}var F=g.__tbCoverage.files;`
    + `if(!F[${fileId}])F[${fileId}]={m:${JSON.stringify(modId)},p:${JSON.stringify(rel)},n:${n},c:{}};`
    + `})(globalThis);${PROLOGUE_END}`;
}

// Where the prologue goes: after a leading directive such as "use strict", else at the very start. A #! line
// is a comment to its end, so the prologue starts the next line instead.
function prologueAt(src, top) {
  if (src.startsWith("#!")) return { at: src.indexOf("\n") + 1 || src.length, semi: false };
  const bom = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  return top.at === undefined ? { at: bom, semi: false } : { at: top.at, semi: !!top.semi };
}

/**
 * The counting copy of one file. `table` lists the sites in counter order: k "f" a function, "b" a block.
 * @param {string} src
 * @param {{ fileId: number, modId: string, rel: string, blocks?: boolean }} opts
 */
export function instrumentSource(src, { fileId, modId, rel, blocks = true }) {
  const found = findSites(src);
  if (found.error) return { code: src, table: [], esm: false, error: found.error };
  const sites = found.sites.filter((s) => blocks || s.k === "f");
  const edits = sites.map((s, n) => ({ at: s.at, text: `${s.semi ? ";" : ""}globalThis.__tbCov?.(${fileId},${n});` }));
  const p = prologueAt(src, found.top);
  edits.push({ at: p.at, text: `${p.semi ? ";" : ""}${prologue({ fileId, modId, rel, n: sites.length })}` });
  edits.sort((a, b) => a.at - b.at);
  let code = "";
  let from = 0;
  for (const e of edits) {
    code += src.slice(from, e.at) + e.text;
    from = e.at;
  }
  code += src.slice(from);
  const table = sites.map((s) => ({ k: s.k, kind: s.kind, name: s.name, line: s.line, col: s.col }));
  return { code, table, esm: found.esm, error: null };
}

/** node --check over one text, as a module or a script. Null when it parses, else the first error line. */
export function syntaxError(code, esm, dir = os.tmpdir()) {
  const tmp = fs.mkdtempSync(path.join(dir, "tb-cov-"));
  const file = path.join(tmp, esm ? "check.mjs" : "check.cjs");
  try {
    fs.writeFileSync(file, code);
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", timeout: 30000 });
    if (r.status === 0) return null;
    const lines = String(r.stderr ?? "").split(/\r?\n/);
    return lines.find((l) => /Error:/.test(l))?.trim() ?? lines.find(Boolean) ?? `exit ${r.status}`;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Instruments one file and proves the copy still parses whenever the original did. On any doubt the
 * plain source is returned with the reason.
 * @param {string} src
 * @param {{ fileId: number, modId: string, rel: string, blocks?: boolean, check?: boolean }} opts
 */
export function instrumentChecked(src, opts) {
  const r = instrumentSource(src, opts);
  if (r.error) return { ...r, code: src, table: [], skipped: `not instrumented: ${r.error}` };
  if (opts.check === false) return { ...r, skipped: null };
  const after = syntaxError(r.code, r.esm);
  if (!after) return { ...r, skipped: null };
  const before = syntaxError(src, r.esm);
  const why = before ? `the source itself does not parse here (${before})` : `the counting copy would not parse (${after})`;
  return { ...r, code: src, table: [], skipped: `not instrumented: ${why}` };
}
