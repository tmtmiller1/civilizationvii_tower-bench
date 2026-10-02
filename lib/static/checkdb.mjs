// Database and text checks for one mod against the installed game's schema and base rows. A failed
// statement in a data file rolls the whole database back, so most of these block the game in the age
// (or at the main menu) where the file loads.
import { rowKey } from "./dbops.mjs";
import { code, listMore, push } from "./util.mjs";

/**
 * @typedef {import("./mod.mjs").Mod} Mod
 * @typedef {import("./mod.mjs").ModDbOp} ModDbOp
 * @typedef {import("./dbops.mjs").DbOp} DbOp
 * @typedef {{ rule: string, verdict: "BLOCKS GAME" | "FEATURE DEAD" | "MINOR", age?: string, file?: string,
 *   text: string, evidence: any, static: true }} Finding
 * @typedef {{ where: Record<string, string | null> | null | undefined, replace?: boolean }} Removal
 */

const TYPES_REF = { db: "gameplay", parent: "types", pcol: "type" };
const TEXT_TABLES = new Set(["localizedtext", "englishtext"]);
const INSERTS = new Set(["row", "replace", "ignore"]);

/** @returns {Finding} */
export const finding = (rule, verdict, text, extra = {}) => ({
  rule, verdict, text, evidence: null, ...extra, static: true,
});

/** Where a data file loads: "main menu" for shell files, else its ages. */
export function ageLabel(scope, ages) {
  if (scope === "shell") return "main menu";
  return ages ? [...ages].sort().join(", ") : "every age";
}

/** The first base-game definition of the row that loads in an age the mod's row also loads in. */
export function collidingSource(modAges, entries) {
  return entries.find((e) => e.ages === null || modAges === null || [...e.ages].some((a) => modAges.has(a))) ?? null;
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * An earlier delete removes the base row first (no WHERE, an unevaluable one, or conditions the BASE row
 * matches: a mod deletes the old row by its old values), so the insert re-adds the key instead of colliding.
 * @param {Removal[]} dels
 */
export function deletesCover(dels, baseValues) {
  return dels.some((d) => !d.where || !Object.keys(d.where).length
    || Object.entries(d.where).every(([c, v]) => !(c in baseValues) || same(baseValues[c], v)));
}

/**
 * An earlier delete or Replace of a parent row removed the base row through ON DELETE CASCADE.
 * @param {import("./game.mjs").ForeignKey[]} fks
 * @param {Map<string, Removal[]>} deleted
 */
export function cascadeCover(fks, deleted, baseValues) {
  return fks.some(({ col, parent, pcol }) => baseValues[col] != null
    && (deleted.get(parent) ?? []).some((d) => removesParent(d, pcol, baseValues[col])));
}

/** @param {Removal} d */
function removesParent(d, pcol, v) {
  const w = d.where;
  if (d.replace && !w) return false; // a Replace whose key this reader could not read says nothing
  return !w || !Object.keys(w).length || (pcol in w && same(w[pcol], v));
}

/** Column -> value for an insert, mapping a positional SQL VALUES list by the table's column order. */
export function opValues(op, schema, db) {
  if (op.values && Object.keys(op.values).length) return op.values;
  const info = schema.find(db, op.table);
  if (!op.raw || !info) return {};
  return Object.fromEntries(info.cols.map((c, i) => [c, op.raw[i]]).filter((e) => e[1] !== undefined));
}

/** "table\u0001col\u0001value" for every value the mod and the mods it declares insert. */
function ownRefValues(mod, schema, ctx) {
  const mods = [mod];
  for (const d of mod.modinfos.flatMap((mi) => [...mi.deps, ...mi.refs])) {
    const o = ctx.byId.get(String(d.id ?? "").toLowerCase());
    if (o && !mods.includes(o)) mods.push(o);
  }
  const out = new Set();
  for (const o of mods) {
    for (const { db, op } of o.dbOps) {
      if (!INSERTS.has(op.op)) continue;
      for (const [c, v] of Object.entries(opValues(op, schema, db))) out.add(`${op.table.toLowerCase()}\u0001${c}\u0001${String(v).toLowerCase()}`);
    }
  }
  return out;
}

/** Is `v` a value of parent.pcol in the base game's files, the mod (and its declared mods), or the compiled DB? */
export function refDefined(ctx, { db, parent, pcol }, v, own) {
  const s = String(v).toLowerCase();
  if (ctx.vanilla.refValues(ctx.schema).get(`${parent}\u0001${pcol}`)?.has(s)) return true;
  if (own.has(`${parent}\u0001${pcol}\u0001${s}`)) return true;
  return ctx.schema.values(db, parent, pcol).has(s);
}

/** A Row or Replace that names its columns (not a SELECT, a positional VALUES list or a <GameEffects> entry). */
const isFullInsert = (op) => (op.op === "row" || op.op === "replace") && !op.select && !op.partial && !op.positional;

class DbCheck {
  /** @param {Mod} mod */
  constructor(mod, ctx) {
    this.mod = mod;
    this.ctx = ctx;
    this.schema = ctx.schema;
    /** @type {Map<string, Removal[]>} */
    this.deleted = new Map();
    this.unknownTables = new Map();
    /** @type {Map<string, Set<string>>} */
    this.unknownCols = new Map();
    this.missingRequired = new Map();
    /** @type {Map<string, Set<string>>} */
    this.dangling = new Map();
    /** @type {Map<string, { label: string, src: string, age: string, file: string }>} */
    this.dupes = new Map();
    /** @type {Map<string, { table: string, who: string }>} */
    this.implicitDeps = new Map();
    this.own = null;
  }

  run() {
    for (const e of this.mod.dbOps) if (e.op.op !== "create") this.visit(e);
    return [...this.tableFindings(), ...this.refFindings(), ...this.requiredFindings(), ...this.dupeFindings()];
  }

  /** @param {ModDbOp} e */
  visit(e) {
    const { db, op } = e;
    this.recordRemoval(db, op);
    const info = this.schema.find(db, op.table);
    if (!info) return this.missingTable(e);
    this.checkColumns(e, info);
    if (db === "gameplay" && op.partial && !op.conditional) this.checkEffects(op);
    if (op.op === "row") this.checkBaseRow(e);
  }

  recordRemoval(db, op) {
    const t = op.table.toLowerCase();
    if (op.op === "delete") push(this.deleted, t, { where: op.where });
    else if (op.op === "replace") {
      // REPLACE deletes an existing row first, firing ON DELETE CASCADE on its children
      const pk = this.schema.find(db, op.table)?.pk ?? [];
      const where = Object.fromEntries(Object.entries(op.values ?? {}).filter(([c]) => pk.includes(c)));
      push(this.deleted, t, { where: Object.keys(where).length ? where : null, replace: true });
    }
  }

  /** @param {ModDbOp} e */
  missingTable({ db, op, file, scope }) {
    const t = op.table.toLowerCase();
    if (this.mod.createdTables.has(t)) return;
    const creators = (this.ctx.tableCreators.get(t) ?? []).filter((m) => m !== this.mod);
    if (creators.length) {
      // a declared dependency or a ModInUse-gated group is fine
      const declared = new Set(this.mod.modinfos.flatMap((mi) => [...mi.deps, ...mi.refs])
        .map((d) => String(d.id).toLowerCase()));
      if (!op.conditional && !creators.some((c) => c.ids.some((i) => declared.has(i.toLowerCase())))) {
        this.implicitDeps.set(op.table, { table: op.table, who: creators.map((c) => c.name).sort().join(", ").slice(0, 120) });
      }
      return;
    }
    const key = `${op.table}\u0001${db}`;
    const cur = this.unknownTables.get(key) ?? { table: op.table, db, n: 0, file, age: ageLabel(scope, op.ages) };
    cur.n++;
    this.unknownTables.set(key, cur);
  }

  /** @param {ModDbOp} e @param {import("./game.mjs").TableInfo} info */
  checkColumns(e, info) {
    const { op } = e;
    // EnglishText is a view the text loader maps; its columns differ
    if (info.name.toLowerCase() !== "englishtext") {
      const cols = new Set([...info.cols, "rowid", "oid", "_rowid_"]);
      const used = [op.values, op.set, op.where].flatMap((o) => Object.keys(o ?? {}));
      for (const c of used.filter((x) => !cols.has(x))) {
        if (!this.unknownCols.has(info.name)) this.unknownCols.set(info.name, new Set());
        /** @type {Set<string>} */ (this.unknownCols.get(info.name)).add(c);
      }
    }
    if (isFullInsert(op) && !TEXT_TABLES.has(info.name.toLowerCase())) this.checkRequired(e, info);
  }

  /** @param {ModDbOp} e @param {import("./game.mjs").TableInfo} info */
  checkRequired({ db, op, file, scope }, info) {
    const values = op.values ?? {};
    const required = this.schema.required[db]?.get(info.name.toLowerCase()) ?? new Set();
    const miss = [...required].filter((c) => !(c in values)).sort();
    if (!miss.length) return;
    const key = `${info.name}\u0001${db}\u0001${miss.join(",")}`;
    if (!this.missingRequired.has(key)) {
      this.missingRequired.set(key, { table: info.name, db, miss, n: 0, file, age: ageLabel(scope, op.ages) });
    }
    this.missingRequired.get(key).n++;
  }

  // a <GameEffects> <Modifier> expands into DynamicModifiers + Types; its effect and collection must exist
  checkEffects(op) {
    this.own ??= ownRefValues(this.mod, this.schema, this.ctx);
    for (const kind of ["effect", "collection"]) {
      const v = op[kind];
      if (v && !refDefined(this.ctx, TYPES_REF, v, this.own)) {
        const key = `${kind}type`;
        if (!this.dangling.has(key)) this.dangling.set(key, new Set());
        /** @type {Set<string>} */ (this.dangling.get(key)).add(String(v));
      }
    }
  }

  /** @param {ModDbOp} e */
  checkBaseRow({ db, op, file, scope }) {
    const k = rowKey(this.schema, db, op);
    if (!k || this.dupes.has(k.label)) return;
    const hit = collidingSource(op.ages ?? null, this.ctx.baseRows.get(k.key) ?? []);
    if (!hit || this.removedFirst(db, op.table.toLowerCase(), hit.values)) return;
    this.dupes.set(k.label, { label: k.label, src: hit.file, age: ageLabel(scope, op.ages), file });
  }

  /** Did an earlier delete, or a Replace on a parent with ON DELETE CASCADE, remove the base row? */
  removedFirst(db, t, values) {
    return deletesCover(this.deleted.get(t) ?? [], values)
      || cascadeCover(this.schema.cascades[db]?.get(t) ?? [], this.deleted, values);
  }

  *tableFindings() {
    const v = this.ctx.vanilla.version;
    for (const u of [...this.unknownTables.values()].sort((a, b) => a.table.localeCompare(b.table))) {
      const elsewhere = this.schema.anyDb(u.table).filter((d) => d !== u.db);
      const hint = elsewhere.length ? ` (it exists in the ${elsewhere.join(",")} database, so the action group may have the wrong scope)` : "";
      yield finding("unknown-table", "BLOCKS GAME", `writes ${u.n} row op(s) to table ${code(u.table)}, which is not in the ${v} ${u.db} schema${hint} and which no other analysed mod creates; those statements fail and the game rolls the database back (watched on 1.5.0).`,
        { age: u.age, file: u.file, evidence: { table: u.table, db: u.db, ops: u.n } });
    }
    for (const [t, cs] of [...this.unknownCols].sort((a, b) => a[0].localeCompare(b[0]))) {
      yield finding("unknown-column", "BLOCKS GAME", `uses column(s) ${[...cs].sort().map(code).join(", ")} on ${code(t)}, which the ${v} schema does not have; those statements fail.`,
        { evidence: { table: t, columns: [...cs].sort() } });
    }
  }

  *refFindings() {
    for (const [col, vals] of [...this.dangling].sort()) {
      const ex = listMore([...vals].sort(), 3);
      yield finding("removed-effect-type", "BLOCKS GAME", `uses modifier ${col.slice(0, -4)}(s) ${ex} that game ${this.ctx.vanilla.version} does not define (nor does the mod or a mod it declares); the game's reference check on DynamicModifiers rejects the database and a game cannot start (watched on 1.5.0).`,
        { evidence: { column: `DynamicModifiers.${col}`, values: [...vals].sort() } });
    }
  }

  *requiredFindings() {
    for (const r of [...this.missingRequired.values()].sort((a, b) => a.table.localeCompare(b.table))) {
      yield finding("missing-required-column", "BLOCKS GAME", `inserts ${r.n} row(s) into ${code(r.table)} without ${r.miss.map(code).join(", ")}, which the ${this.ctx.vanilla.version} ${r.db} schema requires (NOT NULL, no default); the insert fails and the game rolls the database back (watched on 1.5.0).`,
        { age: r.age, file: r.file, evidence: { table: r.table, db: r.db, columns: r.miss, rows: r.n } });
    }
  }

  *dupeFindings() {
    const d = [...this.dupes.values()];
    if (!d.length) return;
    const ex = listMore(d, 4, (x) => `${code(x.label)} (base game ${code(x.src)})`);
    yield finding("duplicate-base-row", "BLOCKS GAME", `plain-inserts ${d.length} row(s) the base game already defines: ${ex}. Both load in the same age, so the insert fails with a UNIQUE constraint error; the game then rolls the database back and will not start or load a game in that age (watched on 1.5.0).`,
      { age: [...new Set(d.map((x) => x.age))].join(", "), file: d[0].file, evidence: { rows: d.map(({ label, src }) => ({ row: label, base: src })) } });
  }
}

/**
 * @param {Mod} mod
 * @param {any} ctx
 * @returns {Finding[]}
 */
export function databaseFindings(mod, ctx) {
  const check = new DbCheck(mod, ctx);
  const out = check.run();
  for (const { table, who } of [...check.implicitDeps.values()].sort((a, b) => a.table.localeCompare(b.table))) {
    out.push(finding("undeclared-table-dependency", "MINOR", `writes to table ${code(table)}, which only another mod creates (${who}) and which the modinfo does not declare as a dependency; those statements fail unless that mod loads first.`,
      { evidence: { table, creators: who } }));
  }
  return out;
}

/** Do two age sets (null = every age) share an age? */
export const agesMeet = (a, b) => a === null || b === null || [...a].some((x) => b.has(x));

/**
 * Plain inserts of an English text tag the base game already inserts in the same scope and age, and tags
 * the mod inserts twice. Either is a UNIQUE constraint failure on LocalizedText, which rolls the file back.
 * @param {Mod} mod
 * @param {import("./game.mjs").Vanilla} vanilla
 * @returns {Finding[]}
 */
export function textFindings(mod, vanilla) {
  const state = { base: vanilla.textTags(), hits: new Map(), mine: new Map(), deleted: new Set(), listing: 0, last: "" };
  for (const e of mod.dbOps) {
    const key = `${e.file}\u0001${e.scope}\u0001${e.op.ages ? [...e.op.ages].join() : ""}`;
    if (key !== state.last) {
      state.listing++;
      state.last = key;
    }
    const t = e.op.table.toLowerCase();
    if (e.db !== "localization" || !TEXT_TABLES.has(t)) continue;
    if (e.op.op === "delete") textDelete(e, state);
    else if (INSERTS.has(e.op.op) && e.op.values?.tag) textInsert(e, t, state);
  }
  /** @type {{ tag: string, scope: string, file: string, src: string, age: string }[]} */
  const hits = [...state.hits.values()];
  return [...groupBy(hits, (h) => h.scope)].map(([scope, list]) => finding("duplicate-loc-tag", "BLOCKS GAME",
    `inserts ${list.length} text tag(s) that are already defined: ${listMore(list, 3, (h) => `${code(h.tag)} (${h.src})`)}. A plain insert of an existing tag fails with "UNIQUE constraint failed: LocalizedText" and the text file is rolled back${scope === "shell" ? ", which fails the main-menu configuration" : ""} (watched on 1.5.0).`,
    { age: [...new Set(list.map((h) => h.age))].join(", "), file: list[0].file, evidence: { tags: list.map((h) => ({ tag: h.tag, file: h.file, defined: h.src })) } }));
}

function textDelete(e, state) {
  const tag = e.op.where?.tag;
  state.deleted.add(`${e.scope}\u0001${tag ?? "*"}`);
  for (const k of [...state.mine.keys()]) if (k.startsWith(`${e.scope}\u0001`) && (!tag || k.endsWith(`\u0001${tag}`))) state.mine.delete(k);
}

/** @param {ModDbOp} e */
function textInsert(e, t, state) {
  const v = e.op.values ?? {};
  const lang = t === "englishtext" ? "en_us" : String(v.language ?? "").toLowerCase();
  const tag = String(v.tag);
  const key = `${e.scope}\u0001${lang}\u0001${tag}`;
  const ages = e.op.ages ?? null;
  const entry = { file: e.file, ages, listing: state.listing };
  if (e.op.op === "row" && !state.hits.has(key)) {
    const src = priorSource(state.mine.get(key) ?? [], entry) ?? baseSource(e, lang, tag, state);
    if (src) state.hits.set(key, { tag, scope: e.scope, file: e.file, src, age: ageLabel(e.scope, ages) });
  }
  push(state.mine, key, entry);
}

// the same file listed again in another group is a second listing, not a second insert
function priorSource(prior, entry) {
  const p = prior.find((x) => agesMeet(x.ages, entry.ages) && (x.file !== entry.file || x.listing === entry.listing));
  if (!p) return null;
  return p.file === entry.file ? `twice in ${p.file}` : `also in ${p.file}`;
}

function baseSource(e, lang, tag, state) {
  if (lang !== "en_us" || (e.locale && !/^en/i.test(e.locale))) return null;
  if (state.deleted.has(`${e.scope}\u0001${tag}`) || state.deleted.has(`${e.scope}\u0001*`)) return null;
  const b = (state.base.get(tag) ?? []).find((x) => x.scope === e.scope && agesMeet(x.ages, e.op.ages ?? null));
  return b ? `base game ${b.file}` : null;
}

/** @template T @param {Iterable<T>} items @param {(x: T) => string} keyOf @returns {Map<string, T[]>} */
function groupBy(items, keyOf) {
  /** @type {Map<string, T[]>} */
  const out = new Map();
  for (const x of items) push(out, keyOf(x), x);
  return out;
}
