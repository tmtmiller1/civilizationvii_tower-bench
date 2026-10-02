// The installed game as the static checker sees it: its module tree (file paths, component names, every
// identifier its scripts use, the rows its data files insert) and the compiled database schema.
import fs from "node:fs";
import path from "node:path";
import { dbOpsForFile, rowKey } from "./dbops.mjs";
import { groupAges, itemPath, parseModinfo } from "./modinfo.mjs";
import { push, readText, relPath, sqliteJson, walkFiles } from "./util.mjs";

/**
 * Module name (lower case) -> folder, for the base modules and every DLC. Handles both the macOS app
 * bundle (<install>/Contents/Resources/...) and the Windows layout (<install>/Base/modules, <install>/DLC).
 * @param {string} install
 * @returns {Map<string, string>}
 */
export function moduleRoots(install) {
  const roots = new Map();
  const bases = [path.join(install, "Contents", "Resources"), install];
  const base = bases.find((b) => fs.existsSync(path.join(b, "Base", "modules"))) ?? install;
  for (const dir of [path.join(base, "Base", "modules"), path.join(base, "DLC")]) {
    for (const n of subdirs(dir)) roots.set(n.toLowerCase(), path.join(dir, n));
  }
  return roots;
}

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

function readVersion(install) {
  try {
    const plist = fs.readFileSync(path.join(install, "Contents", "Info.plist"), "utf8");
    return plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? "installed build";
  } catch {
    return "installed build";
  }
}

/**
 * @typedef {{ file: string, ages: Set<string> | null, values: Record<string, string | null> }} BaseRow
 * @typedef {{ file: string, scope: string, ages: Set<string> | null }} BaseText
 */

/** @type {Map<string, Vanilla>} */
const LOADED = new Map();

export class Vanilla {
  /** Memoised per install path: building one walks the whole game tree. */
  static load(install) {
    const key = path.resolve(install);
    let v = LOADED.get(key);
    if (!v) LOADED.set(key, (v = new Vanilla(install)));
    return v;
  }

  /** @param {string} install */
  constructor(install) {
    this.install = install;
    this.roots = moduleRoots(install);
    /** @type {Set<string>} "module/rel/path", lower case */
    this.files = new Set();
    /** @type {Map<string, Set<string>>} "rel/path" (lower) -> modules that ship it */
    this.rel = new Map();
    const blob = [];
    for (const [mod, root] of this.roots) {
      for (const full of walkFiles(root, { all: true })) {
        const rel = relPath(root, full).toLowerCase();
        this.files.add(`${mod}/${rel}`);
        if (!this.rel.has(rel)) this.rel.set(rel, new Set());
        /** @type {Set<string>} */ (this.rel.get(rel)).add(mod);
        if (/\.(js|html)$/.test(full)) blob.push(readText(full));
      }
    }
    this.blob = blob.join("\n");
    this.components = findComponents(this.blob);
    this.version = readVersion(install);
    /** @type {Set<string> | null} */
    this.idents = null;
    /** @type {Map<string, any>} */
    this.cache = new Map();
    /** @type {WeakMap<Schema, Map<string, any>>} */
    this.bySchema = new WeakMap();
  }

  hasPath(p) { return this.files.has(p.toLowerCase()); }

  mentions(name) { return this.blob.includes(name); }

  /** True when the game's own scripts use this identifier (GameInfo, Players, ...). */
  hasIdent(name) {
    this.idents ??= new Set(this.blob.match(/[A-Za-z_$][\w$]*/g) ?? []);
    return this.idents.has(name);
  }

  /** @template T @param {string} key @param {() => T} build @returns {T} */
  memo(key, build) {
    if (!this.cache.has(key)) this.cache.set(key, build());
    return this.cache.get(key);
  }

  /** @template T @param {Schema} schema @param {string} key @param {() => T} build @returns {T} */
  memoFor(schema, key, build) {
    if (!this.bySchema.has(schema)) this.bySchema.set(schema, new Map());
    const m = /** @type {Map<string, any>} */ (this.bySchema.get(schema));
    if (!m.has(key)) m.set(key, build());
    return m.get(key);
  }

  /** The base game's modinfos, parsed once. @returns {import("./modinfo.mjs").Modinfo[]} */
  modinfos() {
    return this.memo("modinfos", () => [...this.roots.values()].flatMap((root) => walkFiles(root, { all: true })
      .filter((f) => f.endsWith(".modinfo"))
      .flatMap((f) => { try { return [parseModinfo(f)]; } catch { return []; } })));
  }

  /**
   * Absolute data-file path -> the ages its game-scope groups load it in (null = every age).
   * @returns {Map<string, Set<string> | null>}
   */
  fileAges() {
    return this.memo("fileAges", () => {
      /** @type {Map<string, Set<string> | null>} */
      const out = new Map();
      for (const mi of this.modinfos()) {
        for (const g of mi.groups.filter((x) => x.scope === "game")) {
          const ages = groupAges(g);
          const items = g.actions.find((a) => a.type === "UpdateDatabase")?.items ?? [];
          for (const item of items) addAges(out, path.normalize(itemPath(mi, item)), ages);
        }
      }
      return out;
    });
  }

  /**
   * Row key -> every base-game insert of that key, with the ages its file loads in.
   * @param {Schema} schema
   * @returns {Map<string, BaseRow[]>}
   */
  rowKeys(schema) {
    return this.memoFor(schema, "rowKeys", () => {
      const ages = this.fileAges();
      /** @type {Map<string, BaseRow[]>} */
      const keys = new Map();
      for (const [mod, root] of this.roots) {
        for (const full of dataFiles(mod, root)) {
          const file = `${mod}/${relPath(root, full)}`;
          const fileAges = ages.get(path.normalize(full)) ?? null;
          for (const op of safeOps(full).filter((o) => INSERT_OPS.has(o.op))) {
            const k = rowKey(schema, "gameplay", op) ?? rowKey(schema, "frontend", op);
            if (k) push(keys, k.key, { file, ages: fileAges, values: op.values ?? {} });
          }
        }
      }
      return keys;
    });
  }

  /**
   * (column value, lower case) sets per "table\u0001column" for every row the base game's data files insert.
   * @param {Schema} schema
   */
  refValues(schema) {
    return this.memoFor(schema, "refValues", () => {
      /** @type {Map<string, Set<string>>} */
      const out = new Map();
      for (const [key, rows] of this.rowKeys(schema)) {
        const table = key.split("\u0001")[0];
        for (const [c, v] of rows.flatMap((r) => Object.entries(r.values))) {
          const k = `${table}\u0001${c}`;
          if (!out.has(k)) out.set(k, new Set());
          /** @type {Set<string>} */ (out.get(k)).add(String(v).toLowerCase());
        }
      }
      return out;
    });
  }

  /**
   * English text tag -> the base files that insert it, with the scope (shell / game) and ages they load in.
   * @returns {Map<string, BaseText[]>}
   */
  textTags() {
    return this.memo("textTags", () => {
      /** @type {Map<string, BaseText[]>} */
      const out = new Map();
      for (const [file, where] of this.textLoads()) {
        const label = this.label(file);
        for (const tag of new Set(englishTags(safeOps(file)))) {
          for (const w of where) push(out, tag, { file: label, ...w });
        }
      }
      return out;
    });
  }

  /** English text file -> the scopes and ages it loads in. */
  textLoads() {
    /** @type {Map<string, { scope: string, ages: Set<string> | null }[]>} */
    const loads = new Map();
    for (const mi of this.modinfos()) {
      for (const g of mi.groups) {
        const act = g.actions.find((a) => a.type === "UpdateText");
        act?.items.forEach((item, n) => {
          const locale = act.locales[n];
          if (locale && !/^en/i.test(locale)) return;
          push(loads, path.normalize(itemPath(mi, item)), { scope: g.scope, ages: groupAges(g) });
        });
      }
    }
    return loads;
  }

  label(full) {
    for (const [mod, root] of this.roots) if (full.startsWith(root + path.sep)) return `${mod}/${relPath(root, full)}`;
    return full;
  }
}

const INSERT_OPS = new Set(["row", "replace", "ignore"]);

function addAges(out, p, ages) {
  if (out.has(p) && out.get(p) === null) return;
  out.set(p, ages === null ? null : new Set([...ages, ...(out.get(p) ?? [])]));
}

// Data files outside text and UI folders (those hold no gameplay rows).
function dataFiles(mod, root) {
  return walkFiles(root, { all: true })
    .filter((f) => /\.(xml|sql)$/i.test(f) && !/\/(l10n|text|ui)/.test(`/${mod}/${relPath(root, path.dirname(f))}`));
}

function safeOps(file) {
  try {
    return dbOpsForFile(file).ops;
  } catch {
    return [];
  }
}

/** Tags an op list inserts as English text (EnglishText rows, or LocalizedText rows in en_US). */
export function englishTags(ops) {
  return ops.filter((o) => (o.op === "row" || o.op === "replace" || o.op === "ignore") && o.values?.tag)
    .filter((o) => o.table.toLowerCase() === "englishtext"
      || (o.table.toLowerCase() === "localizedtext" && /^en_us$/i.test(o.values?.language ?? "en_US")))
    .map((o) => String(o.values?.tag));
}

function findComponents(blob) {
  const names = new Set([...blob.matchAll(/Controls\.define\(\s*['"]([^'"]+)/g)].map((m) => m[1]));
  const consts = new Map([...blob.matchAll(/\b(\w+TagName)\s*=\s*['"]([^'"]+)['"]/g)].map((m) => [m[1], m[2]]));
  for (const m of blob.matchAll(/Controls\.define\(\s*(\w+)/g)) {
    const name = consts.get(m[1]);
    if (name) names.add(name);
  }
  for (const m of blob.matchAll(/customElements\.define\(\s*['"]([^'"]+)/g)) names.add(m[1]);
  return names;
}

/**
 * @typedef {{ name: string, cols: string[], pk: string[] }} TableInfo
 * @typedef {{ col: string, parent: string, pcol: string }} ForeignKey
 */

const DBS = {
  gameplay: "gameplay-copy.sqlite", frontend: "frontend-copy.sqlite", localization: "localization-copy.sqlite",
  icons: "images-copy.sqlite", colors: "colors-copy.sqlite",
};

const COLS_SQL = `SELECT m.name AS t, p.name AS c, p.type AS type, p."notnull" AS nn, p.dflt_value AS dv, p.pk AS pk
  FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type IN ('table','view') ORDER BY m.name, p.cid`;
const FK_SQL = `SELECT m.name AS t, f."from" AS c, f."table" AS p, f."to" AS pc, f.on_delete AS od
  FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type = 'table'`;
const UNIQ_SQL = `SELECT m.name AS t, il.seq AS seq, ii.seqno AS n, ii.name AS c
  FROM sqlite_master m JOIN pragma_index_list(m.name) il JOIN pragma_index_info(il.name) ii
  WHERE m.type = 'table' AND il."unique" = 1 ORDER BY m.name, il.seq, ii.seqno`;

export class Schema {
  static DBS = DBS;

  /**
   * Reads <userDir>/Debug/*-copy.sqlite. At boot the game rewrites the gameplay copy with an empty Types
   * table; checking against that would flag base content as missing, so it reports unavailable instead.
   * @param {string} userDir
   * @returns {{ schema: Schema | null, full: boolean, reason?: string }}
   */
  static load(userDir) {
    return Schema.fromDir(path.join(userDir, "Debug"));
  }

  /** @param {string} dir a folder holding the *-copy.sqlite files */
  static fromDir(dir) {
    const gameplay = path.join(dir, DBS.gameplay);
    if (!fs.existsSync(gameplay)) {
      return { schema: null, full: false, reason: "schema unavailable: no Debug database yet; start or load a game once" };
    }
    let types = 0;
    try { types = sqliteJson(gameplay, "SELECT count(*) AS n FROM Types")[0]?.n ?? 0; } catch { types = 0; }
    if (types <= 1000) return { schema: null, full: false, reason: "schema unavailable: start or load a game once" };
    return { schema: new Schema(dir), full: true };
  }

  /** @param {string} dir */
  constructor(dir) {
    this.dir = dir;
    /** @type {Record<string, Map<string, TableInfo>>} */
    this.tables = {};
    /** @type {Record<string, Map<string, Set<string>>>} NOT NULL columns with no default */
    this.required = {};
    /** @type {Record<string, Map<string, ForeignKey[]>>} every foreign key */
    this.refs = {};
    /** @type {Record<string, Map<string, ForeignKey[]>>} ON DELETE CASCADE keys */
    this.cascades = {};
    /** @type {Map<string, Set<string>>} */
    this.valueCache = new Map();
    for (const [db, file] of Object.entries(DBS)) this.readDb(db, path.join(dir, file));
  }

  readDb(db, file) {
    this.tables[db] = new Map();
    this.required[db] = new Map();
    this.refs[db] = new Map();
    this.cascades[db] = new Map();
    if (!fs.existsSync(file)) return;
    this.readColumns(db, sqliteJson(file, COLS_SQL));
    for (const r of sqliteJson(file, FK_SQL)) {
      if (!r.pc) continue;
      const fk = { col: r.c.toLowerCase(), parent: r.p.toLowerCase(), pcol: r.pc.toLowerCase() };
      push(this.refs[db], r.t.toLowerCase(), fk);
      if (String(r.od).toUpperCase() === "CASCADE") push(this.cascades[db], r.t.toLowerCase(), fk);
    }
    this.readUnique(db, sqliteJson(file, UNIQ_SQL));
  }

  readColumns(db, rows) {
    /** @type {Map<string, any[]>} */
    const byTable = new Map();
    for (const r of rows) push(byTable, r.t, r);
    for (const [name, info] of byTable) {
      const pk = info.filter((r) => r.pk).sort((a, b) => a.pk - b.pk).map((r) => r.c.toLowerCase());
      this.tables[db].set(name.toLowerCase(), { name, cols: info.map((r) => r.c.toLowerCase()), pk });
      // an INTEGER primary key fills itself
      const req = info.filter((r) => r.nn && r.dv == null && !(r.pk && String(r.type ?? "").toUpperCase() === "INTEGER"));
      this.required[db].set(name.toLowerCase(), new Set(req.map((r) => r.c.toLowerCase())));
    }
  }

  // a table without a primary key falls back to its first UNIQUE index
  readUnique(db, rows) {
    /** @type {Map<string, { seq: number, cols: string[] }>} */
    const first = new Map();
    for (const r of rows) {
      const cur = first.get(r.t);
      if (!cur) first.set(r.t, { seq: r.seq, cols: [r.c.toLowerCase()] });
      else if (cur.seq === r.seq) cur.cols.push(r.c.toLowerCase());
    }
    for (const [name, u] of first) {
      const t = this.tables[db].get(name.toLowerCase());
      if (t && !t.pk.length) t.pk = u.cols;
    }
  }

  /** @returns {TableInfo | undefined} */
  find(db, table) { return this.tables[db]?.get(String(table).toLowerCase()); }

  /** Databases that have this table. */
  anyDb(table) { return Object.keys(this.tables).filter((db) => this.tables[db].has(String(table).toLowerCase())); }

  /**
   * Values (lower case) of one column in the compiled database, engine-made rows included.
   * @returns {Set<string>}
   */
  values(db, table, col) {
    const key = `${db}\u0001${table}\u0001${col}`;
    let vals = this.valueCache.get(key);
    if (vals) return vals;
    vals = new Set();
    const info = this.find(db, table);
    if (info && info.cols.includes(col)) {
      const q = `SELECT "${col.replaceAll("\"", "\"\"")}" AS v FROM "${info.name.replaceAll("\"", "\"\"")}"`;
      try {
        for (const r of sqliteJson(path.join(this.dir, DBS[db]), q)) vals.add(String(r.v).toLowerCase());
      } catch { /* unreadable */ }
    }
    this.valueCache.set(key, vals);
    return vals;
  }
}
