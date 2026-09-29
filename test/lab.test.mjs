import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Lab, candidateMods, registryRows } from "../lib/lab.mjs";

function sandbox() {
  const user = fs.mkdtempSync(path.join(os.tmpdir(), "tb-lab-"));
  const auto = path.join(user, "Saves", "Single", "auto");
  fs.mkdirSync(auto, { recursive: true });
  fs.writeFileSync(path.join(auto, "AutoSave_0030.Civ7Save"), "campaign turn 30");
  fs.writeFileSync(path.join(user, "AppOptions.txt"), "UIFileWatcher 1\r\n");
  const db = path.join(user, "Mods.sqlite");
  execFileSync("sqlite3", [db,
    "CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT, LastWriteTime INTEGER);"
    + "CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ScannedFileRowId INTEGER, ModId TEXT, Version INTEGER, Disabled BOOLEAN);"
    + "INSERT INTO ScannedFiles VALUES (1, '/m/a.modinfo', 0), (2, '/m/b.modinfo', 0), (3, '/m/c.modinfo', 0);"
    + "INSERT INTO Mods VALUES (10, 1, 'a', 1, NULL), (11, 2, 'b', 1, 1), (12, 3, 'c', 1, 0);"]);
  execFileSync("sqlite3", [path.join(user, "LocalStorage.sqlite"), "CREATE TABLE kv(k TEXT, v TEXT); INSERT INTO kv VALUES ('modSettings', 'original');"]);
  return {
    user,
    paths: { user, modsDb: db, evidence: path.join(user, "tb", "evidence"), cdpPort: 1 },
  };
}

test("restore undoes everything a test game writes, and deletes nothing", () => {
  const { user, paths } = sandbox();
  const lab = new Lab(paths, { pid: () => null });
  const run = path.join(user, "run");
  lab.backup(run);

  // What a Play Now game and the game's mod scan do while the test runs.
  const auto = path.join(user, "Saves", "Single", "auto");
  fs.writeFileSync(path.join(auto, "AutoSave_0001.Civ7Save"), "test game");
  execFileSync("sqlite3", [path.join(user, "LocalStorage.sqlite"), "UPDATE kv SET v = 'changed by test game';"]);
  fs.writeFileSync(path.join(user, "AppOptions.txt"), "rewritten on exit\r\n");
  execFileSync("sqlite3", [paths.modsDb,
    "UPDATE Mods SET Disabled = 1 WHERE ModRowId = 10;"          // a was enabled (NULL)
    + "UPDATE Mods SET Disabled = NULL WHERE ModRowId = 11;"     // b was disabled
    + "INSERT INTO ScannedFiles VALUES (4, '/m/new.modinfo', 0);"
    + "INSERT INTO Mods VALUES (13, 4, 'new', 1, NULL);"]);       // re-registered during the run

  const rep = lab.restore(run);

  assert.deepEqual(fs.readdirSync(auto), ["AutoSave_0030.Civ7Save"], "the player's autosaves are back exactly");
  assert.equal(fs.readFileSync(path.join(run, "written-by-test-game", "auto", "AutoSave_0001.Civ7Save"), "utf8"), "test game", "the test game's save was moved, not deleted");
  assert.equal(execFileSync("sqlite3", [path.join(user, "LocalStorage.sqlite"), "SELECT v FROM kv"], { encoding: "utf8" }).trim(), "original");
  assert.equal(fs.readFileSync(path.join(user, "AppOptions.txt"), "utf8"), "UIFileWatcher 1\r\n");

  const byId = Object.fromEntries(registryRows(paths.modsDb).map((r) => [r.id, r.disabled]));
  assert.equal(byId.a, null, "NULL is restored as NULL, not 0");
  assert.equal(byId.b, 1);
  assert.equal(byId.c, 0);
  assert.equal(byId.new, null, "a row new since the backup is reported and left alone");
  assert.ok(rep.registry.some((r) => r.id === "new" && /new since the backup/.test(r.note)));
  assert.deepEqual(rep.crashReports.filter((f) => !f.includes("CivilizationVII")), []);
});

test("restore refuses while the game is running is enforced by gamePid, and backup survives a missing autosave folder", () => {
  const { user, paths } = sandbox();
  fs.rmSync(path.join(user, "Saves"), { recursive: true });
  const lab = new Lab(paths, { pid: () => null });
  const r = lab.backup(path.join(user, "run"));
  assert.ok(r.files.includes("Mods.sqlite"));
  assert.ok(!r.files.includes("auto"));
});

test("bisect candidates are enabled non-official mods, never the bench's own agent", () => {
  const { paths } = sandbox();
  execFileSync("sqlite3", [paths.modsDb,
    "INSERT INTO ScannedFiles VALUES (5, '/m/tower-bench-agent.modinfo', 0), (6, '/X/Resources/DLC/napoleon/napoleon.modinfo', 0);"
    + "INSERT INTO Mods VALUES (14, 5, 'tower-bench-agent', 1, NULL), (15, 6, 'napoleon', 1, NULL);"]);
  assert.deepEqual(candidateMods(paths.modsDb).map((c) => c.id).sort(), ["a", "c"]);
});
