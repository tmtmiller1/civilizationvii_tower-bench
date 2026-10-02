// A small JavaScript tokenizer for the coverage instrumenter. It knows exactly as much syntax as finding
// function bodies needs: strings, template literals (nested through ${ }), regex literals told apart from
// division by the token before them, comments and numbers. Not a parser: it never builds a tree.

/**
 * @typedef {{ t: "name" | "punct" | "num" | "str" | "tpl" | "regex", v: string, s: number, e: number }} Token
 * @typedef {{ tokens: Token[], error: string | null }} Lexed
 */

const PUNCT = [
  ">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
  "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=",
  "**", "<<", ">>",
];
const SINGLE = "{}()[];,<>+-*/%&|^!~?:=.@#";

// After these words an expression starts, so a slash opens a regex.
const REGEX_AFTER_WORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);

const NAME = /[A-Za-z_$\u0080-￿#][\w$\u0080-￿]*/y;
const NUMBER = /(?:0[xXoObB][\da-fA-F_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?)/y;

/** @param {Token | undefined} prev */
export function regexAllowed(prev) {
  if (!prev) return true;
  if (prev.t === "num" || prev.t === "str" || prev.t === "regex") return false;
  if (prev.t === "tpl") return !prev.v.endsWith("`");
  if (prev.t === "name") return REGEX_AFTER_WORD.has(prev.v);
  return ![")", "]", "}", "++", "--"].includes(prev.v);
}

/** End of a quoted string starting at `i`, or -1. */
function scanString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    // A backslash escapes the next character, or continues the line over a CRLF.
    if (c === "\\") j += src.startsWith("\r\n", j + 1) ? 2 : 1;
    else if (c === q) return j + 1;
    else if (c === "\n" || c === "\r") return -1;
  }
  return -1;
}

const flagsEnd = (src, k) => {
  while (k < src.length && /[\w$]/.test(src[k])) k++;
  return k;
};

/** End of a regex literal starting at `i` (flags included), or -1 when it is not one. */
function scanRegex(src, i) {
  let inClass = false;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") j++;
    else if (c === "\n" || c === "\r") return -1;
    else if (c === "[" || c === "]") inClass = c === "[";
    else if (c === "/" && !inClass) return flagsEnd(src, j + 1);
  }
  return -1;
}

/**
 * Scans template text from `i` (just after a backtick or the closing brace of a substitution) to the
 * closing backtick or the next "${". Returns where it stopped and how.
 */
function scanTemplate(src, i) {
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") j++;
    else if (c === "`") return { end: j + 1, open: false };
    else if (c === "$" && src[j + 1] === "{") return { end: j + 2, open: true };
  }
  return null;
}

/** End of a comment starting at `i`, or 0 when no comment starts there. */
function scanComment(src, i) {
  if (src[i] !== "/") return 0;
  if (src[i + 1] === "/") {
    const nl = src.slice(i).search(/[\n\r\u2028\u2029]/);
    return nl < 0 ? src.length : i + nl;
  }
  if (src[i + 1] === "*") {
    const close = src.indexOf("*/", i + 2);
    return close < 0 ? -1 : close + 2;
  }
  return 0;
}

function matchAt(rx, src, i) {
  rx.lastIndex = i;
  const m = rx.exec(src);
  return m ? m[0] : null;
}

function punctAt(src, i) {
  for (const p of PUNCT) {
    if (src.startsWith(p, i)) return p === "?." && /\d/.test(src[i + 2] ?? "") ? "?" : p;
  }
  return SINGLE.includes(src[i]) ? src[i] : null;
}

class Lexer {
  /** @param {string} src */
  constructor(src) {
    this.src = src;
    /** @type {Token[]} */
    this.tokens = [];
    /** @type {string[]} "{" for a brace, "${" for a template substitution */
    this.braces = [];
    this.i = 0;
    this.error = null;
  }

  push(t, s, e) {
    this.tokens.push({ t, v: this.src.slice(s, e), s, e });
    this.i = e;
  }

  fail(what) {
    this.error = `${what} at offset ${this.i}`;
    return false;
  }

  template(start, from) {
    const r = scanTemplate(this.src, from);
    if (!r) return this.fail("unterminated template literal");
    this.push("tpl", start, r.end);
    if (r.open) this.braces.push("${");
    return true;
  }

  closeBrace() {
    if (this.braces.pop() === "${") return this.template(this.i, this.i + 1);
    this.push("punct", this.i, this.i + 1);
    return true;
  }

  slash() {
    const end = regexAllowed(this.tokens.at(-1)) ? scanRegex(this.src, this.i) : -1;
    if (end > 0) this.push("regex", this.i, end);
    else this.push("punct", this.i, this.i + (punctAt(this.src, this.i)?.length ?? 1));
    return true;
  }

  word() {
    const { src, i } = this;
    const num = /[\d.]/.test(src[i]) ? matchAt(NUMBER, src, i) : null;
    if (num && num !== ".") { this.push("num", i, i + num.length); return true; }
    const name = matchAt(NAME, src, i);
    if (name) { this.push("name", i, i + name.length); return true; }
    const p = punctAt(src, i);
    if (!p) return this.fail(`unexpected character ${JSON.stringify(src[i])}`);
    if (p === "{") this.braces.push("{");
    this.push("punct", i, i + p.length);
    return true;
  }

  quoted() {
    const end = scanString(this.src, this.i);
    if (end < 0) return this.fail("unterminated string");
    this.push("str", this.i, end);
    return true;
  }

  step() {
    const c = this.src[this.i];
    const comment = scanComment(this.src, this.i);
    if (comment < 0) return this.fail("unterminated comment");
    if (comment > 0) { this.i = comment; return true; }
    if (c === "/") return this.slash();
    if (c === "'" || c === '"') return this.quoted();
    if (c === "`") return this.template(this.i, this.i + 1);
    if (c === "}") return this.closeBrace();
    return this.word();
  }

  run() {
    const { src } = this;
    if (src.startsWith("#!")) this.i = Math.max(0, src.indexOf("\n"));
    while (this.i < src.length) {
      if (/\s/.test(src[this.i])) { this.i++; continue; }
      if (!this.step()) break;
    }
    if (!this.error && this.braces.length) this.error = "unbalanced braces at end of file";
    return { tokens: this.tokens, error: this.error };
  }
}

/** @param {string} src @returns {Lexed} */
export function tokenize(src) {
  return new Lexer(src).run();
}

/** Line starts, for turning offsets into 1-based line and column numbers. */
export function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return starts;
}

/** @param {number[]} starts @param {number} offset */
export function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return { line: lo + 1, col: offset - starts[lo] + 1 };
}
