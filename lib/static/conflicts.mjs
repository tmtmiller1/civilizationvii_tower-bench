// Pairwise conflicts between mods, read statically: shared ids, replaced vanilla files, component and
// registry collisions, prototype patches, shared storage keys and globals, database rows and text tags.
import { rowKey } from "./dbops.mjs";
import { code, listMore, pairs, push, stableJson } from "./util.mjs";

/**
 * @typedef {import("./mod.mjs").Mod} Mod
 * @typedef {"High" | "Medium" | "Low"} Severity
 * @typedef {{ a: string, b: string, aRoot: string, bRoot: string, severity: Severity, rule: string, text: string,
 *   static: true }} Conflict
 */

// Settings stores several mods share by design.
const SHARED_LS_KEYS = new Set(["modSettings"]);
const TEXT_TABLES = new Set(["localizedtext", "englishtext"]);

/**
 * Mods mirror vanilla paths as base-standard/..., modules/base-standard/... or module-relative ui/...;
 * every vanilla-rooted path this mod-relative path could stand for.
 * @param {string} rel
 * @param {import("./game.mjs").Vanilla} vanilla
 */
export function vanillaSuffixes(rel, vanilla) {
  const parts = rel.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "").split("/");
  const joined = parts.join("/");
  const out = [...(vanilla.rel.get(joined.toLowerCase()) ?? [])].map((v) => `${v}/${joined}`);
  parts.slice(0, -1).forEach((seg, i) => {
    if (vanilla.roots.has(seg.toLowerCase())) out.push(parts.slice(i).join("/"));
  });
  return out;
}

class Finder {
  constructor(mods, vanilla, schema) {
    /** @type {Mod[]} */
    this.mods = mods;
    this.vanilla = vanilla;
    this.schema = schema;
    /** @type {Conflict[]} */
    this.out = [];
    this.seen = new Set();
  }

  /** @param {Mod} a @param {Mod} b @param {Severity} severity */
  add(a, b, severity, rule, text) {
    if (a === b) return;
    const [x, y] = a.root < b.root ? [a, b] : [b, a];
    const key = `${x.root}\u0001${y.root}\u0001${rule}\u0001${text}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.out.push({ a: x.id, b: y.id, aRoot: x.root, bRoot: y.root, severity, rule, text, static: true });
  }

  /**
   * Mods grouped by a key each mod yields (a mod counts once per key).
   * @param {(m: Mod) => Iterable<string>} keysOf
   * @returns {Map<string, Mod[]>}
   */
  index(keysOf) {
    /** @type {Map<string, Mod[]>} */
    const idx = new Map();
    for (const m of this.mods) for (const k of new Set(keysOf(m))) push(idx, k, m);
    return idx;
  }

  sameId() {
    for (const [id, ms] of this.index((m) => m.ids)) {
      for (const [a, b] of pairs(ms)) {
        this.add(a, b, "High", "same-id", `same modinfo id ${code(id)}: the game registers one of them; a second copy can shadow the first or blank the UI`);
      }
    }
  }

  overrides() {
    /** @type {Map<string, { m: Mod, action: string, digest: string | null }[]>} */
    const idx = new Map();
    for (const m of this.mods) {
      for (const o of m.overrides) for (const t of overrideTargets(o.item, this.vanilla)) push(idx, t, { m, ...o });
    }
    for (const [t, list] of idx) {
      for (const [x, y] of pairs(list)) {
        if (x.m === y.m) continue;
        if (x.digest && x.digest === y.digest) {
          this.add(x.m, y.m, "Low", "vanilla-file-override", `both ship a byte-identical replacement of vanilla ${code(t)}; whichever loads last, the result is the same`);
        } else {
          this.add(x.m, y.m, "High", "vanilla-file-override", `both replace vanilla ${code(t)} (${x.action} / ${y.action}) with different files; only the last-loaded copy runs`);
        }
      }
    }
  }

  components() {
    const named = (rec) => Object.keys(rec).filter((n) => !n.startsWith("<"));
    const dec = this.index((m) => named(m.js.decorate));
    for (const [n, ms] of this.index((m) => named(m.js.define))) {
      const what = this.vanilla.components.has(n) ? "vanilla component" : "component";
      for (const [a, b] of pairs(ms)) {
        this.add(a, b, "High", "define-collision", `both register ${what} ${code(n)} with Controls.define; the second definition replaces the first`);
      }
      if (this.vanilla.components.has(n)) this.redefinedDecorated(n, ms, dec.get(n) ?? []);
    }
    for (const [n, ms] of dec) {
      if (ms.length > 60) continue;
      for (const [a, b] of pairs(ms)) {
        this.add(a, b, "Low", "decorate-chain", `both decorate ${code(n)} (decorators chain; conflicts only if both rewrite the same DOM)`);
      }
    }
  }

  /** @param {Mod[]} definers @param {Mod[]} decorators */
  redefinedDecorated(n, definers, decorators) {
    for (const d of decorators) {
      for (const x of definers.filter((m) => m !== d)) {
        this.add(x, d, "Medium", "define-over-decorated", `${x.name} redefines vanilla ${code(n)} and ${d.name} decorates it; the decorator attaches to the replacement, which may lack members it expects`);
      }
    }
  }

  registry() {
    for (const [n, ms] of this.index((m) => Object.keys(m.js.registry))) {
      for (const [a, b] of pairs(ms)) {
        this.add(a, b, "Medium", "registry-collision", `both register ui-next component ${code(n)} through ComponentRegistry; the higher overridePriority (ties: last loaded) wins unless one mod re-wraps the other`);
      }
    }
  }

  protos() {
    for (const [k, ms] of this.index((m) => Object.keys(m.js.proto))) {
      for (const [a, b] of pairs(ms)) {
        this.add(a, b, "Medium", "proto-patch", `both patch ${code(`${k}()`)}; they coexist only if each wraps the previous function rather than replacing it`);
      }
    }
  }

  storage() {
    for (const [k, ms] of this.index((m) => m.js.lsKeys)) {
      if (SHARED_LS_KEYS.has(k)) continue;
      for (const [a, b] of pairs(ms)) this.add(a, b, "Medium", "localstorage-key", `both use localStorage key ${code(k)}`);
    }
    // re-exporting an engine or vanilla global (GameInfo, Players, ...) under its own name is harmless
    const own = (g) => g.length > 3 && !this.vanilla.hasIdent(g);
    const globals = this.index((m) => Object.keys(m.js.globals).filter(own));
    for (const [g, ms] of globals) {
      if (ms.length > 25) continue;
      for (const [a, b] of pairs(ms)) {
        // two mods that each merge into the object (X = X || {}, Object.assign(X || {}, ...)) keep each other's members
        if (a.js.globals[g].coop && b.js.globals[g].coop) continue;
        this.add(a, b, "Medium", "shared-global", `both assign global ${code(`globalThis.${g}`)}${clobberNote(a, b, g)}`);
      }
    }
  }

  db() {
    if (!this.schema) return;
    const { inserts, updates, deletes } = collectDb(this.mods, this.schema);
    /** @type {Map<string, { a: Mod, b: Mod, kind: DbKind, ex: Set<string> }>} */
    const agg = new Map();
    /** @param {Mod} a @param {Mod} b @param {DbKind} kind @param {string} ex */
    const note = (a, b, kind, ex) => {
      if (a.root > b.root) [a, b] = [b, a];
      const key = `${a.root}\u0001${b.root}\u0001${kind.text}`;
      if (!agg.has(key)) agg.set(key, { a, b, kind, ex: new Set() });
      /** @type {{ ex: Set<string> }} */ (agg.get(key)).ex.add(ex);
    };
    insertCollisions(inserts, note);
    updateCollisions(updates, note);
    deleteUpdateCollisions(deletes, updates, note);
    for (const { a, b, kind, ex } of agg.values()) {
      this.add(a, b, kind.severity, kind.rule, `database: ${kind.text}: ${listMore([...ex].sort(), 4)}`);
    }
  }

  loc() {
    /** @type {Map<string, { m: Mod, text: string }[]>} */
    const idx = new Map();
    for (const m of this.mods) {
      for (const e of m.loc.values()) if (e.lang === "en_us") push(idx, e.tag, { m, text: e.text });
    }
    /** @type {Map<string, { a: Mod, b: Mod, tags: Set<string> }>} */
    const agg = new Map();
    for (const [tag, list] of idx) if (list.length <= 40) differingText(tag, list, agg);
    for (const { a, b, tags } of agg.values()) {
      const t = [...tags].sort();
      this.add(a, b, "Low", "loc-tag-collision", `${t.length} English text tag(s) with different text; the last-loaded wins: ${listMore(t, 3)}`);
    }
  }
}

function differingText(tag, list, agg) {
  for (const [x, y] of pairs(list)) {
    if (x.m === y.m || x.text.trim() === y.text.trim()) continue;
    const key = `${x.m.root}\u0001${y.m.root}`;
    if (!agg.has(key)) agg.set(key, { a: x.m, b: y.m, tags: new Set() });
    agg.get(key).tags.add(tag);
  }
}

function clobberNote(a, b, g) {
  const coop = [a, b].filter((m) => m.js.globals[g].coop).map((m) => m.name);
  return coop.length ? `; ${coop[0]} merges into it, the other overwrites it, so load order decides what survives` : "";
}

/** Vanilla files (module/rel, lower case) a mod's ImportFiles / ReplaceUIScript item replaces. */
export function overrideTargets(item, vanilla) {
  const rel = item.replace(/^\/+/, "");
  let cands = vanillaSuffixes(rel, vanilla);
  // text and data files only override when the path names the vanilla module explicitly
  if (!/\.(js|html|css)$/i.test(item)) cands = cands.filter((c) => rel.toLowerCase().endsWith(c.toLowerCase()));
  return [...new Set(cands.map((c) => c.toLowerCase()).filter((t) => vanilla.hasPath(t)))].sort();
}

function collectDb(mods, schema) {
  const maps = {
    /** @type {Map<string, { m: Mod, mode: string, vals: string, label: string }[]>} */
    inserts: new Map(),
    /** @type {Map<string, { m: Mod, v: string | null, table: string, where: Record<string, string>,
     *   col: string }[]>} */
    updates: new Map(),
    /** @type {Map<string, { m: Mod, table: string, db: string, where: Record<string, string> }[]>} */
    deletes: new Map(),
  };
  for (const m of mods) {
    const seen = new Set();
    for (const { db, op } of m.dbOps) {
      if (!TEXT_TABLES.has(op.table.toLowerCase())) collectOp(m, db, op, { schema, seen, maps });
    }
  }
  return maps;
}

const INSERT_OPS = new Set(["row", "replace", "ignore"]);

function collectOp(m, db, op, { schema, seen, maps }) {
  const table = op.table.toLowerCase();
  const where = op.where ?? {};
  if (INSERT_OPS.has(op.op)) collectInsert(m, db, op, { schema, seen, maps });
  else if (op.op === "update" && Object.keys(where).length) {
    const w = stableJson(where);
    for (const [col, v] of Object.entries(op.set ?? {})) push(maps.updates, `${db}\u0001${table}\u0001${w}\u0001${col}`, { m, v, table, where, col });
  } else if (op.op === "delete" && op.where) {
    push(maps.deletes, `${db}\u0001${table}\u0001${stableJson(where)}`, { m, table, db, where });
  }
}

function collectInsert(m, db, op, { schema, seen, maps }) {
  const k = rowKey(schema, db, op);
  if (!k || seen.has(`${k.key}\u0001${op.op}`)) return;
  seen.add(`${k.key}\u0001${op.op}`);
  push(maps.inserts, `${db}\u0001${k.key}`, { m, mode: op.op, vals: stableJson(op.values ?? {}), label: k.label });
}

/** First entry per mod, in order. */
function firstPerMod(list) {
  const out = new Map();
  for (const e of list) if (!out.has(e.m)) out.set(e.m, e);
  return [...out.values()];
}

/** @typedef {{ severity: Severity, rule: string, text: string }} DbKind */
/** @type {Record<string, DbKind>} */
const DB_KINDS = {
  plain: { severity: "High", rule: "db-key-collision", text: "both insert the same primary key (plain insert); the second fails with a UNIQUE constraint error" },
  replace: { severity: "Medium", rule: "db-key-collision", text: "define the same row (Replace/InsertOrIgnore); the result depends on load order" },
  update: { severity: "Medium", rule: "db-update-collision", text: "update the same column to different values; the last-loaded mod wins" },
  deleteUpdate: { severity: "Medium", rule: "db-delete-vs-update", text: "one deletes rows the other updates" },
};

function insertCollisions(inserts, note) {
  for (const list of inserts.values()) {
    for (const [x, y] of pairs(firstPerMod(list))) {
      const plain = x.mode === "row" && y.mode === "row";
      if (!plain && x.vals === y.vals) continue; // identical Replace / InsertOrIgnore rows: the result is the same
      note(x.m, y.m, plain ? DB_KINDS.plain : DB_KINDS.replace, x.label);
    }
  }
}

const whereText = (w) => Object.entries(w).map(([k, v]) => `${k}=${v}`).join(", ");

function updateCollisions(updates, note) {
  for (const list of updates.values()) {
    for (const [x, y] of pairs(firstPerMod(list))) {
      if (x.v !== y.v) note(x.m, y.m, DB_KINDS.update, `${x.table}[${whereText(x.where)}].${x.col}`);
    }
  }
}

function deleteUpdateCollisions(deletes, updates, note) {
  for (const dels of deletes.values()) {
    const { table, db, where } = dels[0];
    if (!Object.keys(where).length) continue;
    const deleters = new Set(dels.map((x) => x.m));
    for (const [ukey, ups] of updates) {
      const [udb, utable] = ukey.split("\u0001");
      if (udb !== db || utable !== table || !Object.entries(where).every(([k, v]) => ups[0].where[k] === v)) continue;
      for (const [d, u] of [...deleters].flatMap((d) => ups.map((x) => [d, x.m]))) {
        if (u !== d) note(d, u, DB_KINDS.deleteUpdate, `${table}[${whereText(where)}]`);
      }
    }
  }
}

/**
 * Conflicts between every pair of the given mods.
 * @param {Mod[]} mods
 * @param {{ vanilla: import("./game.mjs").Vanilla, schema?: import("./game.mjs").Schema | null }} ctx
 * @returns {Conflict[]}
 */
export function findConflicts(mods, { vanilla, schema = null }) {
  const f = new Finder(mods, vanilla, schema);
  f.sameId();
  f.overrides();
  f.components();
  f.registry();
  f.protos();
  f.storage();
  f.db();
  f.loc();
  return f.out;
}
