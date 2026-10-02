// Declared types for the atlas: members of the globals in a folder of TypeScript declaration files (.d.ts),
// such as an SDK's typings. A small reader for declaration syntax, not a TypeScript parser: it understands
// `declare const|var|let`, namespaces, interfaces, type literals, enums and classes, and resolves a global
// whose type names an interface to that interface's members, two levels deep.
import fs from "node:fs";
import path from "node:path";
import { stripJsComments } from "./static/jsscan.mjs";
import { relPath, walkFiles } from "./static/util.mjs";

const OPEN = { "(": ")", "[": "]", "{": "}" };

/**
 * Splits text at depth-0 separators. A `}` that closes back to depth 0 also ends a piece when `blocks` is set,
 * so `interface A { } interface B { }` gives two statements.
 * @param {string} text @param {string} seps @param {boolean} [blocks]
 */
export function splitTop(text, seps, blocks = false) {
  /** @type {{ out: string[], stack: string[], start: number }} */
  const st = { out: [], stack: [], start: 0 };
  for (let i = 0; i < text.length; i++) splitStep(st, text, i, seps, blocks);
  st.out.push(text.slice(st.start));
  return st.out.map((s) => s.trim()).filter(Boolean);
}

/** @param {{ out: string[], stack: string[], start: number }} st @param {string} text @param {number} i */
function splitStep(st, text, i, seps, blocks) {
  const c = text[i];
  const { stack } = st;
  if (c in OPEN) stack.push(OPEN[c]);
  else if (stack.length) {
    if (c !== stack.at(-1)) return;
    stack.pop();
    // `interface A { }` ends a statement, `{ } | null` or `{ }[]` does not
    if (blocks && c === "}" && !stack.length && !/^\s*[,|&)\]=>[]/.test(text.slice(i + 1, i + 4))) cut(st, text, i + 1, i + 1);
  } else if (seps.includes(c)) cut(st, text, i, i + 1);
}

function cut(st, text, end, next) {
  st.out.push(text.slice(st.start, end));
  st.start = next;
}

/** The text between the first `{` and its matching `}`, and what precedes it. */
function braceBody(stmt) {
  const open = stmt.indexOf("{");
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < stmt.length; i++) {
    if (stmt[i] === "{") depth++;
    else if (stmt[i] === "}" && --depth === 0) return { head: stmt.slice(0, open), body: stmt.slice(open + 1, i) };
  }
  return null;
}

/** Parameter counts of a parameter list: required (no `?`, no default, not rest) and total. */
export function paramCounts(list) {
  const params = splitTop(list, ",").filter((p) => !/^this\s*:/.test(p));
  const required = params.filter((p) => !/^\.\.\./.test(p) && !/^[\w$]+\s*\?/.test(p) && !/^[^:]*=/.test(p)).length;
  return { required, total: params.some((p) => p.startsWith("...")) ? null : params.length };
}

const oneLine = (s) => s.replace(/\s+/g, " ").trim();

const METHOD = /^(?:(?:readonly|static|public|abstract|declare)\s+)*([\w$]+)\??\s*(?:<[^(]*>)?\s*\(([\s\S]*)\)\s*(?::\s*([\s\S]+))?$/;
const PROP = /^(?:(?:readonly|static|public|declare)\s+)*(?:get\s+)?([\w$]+)\??\s*:\s*([\s\S]+)$/;

/**
 * One member of an interface, class or type literal, or null for index and call signatures.
 * @returns {{ name: string, kind: "function" | "property", type: string, params?: { required: number,
 *   total: number | null }, signature: string, isStatic: boolean } | null}
 */
export function parseMember(text) {
  const t = oneLine(text);
  if (!t || /^[[(<]|^new\s*\(|^(?:constructor)\b/.test(t)) return null;
  const isStatic = /^(?:\w+\s+)*static\s/.test(t);
  const getter = /^(?:(?:static|public)\s+)*get\s+[\w$]+\s*\(\s*\)/.test(t);
  const m = METHOD.exec(t);
  if (m && !getter && !/^[\w$]+\??\s*:/.test(t.replace(/^(?:(?:readonly|static|public)\s+)+/, ""))) {
    return { name: m[1], kind: "function", type: m[3] ?? "", params: paramCounts(m[2]), signature: t, isStatic };
  }
  const g = /^(?:(?:static|public)\s+)*get\s+([\w$]+)\s*\(\s*\)\s*:\s*(.+)$/.exec(t);
  if (g) return { name: g[1], kind: "property", type: g[2], signature: t, isStatic };
  const p = PROP.exec(t);
  if (!p) return null;
  const fn = /^\(([\s\S]*)\)\s*=>/.exec(p[2]);
  if (fn) return { name: p[1], kind: "function", type: p[2], params: paramCounts(fn[1]), signature: t, isStatic };
  return { name: p[1], kind: "property", type: p[2], signature: t, isStatic };
}

/** @typedef {NonNullable<ReturnType<typeof parseMember>>} Member */

const membersOf = (body) => splitTop(body, ";,\n").map(parseMember).filter((m) => m !== null);

/**
 * @typedef {{ interfaces: Map<string, { members: Member[], ext: string[], file: string }>,
 *   globals: { name: string, type: string, file: string }[],
 *   direct: { path: string, member: Member, file: string }[] }} Decls
 */

const DECL_HEAD = /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(const|let|var|namespace|module|interface|type|enum|class|function|global)\b\s*([\w$.]*)/;

function readVars(decls, stmt, file, prefix) {
  const body = stmt.replace(/^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+/, "");
  for (const d of splitTop(body, ",")) {
    const m = /^([\w$]+)\s*:\s*([\s\S]+)$/.exec(d);
    if (!m) continue;
    if (prefix) decls.direct.push({ path: `${prefix}.${m[1]}`, member: /** @type {Member} */ (parseMember(d)), file });
    else decls.globals.push({ name: m[1], type: oneLine(m[2]), file });
  }
}

function readEnum(decls, name, body, file, prefix) {
  const full = prefix ? `${prefix}.${name}` : name;
  for (const e of splitTop(body, ",")) {
    const k = /^([\w$]+|"[^"]+"|'[^']+')/.exec(e)?.[1]?.replace(/['"]/g, "");
    if (k) decls.direct.push({ path: `${full}.${k}`, member: { name: k, kind: "property", type: "enum", signature: oneLine(e), isStatic: true }, file });
  }
}

function readTypeLike(decls, name, stmt, file) {
  const b = braceBody(stmt);
  if (!b) return;
  const ext = /\bextends\s+([\s\S]+)$/.exec(b.head)?.[1].split(",").map((s) => s.trim().replace(/<[\s\S]*$/, "")) ?? [];
  decls.interfaces.set(name, { members: membersOf(b.body), ext, file });
}

function readClass(decls, name, stmt, file, prefix) {
  const b = braceBody(stmt);
  if (!b) return;
  const members = membersOf(b.body);
  decls.interfaces.set(name, { members: members.filter((m) => !m.isStatic), ext: [], file });
  const full = prefix ? `${prefix}.${name}` : name;
  for (const m of members.filter((x) => x.isStatic)) decls.direct.push({ path: `${full}.${m.name}`, member: m, file });
}

/** @typedef {{ stmt: string, file: string, prefix: string, kind: string, name: string }} Stmt */

/** @param {Decls} decls @param {Stmt} x */
function readScope(decls, x) {
  const b = braceBody(x.stmt);
  const inner = x.kind === "global" ? x.prefix : [x.prefix, x.name].filter(Boolean).join(".");
  if (b) for (const s of splitTop(b.body, ";", true)) readStatement(decls, s, x.file, inner);
}

/** @param {Decls} decls @param {Stmt} x */
function readFunction(decls, x) {
  const member = x.prefix ? parseMember(x.stmt.replace(/^(?:export\s+)?(?:declare\s+)?function\s+/, "")) : null;
  if (member) decls.direct.push({ path: `${x.prefix}.${member.name}`, member, file: x.file });
}

/** @type {Record<string, (decls: Decls, x: Stmt) => void>} statement kind -> reader */
const READERS = {
  const: (d, x) => readVars(d, x.stmt, x.file, x.prefix),
  namespace: readScope,
  interface: (d, x) => readTypeLike(d, x.name, x.stmt, x.file),
  enum: (d, x) => readEnum(d, x.name, braceBody(x.stmt)?.body ?? "", x.file, x.prefix),
  class: (d, x) => readClass(d, x.name, x.stmt, x.file, x.prefix),
  function: readFunction,
};
Object.assign(READERS, { let: READERS.const, var: READERS.const, module: readScope, global: readScope,
  type: READERS.interface });

// Reads one statement into decls. `prefix` is the namespace it sits in.
function readStatement(decls, stmt, file, prefix) {
  const m = DECL_HEAD.exec(stmt);
  if (m) READERS[m[1]](decls, { stmt, file, prefix, kind: m[1], name: m[2] });
}

/** Every declaration in a set of .d.ts sources. @param {{ file: string, text: string }[]} sources */
export function readDeclarations(sources) {
  /** @type {Decls} */
  const decls = { interfaces: new Map(), globals: [], direct: [] };
  for (const { file, text } of sources) {
    for (const s of splitTop(stripJsComments(text), ";", true)) readStatement(decls, s, file, "");
  }
  return decls;
}

/** @param {Decls} decls @param {string} type */
function membersOfType(decls, type, seen = new Set()) {
  const t = type.trim();
  if (t.startsWith("{")) return membersOf(t.slice(1, t.lastIndexOf("}")));
  const name = /^([\w$.]+)/.exec(t)?.[1] ?? "";
  const iface = decls.interfaces.get(name);
  if (!iface || seen.has(name)) return [];
  seen.add(name);
  return [...iface.members, ...iface.ext.flatMap((e) => membersOfType(decls, e, seen))];
}

/**
 * @typedef {{ kind: string, signature: string, type: string, params?: { required: number, total: number | null },
 *   file: string }} SdkMember
 */

function memberRecord(member, file) {
  return { kind: member.kind, signature: member.signature, type: member.type, params: member.params, file };
}

/** @param {{ out: Record<string, SdkMember>, decls: Decls, file: string }} ctx */
function addTyped(ctx, prefix, type, depth) {
  for (const m of membersOfType(ctx.decls, type)) {
    const p = `${prefix}.${m.name}`;
    ctx.out[p] ??= memberRecord(m, ctx.file);
    if (depth > 1 && m.kind === "property") addTyped(ctx, p, m.type, depth - 1);
  }
}

/**
 * Atlas members from parsed declarations: `Root.member` (and one level below) -> declared kind and signature.
 * @param {Decls} decls
 * @returns {Record<string, SdkMember>}
 */
export function sdkMembers(decls) {
  /** @type {Record<string, SdkMember>} */
  const out = {};
  for (const d of decls.direct) {
    out[d.path] ??= memberRecord(d.member, d.file);
    if (d.member.kind === "property" && d.path.split(".").length < 3) addTyped({ out, decls, file: d.file }, d.path, d.member.type, 1);
  }
  for (const g of decls.globals) {
    out[g.name] ??= { kind: "global", signature: `${g.name}: ${g.type}`, type: g.type, file: g.file };
    addTyped({ out, decls, file: g.file }, g.name, g.type, 2);
  }
  return out;
}

/**
 * Reads every .d.ts under dir. File names in the result are relative to dir.
 * @param {string} dir
 */
export function readSdk(dir) {
  if (!dir || !fs.existsSync(dir)) throw new Error(`no SDK folder at ${dir}`);
  const files = (fs.statSync(dir).isDirectory() ? walkFiles(dir, { all: true }) : [dir]).filter((f) => f.endsWith(".d.ts"));
  const root = fs.statSync(dir).isDirectory() ? dir : path.dirname(dir);
  const sources = files.map((f) => ({ file: relPath(root, f), text: fs.readFileSync(f, "utf8") }));
  const members = sdkMembers(readDeclarations(sources));
  return { files: files.length, members };
}
