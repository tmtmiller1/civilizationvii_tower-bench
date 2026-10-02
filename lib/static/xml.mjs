// A small strict XML parser for modinfo and database files. It rejects what an expat-based parser rejects
// in practice (mismatched tags, bare ampersands, "--" in comments, junk after the root), so the lenient
// repair below is only reached for files a strict parser would refuse.

/**
 * @typedef {{ tag: string, rawTag?: string, attrs: Record<string, string>, children: XmlNode[], text: string }} XmlNode
 */

export class XmlError extends Error {}

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };
const NAME_START = /[A-Za-z_:À-￿]/;
const NAME_RX = /[A-Za-z_:À-￿][\w:.\-·À-￿]*/y;
const BAD_CHAR = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/;

class Parser {
  constructor(text) {
    this.s = text.replace(/\r\n?/g, "\n");
    this.i = 0;
    /** @type {XmlNode[]} */
    this.stack = [];
    /** @type {XmlNode | null} */
    this.root = null;
  }

  /** @returns {never} */
  fail(msg, at = this.i) {
    const before = this.s.slice(0, at);
    const line = before.split("\n").length;
    const col = at - (before.lastIndexOf("\n") + 1);
    throw new XmlError(`${msg}: line ${line}, column ${col}`);
  }

  parse() {
    if (this.s.startsWith("<?xml")) this.pi(true);
    while (this.i < this.s.length) {
      const lt = this.s.indexOf("<", this.i);
      const chunk = this.s.slice(this.i, lt < 0 ? this.s.length : lt);
      this.textChunk(chunk);
      if (lt < 0) break;
      this.i = lt;
      this.markup();
    }
    if (!this.root || this.stack.length) this.fail("no element found", this.s.length);
    return /** @type {XmlNode} */ (this.root);
  }

  textChunk(chunk) {
    if (!chunk) return;
    const top = this.stack[this.stack.length - 1];
    if (!top) {
      if (chunk.trim()) this.fail(this.root ? "junk after document element" : "syntax error");
      this.i += chunk.length;
      return;
    }
    if (BAD_CHAR.test(chunk)) this.fail("not well-formed (invalid token)");
    const text = this.decode(chunk, this.i);
    if (!top.children.length) top.text += text;
    this.i += chunk.length;
  }

  markup() {
    const s = this.s;
    if (s.startsWith("<!--", this.i)) return this.comment();
    if (s.startsWith("<![CDATA[", this.i)) return this.cdata();
    if (s.startsWith("<!DOCTYPE", this.i)) return this.doctype();
    if (s.startsWith("<?", this.i)) return this.pi(false);
    if (s.startsWith("</", this.i)) return this.close();
    return this.open();
  }

  comment() {
    const end = this.s.indexOf("-->", this.i + 4);
    if (end < 0) this.fail("unclosed token");
    const dash = this.s.indexOf("--", this.i + 4);
    if (dash < end) this.fail("not well-formed (invalid token)", dash);
    this.i = end + 3;
  }

  cdata() {
    const top = this.stack[this.stack.length - 1];
    if (!top) this.fail("syntax error");
    const end = this.s.indexOf("]]>", this.i);
    if (end < 0) this.fail("unclosed CDATA section");
    if (!top.children.length) top.text += this.s.slice(this.i + 9, end);
    this.i = end + 3;
  }

  doctype() {
    if (this.root || this.stack.length) this.fail("syntax error");
    let depth = 0;
    for (let j = this.i; j < this.s.length; j++) {
      const c = this.s[j];
      if (c === "[") depth++;
      else if (c === "]") depth--;
      else if (c === ">" && depth <= 0) { this.i = j + 1; return; }
    }
    this.fail("unclosed token");
  }

  pi(first) {
    const end = this.s.indexOf("?>", this.i);
    if (end < 0) this.fail("unclosed token");
    const target = this.s.slice(this.i + 2, end).split(/\s/)[0];
    if (!first && target.toLowerCase() === "xml") this.fail("XML or text declaration not at start of entity");
    this.i = end + 2;
  }

  name(at) {
    NAME_RX.lastIndex = at;
    const m = NAME_RX.exec(this.s);
    if (!m || !NAME_START.test(this.s[at])) this.fail("not well-formed (invalid token)", at);
    return /** @type {RegExpExecArray} */ (m)[0];
  }

  close() {
    const start = this.i;
    const name = this.name(this.i + 2);
    let j = this.i + 2 + name.length;
    while (/\s/.test(this.s[j] ?? "")) j++;
    if (this.s[j] !== ">") this.fail("not well-formed (invalid token)", j);
    const top = this.stack.pop();
    if (!top || top.rawTag !== name) this.fail("mismatched tag", start);
    this.i = j + 1;
  }

  open() {
    const name = this.name(this.i + 1);
    if (!this.stack.length && this.root) this.fail("junk after document element");
    this.i += 1 + name.length;
    const attrs = this.attributes();
    const node = { tag: localName(name), rawTag: name, attrs, children: [], text: "" };
    const parent = this.stack[this.stack.length - 1];
    if (parent) parent.children.push(node);
    else this.root = node;
    if (this.s.startsWith("/>", this.i)) this.i += 2;
    else { this.i += 1; this.stack.push(node); }
  }

  attributes() {
    /** @type {Record<string, string>} */
    const attrs = {};
    for (;;) {
      const ws = /\s*/y;
      ws.lastIndex = this.i;
      const gap = /** @type {RegExpExecArray} */ (ws.exec(this.s))[0].length;
      this.i += gap;
      const c = this.s[this.i];
      if (c === ">" || (c === "/" && this.s[this.i + 1] === ">")) return attrs;
      if (!gap || c === undefined) this.fail(c === undefined ? "unclosed token" : "not well-formed (invalid token)");
      this.attribute(attrs);
    }
  }

  attribute(attrs) {
    const name = this.name(this.i);
    const m = /\s*=\s*(["'])/y;
    m.lastIndex = this.i + name.length;
    const eq = m.exec(this.s);
    if (!eq) this.fail("not well-formed (invalid token)", this.i + name.length);
    const valStart = m.lastIndex;
    const end = this.s.indexOf(/** @type {RegExpExecArray} */ (eq)[1], valStart);
    if (end < 0) this.fail("unclosed token");
    const raw = this.s.slice(valStart, end);
    if (raw.includes("<")) this.fail("not well-formed (invalid token)", valStart + raw.indexOf("<"));
    const key = localName(name);
    if (Object.hasOwn(attrs, key)) this.fail("duplicate attribute", this.i);
    if (name !== "xmlns" && !name.startsWith("xmlns:")) attrs[key] = this.decode(raw.replace(/[\t\n]/g, " "), valStart);
    this.i = end + 1;
  }

  decode(raw, at) {
    if (!raw.includes("&")) return raw;
    return raw.replace(/&([^;&\s<]*);?/g, (all, ref, off) => this.entity(all, ref, at + off));
  }

  entity(all, ref, at) {
    if (!all.endsWith(";") || !ref) this.fail("not well-formed (invalid token)", at);
    if (Object.hasOwn(ENTITIES, ref)) return ENTITIES[ref];
    const num = /^#(?:x([0-9a-fA-F]+)|([0-9]+))$/.exec(ref);
    if (!num) return this.fail(/^[A-Za-z_]/.test(ref) ? "undefined entity" : "not well-formed (invalid token)", at);
    const cp = num[1] ? parseInt(num[1], 16) : parseInt(num[2], 10);
    if (!validChar(cp)) return this.fail("reference to invalid character number", at);
    return String.fromCodePoint(cp);
  }
}

const validChar = (cp) => cp > 0 && cp <= 0x10ffff && (cp >= 0x20 || [9, 10, 13].includes(cp));

const localName = (name) => (name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name);

/**
 * Parses a whole document; throws XmlError with an expat-style message.
 * @param {string} text
 * @returns {XmlNode}
 */
export function parseXml(text) {
  return new Parser(text.replace(/^﻿/, "")).parse();
}

/** First direct child with this tag. */
export const child = (node, tag) => node.children.find((c) => c.tag === tag);

/** Every descendant with this tag, document order. */
export function descendants(node, tag) {
  /** @type {XmlNode[]} */
  const out = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (c.tag === tag) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

/** The lenient pre-pass the game's loader tolerates: leading whitespace, comments containing "--", bare "&". */
export function xmlClean(text) {
  return text.replace(/^﻿/, "").trimStart()
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;");
}

const TAG_RE = /<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

/**
 * Closes tags the way the game's data loader does (watched on 1.5.0): a close tag matches its open tag
 * case-insensitively, the root's close tag closes one table element left open, and a close tag naming no
 * open element closes the innermost one. Deeper unclosed elements were not observed, so they stay errors.
 * @param {string} text
 */
export function xmlRepairTags(text) {
  /** @type {string[]} */
  const stack = [];
  return text.replace(TAG_RE, (all, closing, name, _attrs, selfclose) => {
    if (!closing) {
      if (!selfclose) stack.push(name);
      return all;
    }
    const low = stack.map((n) => n.toLowerCase());
    const i = low.lastIndexOf(name.toLowerCase());
    if (i < 0) return stack.length ? `</${stack.pop()}>` : all;
    if (i < stack.length - 1 && !(i === 0 && stack.length === 2)) return all;
    return stack.splice(i).reverse().map((n) => `</${n}>`).join("");
  });
}

/**
 * Strict parse, then the lenient pass; only a lenient failure is an error.
 * @param {string} text
 * @param {{ repair?: boolean }} [opts]
 * @returns {{ root: XmlNode | null, error: string | null }}
 */
export function parseLenient(text, opts = { repair: true }) {
  try {
    return { root: parseXml(text), error: null };
  } catch (e) {
    if (!(e instanceof XmlError)) throw e;
  }
  try {
    const clean = xmlClean(text);
    return { root: parseXml(opts.repair ? xmlRepairTags(clean) : clean), error: null };
  } catch (e) {
    if (!(e instanceof XmlError)) throw e;
    return { root: null, error: e.message };
  }
}
