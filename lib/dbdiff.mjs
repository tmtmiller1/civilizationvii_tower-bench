// What a mod actually changed in the compiled database: two copies of a Debug database, one from a game
// with the mod off and one with it on, compared row by row. The comparison runs inside one sqlite3 process
// with the second copy attached read-only, so a 25 MB gameplay database is diffed without exporting it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BenchError } from "./bench.mjs";
import { copiesOf, labDeps, refuseIfBusy, setModCopies, stamp, withLabGame } from "./labtools.mjs";

// SQLite caps a function at 127 arguments; wide tables are serialised in chunks and spliced back together.
const ARG_CHUNK = 100;
const MAX_BUFFER = 512 * 1024 * 1024;

const ident = (s) => `"${String(s).replaceAll('"', '""')}"`;
const literal = (s) => `'${String(s).replaceAll("'", "''")}'`;

/**
 * Runs a script against `a` (read-only) with `b` attached as "b", and returns the rows of its last SELECT.
 * @param {string} a @param {string} b @param {string} script
 */
function runAttached(a, b, script) {
  const input = `ATTACH ${literal(b)} AS b;\n${script}\n`;
  const out = execFileSync("sqlite3", ["-readonly", "-json", a], { input, encoding: "utf8", maxBuffer: MAX_BUFFER });
  return out.trim() ? JSON.parse(out) : [];
}

const SCHEMA_SQL = ["main", "b"].map((s) => `SELECT '${s}' AS db, m.name AS t, p.name AS c, p.pk AS pk, p."notnull" AS nn
  FROM ${s}.sqlite_master m JOIN pragma_table_info(m.name, '${s}') p
  WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'`).join("\nUNION ALL\n") + "\nORDER BY 1, 2, 4;";

/**
 * @typedef {{ cols: string[], pk: string[], nullableKey?: boolean }} TableShape
 * @param {any[]} rows
 * @returns {{ main: Map<string, TableShape>, b: Map<string, TableShape> }}
 */
function shapes(rows) {
  const out = { main: new Map(), b: new Map() };
  for (const r of rows) {
    const m = out[r.db];
    if (!m.has(r.t)) m.set(r.t, { cols: [], pk: [] });
    const s = m.get(r.t);
    s.cols.push(r.c);
    if (r.pk > 0) s.pk[r.pk - 1] = r.c;
    if (r.pk > 0 && !r.nn) s.nullableKey = true;
  }
  return out;
}

/**
 * How one table present in both copies is compared: by primary key when both declare the same one,
 * otherwise as whole rows over the columns they share.
 * @typedef {{ table: string, cols: string[], key: string[] | null, onlyA: string[], onlyB: string[],
 *   nullableKey: boolean }} Plan
 * @returns {Plan}
 */
function planTable(table, sa, sb) {
  const inB = new Set(sb.cols);
  const cols = sa.cols.filter((c) => inB.has(c));
  const samePk = sa.pk.length > 0 && sa.pk.join("\u0001") === sb.pk.join("\u0001") && sa.pk.every((c) => inB.has(c));
  return {
    table, cols, key: samePk ? sa.pk : null, nullableKey: !!(sa.nullableKey || sb.nullableKey),
    onlyA: sa.cols.filter((c) => !inB.has(c)), onlyB: sb.cols.filter((c) => !sa.cols.includes(c)),
  };
}

// SQLite lets NULLs into a non-INTEGER primary key and does not count them as duplicates, while the diff matches
// keys with IS (NULL matches NULL). A key with such repeats in either copy would pair rows arbitrarily and report
// changes between identical files, so those tables are compared as whole rows instead.
function dropAmbiguousKeys(a, b, plans) {
  const keyed = [...plans.values()].filter((p) => p.key && p.nullableKey);
  if (!keyed.length) return;
  const dup = (db, p) => `EXISTS (SELECT 1 FROM ${db}.${ident(p.table)} GROUP BY ${p.key?.map(ident).join(", ")}`
    + " HAVING count(*) > 1)";
  const sql = keyed.map((p) => `SELECT ${literal(p.table)} AS t WHERE ${dup("main", p)} OR ${dup("b", p)}`)
    .join("\nUNION ALL\n");
  for (const r of runAttached(a, b, `${sql};`)) {
    const p = plans.get(r.t);
    if (p) p.key = null;
  }
}

// A value json_array can hold: blobs become x'..' hex text.
const jsonable = (alias, c) => `CASE WHEN typeof(${alias}.${ident(c)}) = 'blob' THEN 'x''' || hex(${alias}.${ident(c)}) || ''''`
  + ` ELSE ${alias}.${ident(c)} END`;

/** A JSON array of `exprs`, spliced from chunks so no call passes SQLite's argument limit. */
function jsonArray(exprs) {
  const parts = [];
  for (let i = 0; i < exprs.length; i += ARG_CHUNK) parts.push(`json_array(${exprs.slice(i, i + ARG_CHUNK).join(", ")})`);
  if (parts.length === 1) return parts[0];
  const inner = parts.map((p, i) => {
    if (i === 0) return `substr(${p}, 1, length(${p}) - 1)`;
    if (i === parts.length - 1) return `substr(${p}, 2)`;
    return `substr(${p}, 2, length(${p}) - 2)`;
  });
  return inner.join(" || ',' || ");
}

const rowJson = (alias, cols) => jsonArray(cols.map((c) => jsonable(alias, c)));
const colList = (alias, cols) => cols.map((c) => `${alias}.${ident(c)}`).join(", ");
const keyMatch = (key) => key.map((c) => `x.${ident(c)} IS y.${ident(c)}`).join(" AND ");
const differs = (cols) => cols.map((c) => `x.${ident(c)} IS NOT y.${ident(c)}`).join(" OR ") || "0";
const orderBy = (alias, key) => (key ? ` ORDER BY ${colList(alias, key)}` : "");

/** The SQL for rows only in `from` (alias x) and not in `other` (alias y), as a SELECT of `what`. */
function onlyIn(p, from, other, what) {
  const t = ident(p.table);
  if (p.key) {
    return `SELECT ${what} FROM ${from}.${t} x WHERE NOT EXISTS (SELECT 1 FROM ${other}.${t} y WHERE ${keyMatch(p.key)})`;
  }
  const list = p.cols.map(ident).join(", ");
  return `SELECT ${what} FROM (SELECT ${list} FROM ${from}.${t} EXCEPT SELECT ${list} FROM ${other}.${t}) x`;
}

const changedJoin = (p) => `FROM main.${ident(p.table)} x JOIN b.${ident(p.table)} y ON ${keyMatch(p.key ?? [])}`
  + ` WHERE ${differs(p.cols.filter((c) => !p.key?.includes(c)))}`;

function countSql(p) {
  const t = ident(p.table);
  const changed = p.key ? `(SELECT count(*) ${changedJoin(p)})` : "0";
  return `INSERT INTO temp.counts SELECT ${literal(p.table)}, (SELECT count(*) FROM main.${t}), (SELECT count(*) FROM b.${t}),`
    + ` (${onlyIn(p, "b", "main", "count(*)")}), (${onlyIn(p, "main", "b", "count(*)")}), ${changed};`;
}

function sampleSql(p, limit) {
  const name = literal(p.table);
  const lines = [
    `INSERT INTO temp.samples ${onlyIn(p, "b", "main", `${name}, 'added', ${rowJson("x", p.cols)}`)}${orderBy("x", p.key)} LIMIT ${limit};`,
    `INSERT INTO temp.samples ${onlyIn(p, "main", "b", `${name}, 'removed', ${rowJson("x", p.cols)}`)}${orderBy("x", p.key)} LIMIT ${limit};`,
  ];
  if (!p.key) return lines;
  const pair = `json_array(json(${rowJson("x", p.cols)}), json(${rowJson("y", p.cols)}))`;
  lines.push(`INSERT INTO temp.samples SELECT ${name}, 'changed', ${pair} ${changedJoin(p)}${orderBy("x", p.key)} LIMIT ${limit};`);
  const sums = jsonArray(p.cols.map((c) => `sum(x.${ident(c)} IS NOT y.${ident(c)})`));
  lines.push(`INSERT INTO temp.samples SELECT ${name}, 'columns', ${sums} ${changedJoin(p)};`);
  return lines;
}

const asObject = (cols, values) => Object.fromEntries(cols.map((c, i) => [c, values[i]]));

function changedRow(p, [before, after]) {
  const a = asObject(p.cols, before);
  const b = asObject(p.cols, after);
  const changes = Object.fromEntries(p.cols.filter((c) => a[c] !== b[c]).map((c) => [c, { from: a[c], to: b[c] }]));
  return { key: Object.fromEntries((p.key ?? []).map((c) => [c, a[c]])), changes };
}

/**
 * @typedef {{ table: string, key: string[] | null, rowsA: number, rowsB: number, added: number, removed: number,
 *   changed: number, columnsOnlyInA: string[], columnsOnlyInB: string[], columnChanges: Record<string, number>,
 *   samples: { added: object[], removed: object[], changed: { key: object, changes: object }[] } }} TableDiff
 */

function attachSamples(diffs, plans, rows) {
  for (const r of rows) {
    const d = diffs.get(r.t);
    const p = plans.get(r.t);
    if (!d || !p) continue;
    const v = JSON.parse(r.v);
    if (r.kind === "columns") {
      d.columnChanges = Object.fromEntries(p.cols.map((c, i) => [c, v[i]]).filter(([, n]) => n > 0));
    } else if (r.kind === "changed") {
      d.samples.changed.push(changedRow(p, v));
    } else {
      d.samples[r.kind].push(asObject(p.cols, v));
    }
  }
}

function tableDiff(p, c) {
  return {
    table: p.table, key: p.key, rowsA: c.ra, rowsB: c.rb, added: c.added, removed: c.removed, changed: c.changed,
    columnsOnlyInA: p.onlyA, columnsOnlyInB: p.onlyB, columnChanges: {},
    samples: { added: [], removed: [], changed: [] },
  };
}

const rowCounts = (a, b, names, schema) => (names.length ? runAttached(a, b, names
  .map((t) => `SELECT ${literal(t)} AS t, (SELECT count(*) FROM ${schema}.${ident(t)}) AS n`).join(" UNION ALL ")) : [])
  .map((r) => ({ table: r.t, rows: r.n }));

function selectTables(names, tables) {
  if (!tables) return names;
  const want = new Set(tables.map((t) => t.toLowerCase()));
  return names.filter((t) => want.has(t.toLowerCase()));
}

function counted(a, b, plans) {
  const script = ["CREATE TEMP TABLE counts(t TEXT, ra INT, rb INT, added INT, removed INT, changed INT);",
    ...plans.map(countSql), "SELECT * FROM temp.counts;"].join("\n");
  return plans.length ? runAttached(a, b, script) : [];
}

const differsAtAll = (c, p) => c.added || c.removed || c.changed || p.onlyA.length || p.onlyB.length;

/** @param {string} a @param {string} b @param {Map<string, Plan>} plans @returns {Map<string, TableDiff>} */
function changedTables(a, b, plans) {
  const diffs = new Map();
  for (const c of counted(a, b, [...plans.values()])) {
    const p = /** @type {Plan} */ (plans.get(c.t));
    if (differsAtAll(c, p)) diffs.set(c.t, tableDiff(p, c));
  }
  return diffs;
}

function sampleChanged(a, b, { plans, diffs, limit }) {
  const changedPlans = [...diffs.keys()].map((t) => /** @type {Plan} */ (plans.get(t))).filter((p) => p.cols.length);
  if (limit <= 0 || !changedPlans.length) return;
  const script = ["CREATE TEMP TABLE samples(t TEXT, kind TEXT, v TEXT);",
    ...changedPlans.flatMap((p) => sampleSql(p, limit)), "SELECT * FROM temp.samples;"].join("\n");
  attachSamples(diffs, plans, runAttached(a, b, script));
}

/**
 * Compares two SQLite files table by table: rows added, removed and changed (by primary key, or as whole rows
 * where a table has none), with the columns that changed and the first `limit` rows of each kind.
 * @param {string} aPath the "before" copy @param {string} bPath the "after" copy
 * @param {{ limit?: number, tables?: string[] }} [opts]
 */
export function diffDatabases(aPath, bPath, { limit = 5, tables } = {}) {
  for (const f of [aPath, bPath]) if (!fs.existsSync(f)) throw new Error(`no such database: ${f}`);
  const t0 = Date.now();
  const s = shapes(runAttached(aPath, bPath, SCHEMA_SQL));
  const names = selectTables([...s.main.keys()].filter((t) => s.b.has(t)), tables);
  const plans = new Map(names.map((t) => [t, planTable(t, s.main.get(t), s.b.get(t))]));
  dropAmbiguousKeys(aPath, bPath, plans);
  const diffs = changedTables(aPath, bPath, plans);
  sampleChanged(aPath, bPath, { plans, diffs, limit });
  const only = (x, y) => selectTables([...s[x].keys()].filter((t) => !s[y].has(t)), tables);
  const list = [...diffs.values()].sort((x, y) => x.table.localeCompare(y.table));
  const sum = (k) => list.reduce((n, d) => n + d[k], 0);
  return {
    a: aPath, b: bPath, ms: Date.now() - t0, compared: plans.size, identical: plans.size - list.length,
    tablesOnlyInA: rowCounts(aPath, bPath, only("main", "b"), "main"),
    tablesOnlyInB: rowCounts(aPath, bPath, only("b", "main"), "b"),
    tables: list, totals: { added: sum("added"), removed: sum("removed"), changed: sum("changed") },
  };
}

/** @typedef {ReturnType<typeof diffDatabases>} DbDiff */

const fmt = (v) => (v === null ? "NULL" : typeof v === "string" ? JSON.stringify(v) : String(v));
// Key columns first, NULLs left out.
function rowText(r, key = []) {
  const keyFirst = [...key.filter((k) => k in r), ...Object.keys(r).filter((k) => !key.includes(k))];
  return keyFirst.filter((k) => r[k] !== null).map((k) => `${k}=${fmt(r[k])}`).join(" ");
}

function tableLines(d, limit) {
  const how = d.key ? `by ${d.key.join(", ")}` : "whole rows, no primary key";
  const lines = [`  ${d.table} (${d.rowsA} -> ${d.rowsB} rows, ${how}): +${d.added} -${d.removed} ~${d.changed}`];
  if (d.columnsOnlyInA.length) lines.push(`    columns only before: ${d.columnsOnlyInA.join(", ")}`);
  if (d.columnsOnlyInB.length) lines.push(`    columns only after: ${d.columnsOnlyInB.join(", ")}`);
  const cols = Object.entries(d.columnChanges).map(([c, n]) => `${c} (${n})`);
  if (cols.length) lines.push(`    columns changed: ${cols.join(", ")}`);
  for (const r of d.samples.added.slice(0, limit)) lines.push(`    + ${rowText(r, d.key ?? [])}`);
  for (const r of d.samples.removed.slice(0, limit)) lines.push(`    - ${rowText(r, d.key ?? [])}`);
  for (const r of d.samples.changed.slice(0, limit)) {
    const what = Object.entries(r.changes).map(([c, v]) => `${c}: ${fmt(v.from)} -> ${fmt(v.to)}`).join("; ");
    lines.push(`    ~ ${rowText(r.key)}: ${what}`);
  }
  return lines;
}

/**
 * Plain-text report of a diff: totals, tables only on one side, then each changed table with its sample rows.
 * @param {DbDiff} d @param {{ limit?: number, label?: string }} [opts]
 */
export function describeDbDiff(d, { limit = 5, label = "" } = {}) {
  const head = `${label ? `${label}: ` : ""}${d.tables.length} of ${d.compared} shared table(s) differ: `
    + `${d.totals.added} row(s) added, ${d.totals.removed} removed, ${d.totals.changed} changed (${d.ms} ms)`;
  const lines = [head];
  for (const t of d.tablesOnlyInB) lines.push(`  new table ${t.table} (${t.rows} rows)`);
  for (const t of d.tablesOnlyInA) lines.push(`  table gone: ${t.table} (had ${t.rows} rows)`);
  for (const t of d.tables) lines.push(...tableLines(t, limit));
  return lines.join("\n");
}

// ---- Two lab games, mod off then on, and the diff of their Debug databases ----

const DEBUG_DBS = ["gameplay", "localization", "frontend"];
const FULL_TYPES = 1000; // the boot-time gameplay copy has a near-empty Types table; a loaded game has thousands

function typesIn(file) {
  try {
    const out = execFileSync("sqlite3", ["-readonly", file, "SELECT count(*) FROM Types"], { encoding: "utf8" });
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Waits until the gameplay copy was rewritten after `since` and holds a loaded game's content.
 * @param {string} file @param {number} since epoch ms
 * @param {{ minTypes: number, timeoutMs: number, wait: (ms: number) => Promise<void> }} opts
 */
export async function waitForFullDb(file, since, { minTypes, timeoutMs, wait }) {
  const t0 = Date.now();
  for (;;) {
    const fresh = fs.existsSync(file) && fs.statSync(file).mtimeMs >= since;
    if (fresh && typesIn(file) > minTypes) return;
    if (Date.now() - t0 > timeoutMs) {
      const what = `${path.basename(file)} was not rewritten with a loaded game's content`;
      throw new Error(`${what} within ${timeoutMs / 1000} s`);
    }
    await wait(2000);
  }
}

/** Consistent copies of the Debug databases into <dir>/db, through sqlite's own backup. */
export function copyDebugDbs(userDir, dir) {
  const into = path.join(dir, "db");
  fs.mkdirSync(into, { recursive: true });
  const copied = [];
  for (const name of DEBUG_DBS) {
    const src = path.join(userDir, "Debug", `${name}-copy.sqlite`);
    if (!fs.existsSync(src)) continue;
    // A bare target name run from the folder: the shell's dot-commands have no reliable quoting.
    execFileSync("sqlite3", ["-readonly", src, `.backup ${name}.sqlite`], { cwd: into });
    copied.push(name);
  }
  return copied;
}

/**
 * @typedef {{ seed?: number | null, age?: string | null, limit?: number, tables?: string[],
 *   log?: (line: string) => void, minTypes?: number, loadTimeoutMs?: number,
 *   deps?: Partial<import("./labtools.mjs").LabDeps> }} DbdiffOptions
 */

async function sideRun(bench, d, side, ctx) {
  const { copies, opts } = ctx;
  const since = Date.now();
  const others = copies.all.filter((c) => c.path !== copies.chosen.path);
  const setMods = side === "off" ? () => setModCopies(bench.paths, d, copies.all, [])
    : () => setModCopies(bench.paths, d, others, [copies.chosen]);
  const run = await withLabGame(bench.paths, d, { label: `dbdiff-${side}`, seed: opts.seed, age: opts.age, log: opts.log,
    setMods }, async ({ dir, started }) => {
    if (!started) return [];
    await waitForFullDb(path.join(bench.paths.user, "Debug", "gameplay-copy.sqlite"), since,
      { minTypes: opts.minTypes, timeoutMs: opts.loadTimeoutMs, wait: d.wait });
    return copyDebugDbs(bench.paths.user, dir);
  });
  bench.log({ kind: "lab", request: { tool: "dbdiff", side, mod: copies.chosen.id, seed: opts.seed, age: opts.age },
    result: { dir: run.dir, started: run.started, error: run.error, copied: run.result,
      restored: run.restore?.restored ?? [], registry: run.restore?.registry.length ?? 0 } });
  if (!run.started) throw new BenchError(`the ${side} game failed: ${run.error}; everything is restored (${run.dir})`);
  return run;
}

/**
 * What a mod changed in the compiled databases: a seeded lab game with it off, the same game with it on,
 * and the Debug copies of both diffed. The registry and every file the games touch are restored after each.
 * @param {import("./bench.mjs").Bench} bench @param {string} modId @param {DbdiffOptions} [options]
 */
export async function runDbdiff(bench, modId, options = {}) {
  const opts = { seed: 4242, age: null, limit: 5, log: () => {}, minTypes: FULL_TYPES, loadTimeoutMs: 120000,
    ...options };
  const d = labDeps(bench.paths, opts.deps);
  const warnings = refuseIfBusy(bench.paths, d);
  const copies = copiesOf(bench.paths, d, modId);
  if (!copies.chosen) throw new BenchError(`no mod "${modId}" in the registry (official content cannot be diffed)`);
  const off = await sideRun(bench, d, "off", { copies, opts });
  const on = await sideRun(bench, d, "on", { copies, opts });
  const diffs = {};
  for (const name of DEBUG_DBS) {
    const [a, b] = [off, on].map((r) => path.join(r.dir, "db", `${name}.sqlite`));
    if (!fs.existsSync(a) || !fs.existsSync(b)) continue;
    diffs[name] = diffDatabases(a, b, { limit: opts.limit, tables: opts.tables });
  }
  const report = path.join(d.lab.root, `dbdiff-${stamp()}.json`);
  const record = { mod: modId, copy: copies.chosen.path, seed: opts.seed, age: opts.age, runs: [off.dir, on.dir],
    warnings, diffs };
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, JSON.stringify(record, null, 2));
  bench.log({ kind: "dbdiff", request: { mod: modId, seed: opts.seed, age: opts.age },
    result: { report, ...Object.fromEntries(Object.entries(diffs).map(([k, v]) => [k, v.totals])) } });
  return { ...record, report };
}
