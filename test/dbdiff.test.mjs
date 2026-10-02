import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { copyDebugDbs, describeDbDiff, diffDatabases, runDbdiff, waitForFullDb } from "../lib/dbdiff.mjs";
import { registryRows } from "../lib/lab.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tb-dbdiff-"));
const sql = (db, s) => execFileSync("sqlite3", [db], { input: s, encoding: "utf8" });

const WIDE = Array.from({ length: 130 }, (_, i) => `c${i}`);

function pair(dir) {
  const a = path.join(dir, "a.sqlite");
  const b = path.join(dir, "b.sqlite");
  const common = `
    CREATE TABLE Units(UnitType TEXT PRIMARY KEY, Cost INT, Name TEXT, Icon BLOB);
    CREATE TABLE Pairs(A TEXT, B TEXT, V INT, PRIMARY KEY (A, B));
    CREATE TABLE Loose(X TEXT, Y INT);
    CREATE TABLE Wide(id INTEGER PRIMARY KEY, ${WIDE.map((c) => `${c} INT`).join(", ")});
    CREATE TABLE Same(k TEXT PRIMARY KEY, v TEXT);
    INSERT INTO Same VALUES ('x', 'y');
    INSERT INTO Units VALUES ('UNIT_A', 10, 'A', x'00ff'), ('UNIT_B', 20, NULL, NULL), ('UNIT_GONE', 5, 'G', NULL);
    INSERT INTO Pairs VALUES ('p', NULL, 1), ('p', 'q', 2);
    INSERT INTO Loose VALUES ('one', 1), ('two', 2);
    INSERT INTO Wide (id, c0, c129) VALUES (1, 0, 0);`;
  sql(a, `${common} CREATE TABLE OnlyA(z INT); INSERT INTO OnlyA VALUES (1); CREATE TABLE Grow(k TEXT PRIMARY KEY);`);
  sql(b, `${common}
    UPDATE Units SET Cost = 12, Name = 'A2' WHERE UnitType = 'UNIT_A';
    UPDATE Units SET Name = 'B' WHERE UnitType = 'UNIT_B';
    DELETE FROM Units WHERE UnitType = 'UNIT_GONE';
    INSERT INTO Units VALUES ('UNIT_NEW', 30, 'N', x'01');
    UPDATE Pairs SET V = 9 WHERE A = 'p' AND B IS NULL;
    INSERT INTO Loose VALUES ('three', 3);
    DELETE FROM Loose WHERE X = 'one';
    UPDATE Wide SET c129 = 7 WHERE id = 1;
    CREATE TABLE OnlyB(z INT); INSERT INTO OnlyB VALUES (1), (2);
    CREATE TABLE Grow(k TEXT PRIMARY KEY, extra INT);`);
  return { a, b };
}

test("diffDatabases counts added, removed and changed rows by primary key, with old and new values", () => {
  const { a, b } = pair(tmp());
  const d = diffDatabases(a, b);
  const units = d.tables.find((t) => t.table === "Units");
  assert.deepEqual([units.added, units.removed, units.changed], [1, 1, 2]);
  assert.deepEqual(units.key, ["UnitType"]);
  assert.deepEqual(units.columnChanges, { Cost: 1, Name: 2 });
  assert.deepEqual(units.samples.added, [{ UnitType: "UNIT_NEW", Cost: 30, Name: "N", Icon: "x'01'" }], "blobs come back as hex");
  assert.deepEqual(units.samples.removed.map((r) => r.UnitType), ["UNIT_GONE"]);
  const ua = units.samples.changed.find((r) => r.key.UnitType === "UNIT_A");
  assert.deepEqual(ua.changes, { Cost: { from: 10, to: 12 }, Name: { from: "A", to: "A2" } });
  const ub = units.samples.changed.find((r) => r.key.UnitType === "UNIT_B");
  assert.deepEqual(ub.changes, { Name: { from: null, to: "B" } }, "NULL to a value is a change");
  assert.equal(d.tables.some((t) => t.table === "Same"), false, "identical tables are left out");
  assert.ok(d.identical >= 1);
});

test("diffDatabases matches composite keys holding NULL, and tables with no key as whole rows", () => {
  const { a, b } = pair(tmp());
  const d = diffDatabases(a, b);
  const pairs = d.tables.find((t) => t.table === "Pairs");
  assert.deepEqual([pairs.added, pairs.removed, pairs.changed], [0, 0, 1], "a NULL key part still matches itself");
  const loose = d.tables.find((t) => t.table === "Loose");
  assert.equal(loose.key, null);
  assert.deepEqual([loose.added, loose.removed, loose.changed], [1, 1, 0]);
  assert.deepEqual(loose.samples.added, [{ X: "three", Y: 3 }]);
});

test("diffDatabases handles tables wider than SQLite's function argument limit", () => {
  const { a, b } = pair(tmp());
  const wide = diffDatabases(a, b).tables.find((t) => t.table === "Wide");
  assert.equal(wide.changed, 1);
  assert.deepEqual(wide.samples.changed[0].changes, { c129: { from: 0, to: 7 } });
});

test("diffDatabases reports tables and columns present on one side only", () => {
  const { a, b } = pair(tmp());
  const d = diffDatabases(a, b);
  assert.deepEqual(d.tablesOnlyInA, [{ table: "OnlyA", rows: 1 }]);
  assert.deepEqual(d.tablesOnlyInB, [{ table: "OnlyB", rows: 2 }]);
  const grow = d.tables.find((t) => t.table === "Grow");
  assert.deepEqual(grow.columnsOnlyInB, ["extra"]);
  assert.deepEqual(d.totals, { added: 2, removed: 2, changed: 4 });
});

test("diffDatabases can be limited to named tables and to fewer sample rows", () => {
  const { a, b } = pair(tmp());
  const d = diffDatabases(a, b, { tables: ["units"], limit: 1 });
  assert.deepEqual(d.tables.map((t) => t.table), ["Units"]);
  assert.equal(d.compared, 1);
  assert.equal(d.tables[0].samples.changed.length, 1);
  assert.deepEqual(d.tablesOnlyInB, []);
  const none = diffDatabases(a, b, { limit: 0 });
  assert.equal(none.tables.find((t) => t.table === "Units").samples.added.length, 0);
});

test("diffDatabases never writes to either file and refuses a missing one", () => {
  const { a, b } = pair(tmp());
  const before = [fs.readFileSync(a), fs.readFileSync(b)];
  diffDatabases(a, b);
  assert.deepEqual([fs.readFileSync(a), fs.readFileSync(b)], before);
  assert.throws(() => diffDatabases(a, path.join(path.dirname(a), "nope.sqlite")), /no such database/);
});

test("describeDbDiff prints totals, one-sided tables, and sample rows key first", () => {
  const { a, b } = pair(tmp());
  const text = describeDbDiff(diffDatabases(a, b), { label: "gameplay" });
  assert.match(text, /^gameplay: \d+ of \d+ shared table\(s\) differ: 2 row\(s\) added, 2 removed, 4 changed/);
  assert.match(text, /new table OnlyB \(2 rows\)/);
  assert.match(text, /table gone: OnlyA/);
  assert.match(text, /\+ UnitType="UNIT_NEW" Cost=30/);
  assert.match(text, /~ UnitType="UNIT_A": Cost: 10 -> 12; Name: "A" -> "A2"/);
  assert.match(text, /columns only after: extra/);
});

// ---- the lab flow, against a fake lab ----

function sandbox() {
  const user = tmp();
  const db = path.join(user, "Mods.sqlite");
  sql(db, "CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT, LastWriteTime INTEGER);"
    + "CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ScannedFileRowId INTEGER, ModId TEXT, Version INTEGER, Disabled BOOLEAN);"
    + "INSERT INTO ScannedFiles VALUES (1, '/m/target/target.modinfo', 0), (2, '/m/other/other.modinfo', 0),"
    + " (3, '/m/shadow/dist/target.modinfo', 0);"
    + "INSERT INTO Mods VALUES (10, 1, 'target', 1, 1), (11, 2, 'other', 1, NULL), (12, 3, 'target', 1, 1);");
  fs.mkdirSync(path.join(user, "Debug"));
  const paths = { user, modsDb: db, logs: path.join(user, "Logs"), userMods: path.join(user, "Mods"),
    evidence: path.join(user, "tb", "evidence"), cdpPort: 1 };
  return { user, paths };
}

// What the engine's registry switch does, without the running-game guard (the real game may be up on a dev box).
function applySet(db, candidates, enabledIds) {
  const on = new Set(enabledIds);
  const q = (s) => `'${s.replaceAll("'", "''")}'`;
  sql(db, candidates.map((c) => `UPDATE Mods SET Disabled = ${on.has(c.id) ? 0 : 1} WHERE ScannedFileRowId = `
    + `(SELECT ScannedFileRowId FROM ScannedFiles WHERE Path = ${q(c.path)});`).join("\n"));
}

function fakeLab(root, onStart) {
  let current = null;
  const calls = [];
  return {
    root, calls,
    get current() { return current; },
    setCurrent(r) { current = r; },
    backup(dir) { fs.mkdirSync(dir, { recursive: true }); calls.push("backup"); return { files: [], registryRows: 0 }; },
    restore() { calls.push("restore"); return { moved: [], restored: ["Mods.sqlite"], registry: [], crashReports: [] }; },
    async startNewGame(o) { calls.push(`start ${o.seed}`); await onStart(o); return { pid: 7, setup: {}, turn: 1 }; },
    async quit() { calls.push("quit"); return { wasRunning: true, pid: 7 }; },
  };
}

// A compiled database whose content depends on which mods the registry has on, as the game's would.
function writeDebugDb(paths, seen) {
  const flags = Object.fromEntries(registryRows(paths.modsDb).map((r) => [r.path, r.disabled]));
  seen.push(flags);
  const file = path.join(paths.user, "Debug", "gameplay-copy.sqlite");
  fs.rmSync(file, { force: true });
  const on = flags["/m/target/target.modinfo"] === 0;
  sql(file, "CREATE TABLE Types(Type TEXT PRIMARY KEY); INSERT INTO Types VALUES ('A'), ('B'), ('C');"
    + "CREATE TABLE Units(UnitType TEXT PRIMARY KEY, Cost INT); INSERT INTO Units VALUES ('UNIT_A', 10);"
    + (on ? "INSERT INTO Units VALUES ('UNIT_MOD', 50); UPDATE Units SET Cost = 11;" : ""));
}

function fakeBench(paths) {
  const logged = [];
  return { paths, logged, log: (e) => logged.push(e), cdp: { close() {} } };
}

const quiet = { preflight: () => ({ problems: [], warnings: [] }), applyModSet: applySet, gamePid: () => 7,
  wait: async () => {} };

test("runDbdiff runs the mod off then on, restoring after each, and diffs the copied databases", async () => {
  const { paths } = sandbox();
  const seen = [];
  const lab = fakeLab(path.join(paths.user, "runs"), () => writeDebugDb(paths, seen));
  const bench = fakeBench(paths);
  const r = await runDbdiff(/** @type {any} */ (bench), "target", { deps: { ...quiet, lab: /** @type {any} */ (lab) },
    seed: 99, minTypes: 2 });

  assert.deepEqual(lab.calls, ["backup", "start 99", "quit", "restore", "backup", "start 99", "quit", "restore"]);
  assert.equal(seen[0]["/m/target/target.modinfo"], 1, "off: the mod is switched off");
  assert.equal(seen[1]["/m/target/target.modinfo"], 0, "on: the chosen copy is switched on");
  assert.equal(seen[1]["/m/shadow/dist/target.modinfo"], 1, "a second copy of the id stays off");
  assert.equal(seen[1]["/m/other/other.modinfo"], null, "mods outside the comparison are left as they were");
  const units = r.diffs.gameplay.tables.find((t) => t.table === "Units");
  assert.deepEqual([units.added, units.changed], [1, 1]);
  assert.ok(fs.existsSync(r.report));
  assert.equal(lab.current, null);
  assert.deepEqual(bench.logged.map((e) => e.kind), ["lab", "lab", "dbdiff"]);
});

test("runDbdiff refuses while busy or for an unknown mod, and restores when a game does not start", async () => {
  const { paths } = sandbox();
  const busy = { ...quiet, preflight: () => ({ problems: ["the game is running"], warnings: [] }) };
  const lab = fakeLab(path.join(paths.user, "runs"), () => {});
  await assert.rejects(runDbdiff(/** @type {any} */ (fakeBench(paths)), "target",
    { deps: { ...busy, lab: /** @type {any} */ (lab) } }), /the game is running/);
  await assert.rejects(runDbdiff(/** @type {any} */ (fakeBench(paths)), "nope",
    { deps: { ...quiet, lab: /** @type {any} */ (lab) } }), /no mod "nope"/);

  const failing = fakeLab(path.join(paths.user, "runs"), () => { throw new Error("menu never appeared"); });
  await assert.rejects(runDbdiff(/** @type {any} */ (fakeBench(paths)), "target",
    { deps: { ...quiet, lab: /** @type {any} */ (failing) } }), /off game failed: the game did not start: menu never appeared/);
  assert.deepEqual(failing.calls.slice(-2), ["quit", "restore"]);
  assert.equal(failing.current, null);
});

test("waitForFullDb rejects a stale or boot-time copy, and copyDebugDbs takes consistent copies", async () => {
  const { user } = sandbox();
  const file = path.join(user, "Debug", "gameplay-copy.sqlite");
  sql(file, "CREATE TABLE Types(Type TEXT); INSERT INTO Types VALUES ('A');");
  const opts = { minTypes: 2, timeoutMs: 0, wait: async () => {} };
  await assert.rejects(waitForFullDb(file, 0, opts), /was not rewritten/, "too few types: the boot-time copy");
  sql(file, "INSERT INTO Types VALUES ('B'), ('C');");
  await assert.rejects(waitForFullDb(file, Date.now() + 60000, opts), /was not rewritten/, "older than the game");
  await waitForFullDb(file, 0, opts);
  sql(path.join(user, "Debug", "localization-copy.sqlite"), "CREATE TABLE LocalizedText(Tag TEXT);");
  const run = path.join(user, "run");
  assert.deepEqual(copyDebugDbs(user, run), ["gameplay", "localization"]);
  assert.equal(sql(path.join(run, "db", "gameplay.sqlite"), "SELECT count(*) FROM Types;").trim(), "3");
});

test("a primary key with NULL parts that repeat is compared as whole rows, so identical files show no change", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-dbdiff-null-"));
  const f = path.join(dir, "a.sqlite");
  execFileSync("sqlite3", [f], { input: `CREATE TABLE T (K TEXT, S TEXT, V INTEGER, PRIMARY KEY (K, S));
INSERT INTO T VALUES ('a', NULL, 10), ('a', NULL, 15), ('b', 'x', 1);` });
  const d = diffDatabases(f, f);
  assert.equal(d.tables.length, 0);
  assert.deepEqual(d.totals, { added: 0, removed: 0, changed: 0 });
});
