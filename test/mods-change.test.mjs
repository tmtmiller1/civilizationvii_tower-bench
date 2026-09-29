import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Bench } from "../lib/bench.mjs";
import { filterMods, modHealth, planModChange, readFlags, readMods } from "../lib/mods.mjs";

const WS = "/S/steamapps/workshop/content/1295660";

// A registry shaped like the game's: one mod with a local and a Workshop copy (both enabled, the
// duplicate the Mods tab flags), one single-copy mod left at NULL, and an official module.
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-mods-"));
  const user = path.join(dir, "user");
  fs.mkdirSync(user);
  const db = path.join(user, "Mods.sqlite");
  const local = path.join(user, "Mods", "canals", "canals.modinfo");
  execFileSync("sqlite3", [db, `
    CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT, LastWriteTime INTEGER);
    CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ScannedFileRowId INTEGER, ModId TEXT, Version INTEGER, Disabled BOOLEAN);
    CREATE TABLE ModProperties(ModRowId INTEGER, Name TEXT, Value TEXT);
    CREATE TABLE LocalizedText(ModRowId INTEGER, Locale TEXT, Tag TEXT, Text TEXT);
    INSERT INTO ScannedFiles VALUES (1, '${local}', 0), (2, '${WS}/111/canals.modinfo', 0),
      (3, '${WS}/222/maps.modinfo', 0), (4, '/G/Resources/DLC/x/modules/x.modinfo', 0);
    INSERT INTO Mods VALUES (10, 1, 'canals', 1, 0), (11, 2, 'canals', 1, NULL), (12, 3, 'maps', 1, NULL),
      (13, 4, 'dlc-x', 1, 0);
    INSERT INTO ModProperties VALUES (10, 'Name', 'LOC_CANALS_NAME'), (10, 'Authors', 'Tower'),
      (11, 'Name', 'Canals'), (11, 'Authors', 'Tower'), (12, 'Name', 'Map Pack'), (12, 'Authors', 'Someone Else');
    INSERT INTO LocalizedText VALUES (10, 'en_US', 'LOC_CANALS_NAME', 'Canals');`]);
  const paths = { user, modsDb: db, userMods: path.join(user, "Mods"), evidence: path.join(dir, "tb", "evidence"),
    cdpPort: 1, install: null, logs: dir };
  const bench = new Bench(paths);
  bench.gamePid = () => null;
  bench.armed = true;
  return { db, local, paths, bench };
}

const health = ({ db, paths }) => modHealth(readMods(db), paths);

test("mods carry their author, and the filter matches id, name or author, any case", () => {
  const s = sandbox();
  const mods = health(s);
  assert.equal(mods.find((m) => m.id === "canals").authors, "Tower");
  assert.deepEqual(filterMods(mods, "tower").map((m) => m.id), ["canals"]);
  assert.deepEqual(filterMods(mods, "MAP PACK").map((m) => m.id), ["maps"]);
  assert.deepEqual(filterMods(mods, "someone").map((m) => m.id), ["maps"]);
  assert.equal(filterMods(mods, "  ").length, mods.length);
  assert.deepEqual(filterMods(mods, "nothing-like-this"), []);
});

test("planning a change refuses what it cannot do safely", () => {
  const mods = health(sandbox());
  assert.match(planModChange(mods, { op: "on", id: "nope" }).refuse, /no installed mod/);
  assert.match(planModChange(mods, { op: "off", id: "dlc-x" }).refuse, /official content/);
  assert.match(planModChange(mods, { op: "on", id: "canals" }).refuse, /2 copies; choose/);
  assert.match(planModChange(mods, { op: "live", id: "canals", copy: "Workshop 999" }).refuse, /no copy/);
  assert.match(planModChange(mods, { op: "nuke", id: "maps" }).refuse, /unknown change/);
});

test("live loads one copy and switches the others off; an unchanged flag is not rewritten", () => {
  const mods = health(sandbox());
  const plan = planModChange(mods, { op: "live", id: "canals", copy: "Workshop 111" });
  assert.deepEqual(plan.changes.map((c) => [c.label, c.from, c.to]), [["Mods/canals", 0, 1], ["Workshop 111", null, 0]]);
  assert.deepEqual(planModChange(mods, { op: "off", id: "canals" }).changes.map((c) => c.to), [1, 1]);
  assert.deepEqual(planModChange(mods, { op: "off", id: "canals", copy: "Workshop 111" }).changes.map((c) => [c.label, c.to]),
    [["Workshop 111", 1]], "off with a copy leaves the other copies as they are");
  assert.match(planModChange(mods, { op: "live", id: "canals" }).refuse, /needs a copy/);
  assert.deepEqual(planModChange(mods, { op: "on", id: "maps" }).changes.map((c) => [c.from, c.to]), [[null, 0]]);
});

test("a change is written, read back as LANDED, and undo restores the exact flags, NULL included", async () => {
  const s = sandbox();
  const r = s.bench.setMods({ op: "live", id: "canals", copy: "Mods/canals" });
  assert.equal(r.verdict, "LANDED");
  const ws = `${WS}/111/canals.modinfo`;
  assert.deepEqual([...readFlags(s.db, [s.local, ws])], [[s.local, 0], [ws, 1]]);
  assert.equal(health(s).find((m) => m.id === "canals").issues.some((i) => i.severity === "error"), false);

  const u = await s.bench.undo();
  assert.equal(u.verdict, "LANDED");
  assert.equal(u.undid, "live canals (Mods/canals)");
  const after = readFlags(s.db, [s.local, ws]);
  assert.equal(after.get(s.local), 0);
  assert.equal(after.get(ws), null, "NULL stays NULL, not 0");
  await assert.rejects(s.bench.undo(), /nothing to undo/);
});

test("asking for the state a mod is already in changes nothing and is not undoable", () => {
  const s = sandbox();
  const r = s.bench.setMods({ op: "on", id: "canals", copy: "Mods/canals" });
  assert.equal(r.verdict, "LANDED");
  assert.equal(s.bench.setMods({ op: "on", id: "canals", copy: "Mods/canals" }).verdict, "ALREADY");
  assert.equal(s.bench.undoable().length, 1);
});

test("the registry is left alone while disarmed, while the game runs, or during a lab run", () => {
  const s = sandbox();
  const before = fs.readFileSync(s.db);
  s.bench.armed = false;
  assert.throws(() => s.bench.setMods({ op: "off", id: "maps" }), /disarmed/);
  s.bench.armed = true;
  s.bench.gamePid = () => 4242;
  assert.throws(() => s.bench.setMods({ op: "off", id: "maps" }), /game is running/);
  s.bench.gamePid = () => null;
  const runs = path.join(path.dirname(s.paths.evidence), "runs");
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, "current.json"), "{}");
  assert.throws(() => s.bench.setMods({ op: "off", id: "maps" }), /lab run is in progress/);
  assert.deepEqual(fs.readFileSync(s.db), before);
});

test("a write whose row vanished (the game re-scanned the mod) reads back as NO EFFECT, not LANDED", () => {
  const s = sandbox();
  const r = s.bench.setFlags([{ path: "/gone/after/rescan.modinfo", label: "Mods/gone", disabled: 1 }]);
  assert.equal(r.verdict, "NO EFFECT");
  assert.equal(s.bench.undoable().length, 0);
});
