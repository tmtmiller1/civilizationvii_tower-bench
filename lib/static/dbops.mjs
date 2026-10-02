// SQL and XML database files read into row operations: inserts (row / replace / ignore), updates,
// deletes and CREATE TABLE. Values stay strings; anything this reader cannot evaluate is "<expr>".
import { child, parseLenient } from "./xml.mjs";
import { readText, stableJson } from "./util.mjs";

/**
 * @typedef {{ op: "row" | "replace" | "ignore" | "update" | "delete" | "create", table: string,
 *   values?: Record<string, string | null>, set?: Record<string, string | null>,
 *   where?: Record<string, string> | null, whereRaw?: string, positional?: boolean, raw?: (string | null)[],
 *   select?: boolean, partial?: boolean, effect?: string, collection?: string,
 *   ages?: Set<string> | null, conditional?: boolean }} DbOp
 * @typedef {[string, string]} Token
 */

const SQL_TOKEN = new RegExp([
  String.raw`(?<ws>\s+)`, String.raw`(?<lc>--[^\n]*)`, String.raw`(?<bc>/\*[\s\S]*?\*/)`,
  String.raw`(?<str>'(?:[^']|'')*')`, String.raw`(?<qid>"(?:[^"]|"")*"|` + "`[^`]*`" + String.raw`|\[[^\]]*\])`,
  String.raw`(?<num>-?\d+(?:\.\d+)?)`, String.raw`(?<id>[A-Za-z_][A-Za-z0-9_$.]*)`,
  String.raw`(?<p>[(),;=*<>!|+\-/%.]+|\S)`,
].join("|"), "g");
const MULTI = new Set(["<>", "!=", "<=", ">=", "||", "=="]);

const SKIP = new Set(["ws", "lc", "bc"]);

/** @returns {Token[]} */
export function sqlTokens(text) {
  /** @type {Token[]} */
  const out = [];
  for (const m of text.matchAll(SQL_TOKEN)) {
    const [kind, v] = /** @type {[string, string]} */ (Object.entries(m.groups ?? {}).find(([, x]) => x !== undefined));
    if (!SKIP.has(kind)) out.push(...token(kind, v));
  }
  return out;
}

/** @returns {Token[]} */
function token(kind, v) {
  if (kind === "str") return [["str", v.slice(1, -1).replaceAll("''", "'")]];
  if (kind === "qid") return [["id", v.slice(1, -1)]];
  // a run of punctuation is one token per character, except the two-character operators
  if (kind === "p" && v.length > 1 && !MULTI.has(v)) return [...v].map((c) => ["p", c]);
  return [[kind, v]];
}

const isP = (t, c) => t !== undefined && t[0] === "p" && t[1] === c;
const isKw = (t, w) => t !== undefined && t[0] === "id" && t[1].toUpperCase() === w;

/** @param {Token[]} tokens */
function splitStatements(tokens) {
  /** @type {Token[][]} */
  const out = [];
  let cur = [];
  for (const t of tokens) {
    if (isP(t, ";")) {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** @param {Token[]} tokens */
function splitTop(tokens, sep = ",") {
  let depth = 0;
  /** @type {Token[][]} */
  const out = [];
  let cur = [];
  for (const t of tokens) {
    if (isP(t, "(")) depth++;
    else if (isP(t, ")")) depth--;
    if (depth === 0 && isP(t, sep)) {
      out.push(cur);
      cur = [];
    } else cur.push(t);
  }
  out.push(cur);
  return out;
}

/** @param {Token[]} toks */
function literal(toks) {
  if (toks.length === 1 && (toks[0][0] === "str" || toks[0][0] === "num")) return toks[0][1];
  if (toks.length === 1 && isKw(toks[0], "NULL")) return null;
  return "<expr>";
}

/**
 * Simple `a = lit AND b = lit` conjunctions; anything else gives a null where (unevaluable) plus the raw text.
 * @param {Token[]} toks
 * @returns {[Record<string, string> | null, string]}
 */
function parseWhere(toks) {
  const raw = toks.map((t) => t[1]).join(" ");
  /** @type {Record<string, string>} */
  const out = {};
  for (const p of splitTop(toks.map((t) => (isKw(t, "AND") ? /** @type {Token} */ (["p", "\u0000"]) : t)), "\u0000")) {
    if (p.length === 3 && p[0][0] === "id" && isP(p[1], "=") && (p[2][0] === "str" || p[2][0] === "num")) {
      out[p[0][1].toLowerCase()] = p[2][1];
    } else return [null, raw];
  }
  return [out, raw];
}

/** @param {Token[]} st */
function closingParen(st, i) {
  let depth = 0;
  for (let j = i; j < st.length; j++) {
    if (isP(st[j], "(")) depth++;
    else if (isP(st[j], ")") && --depth === 0) return j;
  }
  throw new RangeError("unbalanced");
}

/** @param {Token[]} st @returns {DbOp[]} */
function insertOps(st, kw0) {
  let i = 1;
  let mode = kw0 === "INSERT" ? "row" : "replace";
  if (kw0 === "INSERT" && isKw(st[1], "OR")) {
    mode = isKw(st[2], "REPLACE") ? "replace" : "ignore";
    i = 3;
  }
  while (!isKw(st[i], "INTO")) if (++i >= st.length) throw new RangeError("no INTO");
  const table = st[i + 1][1];
  i += 2;
  /** @type {string[] | null} */
  let cols = null;
  if (isP(st[i], "(")) {
    const j = closingParen(st, i);
    cols = st.slice(i + 1, j).filter((t) => t[0] === "id").map((t) => t[1].toLowerCase());
    i = j + 1;
  }
  const op = /** @type {DbOp["op"]} */ (mode);
  if (!isKw(st[i], "VALUES")) return [{ op, table, values: {}, positional: cols === null, select: true }];
  return splitTop(st.slice(i + 1))
    .filter((tup) => tup.length && isP(tup[0], "(") && isP(tup[tup.length - 1], ")"))
    .map((tup) => {
      const vals = splitTop(tup.slice(1, -1)).map(literal);
      /** @type {Record<string, string | null>} */
      const values = {};
      (cols ?? []).forEach((c, n) => { if (n < vals.length) values[c] = vals[n]; });
      return { op, table, values, positional: cols === null, raw: vals };
    });
}

const whereIndex = (st, from) => {
  for (let k = from; k < st.length; k++) if (isKw(st[k], "WHERE")) return k;
  return -1;
};

/** @param {Token[]} st @returns {DbOp} */
function updateOp(st) {
  const table = st[1][1];
  const i = isKw(st[2], "SET") ? 3 : 2;
  if (st[2] === undefined) throw new RangeError("short UPDATE");
  const w = whereIndex(st, i);
  /** @type {Record<string, string | null>} */
  const set = {};
  for (const a of splitTop(w >= 0 ? st.slice(i, w) : st.slice(i))) {
    if (a.length >= 3 && a[0][0] === "id" && isP(a[1], "=")) set[a[0][1].toLowerCase()] = literal(a.slice(2));
  }
  const [where, whereRaw] = w >= 0 ? parseWhere(st.slice(w + 1)) : [{}, ""];
  return { op: "update", table, set, where, whereRaw };
}

/** @param {Token[]} st @param {string[]} kw @returns {DbOp} */
function deleteOp(st, kw) {
  if (kw[1] === undefined) throw new RangeError("short DELETE");
  const i = kw[1] !== "FROM" ? 1 : 2;
  const table = st[i][1];
  const w = whereIndex(st, i);
  const [where, whereRaw] = w >= 0 ? parseWhere(st.slice(w + 1)) : [{}, ""];
  return { op: "delete", table, where, whereRaw };
}

/** @param {Token[]} st @returns {DbOp} */
function createOp(st) {
  let i = st.findIndex((t) => t[1].toUpperCase() === "TABLE") + 1;
  if (isKw(st[i], "IF")) i += 3;
  return { op: "create", table: st[i][1] };
}

/** @param {Token[]} st @returns {DbOp[]} */
function statementOps(st) {
  const kw = st.slice(0, 4).filter((t) => t[0] === "id").map((t) => t[1].toUpperCase());
  if (kw[0] === "INSERT" || kw[0] === "REPLACE") return insertOps(st, kw[0]);
  if (kw[0] === "UPDATE") return [updateOp(st)];
  if (kw[0] === "DELETE") return [deleteOp(st, kw)];
  if (kw[0] === "CREATE" && kw.includes("TABLE")) return [createOp(st)];
  return [];
}

/**
 * @param {string} text
 * @returns {DbOp[]}
 */
export function parseSql(text) {
  /** @type {DbOp[]} */
  const ops = [];
  for (const st of splitStatements(sqlTokens(text))) {
    try {
      ops.push(...statementOps(st));
    } catch (e) {
      // a statement this reader cannot follow is skipped, as a truncated token list would be
      if (!(e instanceof RangeError || e instanceof TypeError)) throw e;
    }
  }
  return ops;
}

const lowerKeys = (attrs) => Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k.toLowerCase(), v]));
const INSERT_MODE = { Row: "row", Replace: "replace", InsertOrReplace: "replace", InsertOrIgnore: "ignore" };

function gameEffectsOps(root) {
  /** @type {DbOp[]} */
  const ops = [];
  for (const el of root.children) {
    if (el.tag === "Modifier" && el.attrs.id) {
      ops.push({ op: "row", table: "Modifiers", values: { modifierid: el.attrs.id }, partial: true,
        effect: el.attrs.effect, collection: el.attrs.collection });
    } else if (el.tag === "RequirementSet" && el.attrs.id) {
      ops.push({ op: "row", table: "RequirementSets", values: { requirementsetid: el.attrs.id }, partial: true });
    }
  }
  return ops;
}

/** @returns {DbOp | null} */
function xmlOp(table, el) {
  const values = lowerKeys(el.attrs);
  for (const ch of el.children) if (ch.tag !== "Where" && ch.tag !== "Set") values[ch.tag.toLowerCase()] = ch.text.trim();
  if (INSERT_MODE[el.tag]) return { op: INSERT_MODE[el.tag], table, values };
  if (el.tag === "Update") return xmlUpdate(table, el);
  if (el.tag === "Delete") return { op: "delete", table, where: values, whereRaw: stableJson(values) };
  return null;
}

/** @returns {DbOp} */
function xmlUpdate(table, el) {
  const w = child(el, "Where");
  const s = child(el, "Set");
  const where = w ? lowerKeys(w.attrs) : {};
  const set = s ? lowerKeys(s.attrs) : {};
  for (const ch of s?.children ?? []) set[ch.tag.toLowerCase()] = ch.text.trim();
  return { op: "update", table, set, where, whereRaw: stableJson(where) };
}

/**
 * @param {string} text
 * @returns {{ ops: DbOp[], error: string | null }}
 */
export function parseXmlDb(text) {
  const { root, error } = parseLenient(text);
  if (!root) return { ops: [], error };
  if (root.tag === "GameEffects") return { ops: gameEffectsOps(root), error: null };
  /** @type {DbOp[]} */
  const ops = [];
  for (const tableEl of root.children) {
    for (const el of tableEl.children) {
      const op = xmlOp(tableEl.tag, el);
      if (op) ops.push(op);
    }
  }
  return { ops, error: null };
}

/** @returns {{ ops: DbOp[], error: string | null }} */
export function dbOpsForFile(file) {
  const low = file.toLowerCase();
  if (low.endsWith(".sql")) return { ops: parseSql(readText(file)), error: null };
  if (low.endsWith(".xml")) return parseXmlDb(readText(file));
  return { ops: [], error: null };
}

/**
 * The primary-key identity of an insert, or null when the table has no key or a key value is not literal.
 * @param {import("./game.mjs").Schema} schema
 * @param {string} db
 * @param {DbOp} op
 * @returns {{ key: string, table: string, label: string } | null}
 */
export function rowKey(schema, db, op) {
  const t = schema.find(db, op.table);
  if (!t || !t.pk.length) return null;
  const vals = op.values ?? {};
  if (!t.pk.every((c) => vals[c] != null && vals[c] !== "<expr>")) return null;
  const pk = t.pk.map((c) => String(vals[c]));
  const table = t.name.toLowerCase();
  return { key: `${table}\u0001${pk.join("\u0001")}`, table, label: `${table}(${pk.join(", ")})` };
}
