// What changed between two game indexes: files (added, removed, moved, changed), what each script exports,
// component names, the database schema, Types and modifier effect types.
import path from "node:path";

/**
 * @typedef {import("./patch-snapshot.mjs").GameIndex} GameIndex
 * @typedef {{ to: string, how: "moved" | "renamed" | "same-name" }} Successor
 * @typedef {{ file: string, to?: string, removed: string[], added: string[],
 *   renamed: { from: string, to: string }[] }} ExportChange
 * @typedef {{ db: string, table: string, column?: string }} SchemaFact
 */

const lower = (s) => s.toLowerCase();
// "x.chunk.js" became "x.js" in 1.5.0; both name the same module
const stem = (p) => path.posix.basename(lower(p)).replace(/\.chunk\.js$/, ".js");

/** Lower-case path -> the path as indexed. */
function byLower(files) {
  return new Map(Object.keys(files).map((k) => [lower(k), k]));
}

function uniqueBy(list, key) {
  /** @type {Map<string, string[]>} */
  const m = new Map();
  for (const x of list) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
}

/**
 * For every removed file, where it went: same content at a new path (moved), the one added file with the same
 * name (renamed), or a surviving file of that name in the same folder or anywhere (same-name).
 * @returns {Map<string, Successor>} keyed by the old path, lower case
 */
function successors(oldFiles, newFiles, removed, added) {
  /** @type {Map<string, Successor>} */
  const out = new Map();
  const addedByHash = uniqueBy(added, (k) => newFiles[k][0]);
  const addedByStem = uniqueBy(added, stem);
  const allByStem = uniqueBy(Object.keys(newFiles), stem);
  const taken = new Set();
  for (const k of removed) {
    const hits = (addedByHash.get(oldFiles[k][0]) ?? []).filter((x) => !taken.has(x));
    const pick = hits.find((x) => stem(x) === stem(k)) ?? hits[0];
    if (pick) {
      taken.add(pick);
      out.set(lower(k), { to: pick, how: "moved" });
    }
  }
  for (const k of removed.filter((x) => !out.has(lower(x)))) {
    const named = (addedByStem.get(stem(k)) ?? []).filter((x) => !taken.has(x));
    const s = named.length === 1 ? { to: named[0], how: "renamed" } : sameName(k, allByStem.get(stem(k)) ?? []);
    if (s) out.set(lower(k), s);
  }
  return out;
}

/** @returns {any} */
function sameName(k, candidates) {
  const dir = lower(path.posix.dirname(k));
  const near = candidates.find((x) => lower(path.posix.dirname(x)) === dir);
  if (near) return { to: near, how: "same-name" };
  return candidates.length === 1 ? { to: candidates[0], how: "same-name" } : null;
}

/** @returns {ExportChange | null} */
function exportChange(file, to, before = {}, after = {}) {
  const removed = Object.keys(before).filter((n) => !(n in after)).sort();
  const added = Object.keys(after).filter((n) => !(n in before)).sort();
  // the same local binding under a new exported name
  const localOf = (names, n) => names[n] || n;
  const renamed = removed.flatMap((n) => {
    const hit = added.find((a) => localOf(after, a) === localOf(before, n));
    return hit ? [{ from: n, to: hit }] : [];
  });
  if (!removed.length && !added.length) return null;
  return { file, ...(to && to !== file ? { to } : {}), removed, added, renamed };
}

/** @param {GameIndex} a @param {GameIndex} b */
function exportChanges(a, b, succ) {
  const newLower = byLower(b.files);
  /** @type {ExportChange[]} */
  const out = [];
  for (const k of Object.keys(a.exports)) {
    const same = newLower.get(lower(k));
    const to = same ?? succ.get(lower(k))?.to;
    if (!to) continue;
    const ch = exportChange(k, to, a.exports[k], b.exports[to]);
    if (ch) out.push(ch);
  }
  return out;
}

const setDiff = (x, y) => {
  const ys = new Set(y);
  return x.filter((v) => !ys.has(v)).sort();
};

/** @param {GameIndex} a @param {GameIndex} b */
function schemaDiff(a, b) {
  if (!a.schema || !b.schema) {
    const missing = a.schema ? b : a;
    return { available: false, note: `schema missing from ${missing.version} (${missing.schemaNote ?? "no Debug database"})` };
  }
  /** @type {Record<string, SchemaFact[]>} */
  const r = { tablesAdded: [], tablesRemoved: [], columnsAdded: [], columnsRemoved: [], nowRequired: [] };
  // a database missing from one side was not read there; that says nothing about its tables
  for (const db of Object.keys(a.schema).filter((x) => b.schema?.[x])) {
    const ta = a.schema[db];
    const tb = /** @type {any} */ (b.schema)[db];
    for (const t of setDiff(Object.keys(tb), Object.keys(ta))) r.tablesAdded.push({ db, table: tb[t].name });
    for (const t of setDiff(Object.keys(ta), Object.keys(tb))) r.tablesRemoved.push({ db, table: ta[t].name });
    for (const t of Object.keys(ta).filter((x) => x in tb)) tableDiff(r, db, ta[t], tb[t]);
  }
  return { available: true, ...r };
}

function tableDiff(r, db, x, y) {
  for (const c of setDiff(y.cols, x.cols)) r.columnsAdded.push({ db, table: y.name, column: c });
  for (const c of setDiff(x.cols, y.cols)) r.columnsRemoved.push({ db, table: x.name, column: c });
  for (const c of setDiff(y.required, x.required)) r.nowRequired.push({ db, table: y.name, column: c });
}

/**
 * @param {GameIndex} a the older index
 * @param {GameIndex} b the newer index
 */
export function diffIndexes(a, b) {
  const oldLower = byLower(a.files);
  const newLower = byLower(b.files);
  const removed = Object.keys(a.files).filter((k) => !newLower.has(lower(k))).sort();
  const added = Object.keys(b.files).filter((k) => !oldLower.has(lower(k))).sort();
  const changed = Object.keys(a.files).filter((k) => {
    const n = newLower.get(lower(k));
    return n !== undefined && a.files[k][0] !== b.files[n][0];
  }).sort();
  const succ = successors(a.files, b.files, removed, added);
  const moved = [...succ].filter(([, s]) => s.how !== "same-name").map(([k, s]) => ({ from: oldLower.get(k), ...s }));
  const movedTo = new Set(moved.map((m) => m.to));
  const movedFrom = new Set(moved.map((m) => lower(m.from ?? "")));
  return {
    from: a.version, to: b.version,
    files: { added: added.filter((k) => !movedTo.has(k)), removed: removed.filter((k) => !movedFrom.has(lower(k))),
      moved, changed },
    successors: Object.fromEntries(succ),
    exports: exportChanges(a, b, succ),
    components: { legacy: listDiff(a.components.legacy, b.components.legacy),
      registry: listDiff(a.components.registry, b.components.registry) },
    schema: schemaDiff(a, b),
    types: typesDiff(a.types, b.types, a.schema && b.schema),
    effectTypes: typesDiff(a.effectTypes, b.effectTypes, a.schema && b.schema),
  };
}

const listDiff = (x, y) => ({ added: setDiff(y, x), removed: setDiff(x, y) });

function typesDiff(x, y, both) {
  if (!both) return { available: false, added: [], removed: [] };
  return { available: true, added: setDiff(y, x), removed: setDiff(x, y) };
}

/** @typedef {ReturnType<typeof diffIndexes>} IndexDiff */
