import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tower-bench.mjs");

// Every command runs against a throwaway user dir and a debugger port nothing listens on, so these
// catch import and wiring faults without touching a real game or real logs.
function sandbox() {
  const user = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cli-"));
  fs.mkdirSync(path.join(user, "Logs"));
  fs.writeFileSync(path.join(user, "Logs", "Modding.log"),
    "[2026-09-26 17:22:16]\tWarning: Apply Actions - No registered handler for 'x-group (ReplaceUIScript)'.\n");
  execFileSync("sqlite3", [path.join(user, "Mods.sqlite"),
    "CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT, LastWriteTime INTEGER);"
    + "CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ScannedFileRowId INTEGER, ModId TEXT, Version INTEGER, Disabled BOOLEAN);"
    + "CREATE TABLE ModProperties(ModRowId INTEGER, Name TEXT, Value TEXT);"
    + "CREATE TABLE LocalizedText(ModRowId INTEGER, Tag TEXT, Locale TEXT, Text TEXT);"
    + `INSERT INTO ScannedFiles VALUES (1, '${user}/Mods/a/a.modinfo', 0), (2, '/S/workshop/content/1295660/9/a/a.modinfo', 0);`
    + "INSERT INTO Mods VALUES (1, 1, 'a', 1, 0), (2, 2, 'a', 1, 1);"]);
  return {
    TOWER_BENCH_USER_DIR: user,
    TOWER_BENCH_EVIDENCE_DIR: path.join(user, "evidence"),
    TOWER_BENCH_CDP_PORT: "1",
    TOWER_BENCH_INSTALL: path.join(user, "no-install"),
  };
}

function run(env, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 20000 });
  return { code: r.status, out: r.stdout + r.stderr };
}

test("help, status, mods, logs and evidence all run", () => {
  const env = sandbox();
  assert.match(run(env, "--help").out, /live test bench/);

  const status = run(env, "status");
  assert.equal(status.code, 0);
  assert.match(status.out, /^offline:/);

  const mods = run(env, "mods");
  assert.equal(mods.code, 0);
  assert.match(mods.out, /live {2}Mods\/a/);

  const logs = run(env, "logs", "--level", "warn");
  assert.equal(logs.code, 0);
  assert.match(logs.out, /ReplaceUIScript is a Civ VI action/);

  const ev = run(env, "evidence", "--md");
  assert.equal(ev.code, 0);
  assert.match(ev.out, /no writes recorded/);
});

test("writes refuse without --yes and report the connection when the game is not running", () => {
  const env = sandbox();
  const noYes = run(env, "set", "feature", "none", "1", "2");
  assert.equal(noYes.code, 1);
  assert.match(noYes.out, /add --yes/);

  const offline = run(env, "set", "feature", "none", "1", "2", "--yes");
  assert.equal(offline.code, 1);
  assert.match(offline.out, /not connected/);

  const selected = run(env, "plot", "selected");
  assert.match(selected.out, /not connected to the game/);
});
