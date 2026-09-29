import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Bench, readOnlyRefusal } from "../lib/bench.mjs";
import { readModinfo } from "../lib/deploy.mjs";
import { EvidenceLog } from "../lib/evidence.mjs";
import { Lab, otherHarnesses } from "../lib/lab.mjs";
import { startServer } from "../lib/server.mjs";

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test("the SQL console takes one read-only statement", () => {
  for (const ok of ["SELECT 1", "select UnitType from Units;", "WITH t AS (SELECT 1) SELECT * FROM t",
    "SELECT 'delete; drop' AS s"]) {
    assert.equal(readOnlyRefusal(ok), null, ok);
  }
  for (const bad of ["DELETE FROM Units", "UPDATE Units SET Cost = 0", "SELECT 1; DELETE FROM Units",
    "WITH t AS (SELECT 1) DELETE FROM Units", "PRAGMA writable_schema = 1", "ATTACH 'x' AS y", ""]) {
    assert.notEqual(readOnlyRefusal(bad), null, bad);
  }
});

test("the bench refuses a writing statement before it reaches the game", async () => {
  const dir = tmp("tb-sql-");
  const bench = new Bench({ evidence: dir, cdpPort: 1, install: null, logs: dir, modsDb: "", userMods: "" });
  let reached = false;
  bench.requireGame = async () => { reached = true; };
  await assert.rejects(bench.sql("DELETE FROM Units"), /SELECT/);
  assert.equal(reached, false);
});

test("a modinfo item that leaves the mod folder is refused before anything is copied", () => {
  const dir = tmp("tb-mod-");
  const modinfo = (item) => `<Mod id="m" version="1"><ActionGroups><Actions><UIScripts><Item>${item}</Item>`
    + "</UIScripts></Actions></ActionGroups></Mod>";
  fs.writeFileSync(path.join(dir, "m.modinfo"), modinfo("ui/ok.js"));
  assert.deepEqual(readModinfo(dir).items, ["ui/ok.js"]);
  for (const item of ["../escape.js", "ui/../../escape.js", "/../escape.js", "ui\\..\\..\\x.js", "C:\\x.js"]) {
    fs.writeFileSync(path.join(dir, "m.modinfo"), modinfo(item));
    assert.throws(() => readModinfo(dir), /outside the mod folder/, item);
  }
});

test("evidence is read only by date, never by an arbitrary file name", () => {
  const log = new EvidenceLog(tmp("tb-ev-"));
  assert.match(log.fileFor("2026-09-26"), /2026-09-26\.jsonl$/);
  for (const bad of ["../../secrets", "2026-09-26/../../x", "today"]) assert.throws(() => log.fileFor(bad), /not a date/);
});

test("another lab or bisect run blocks a launch; this process and look-alike names do not", () => {
  const ps = [
    "100 1 zsh -c cd bench && node tower-bench.mjs lab start --seed 1",
    "101 100 node tower-bench.mjs lab start --seed 1",
    "102 1 node /x/tower-bench.mjs bisect --turns 30",
    "103 1 sleep-and-keep-deep-running",
    "104 1 node tower-bench.mjs lab status",
    "105 1 zsh my-harness.sh run",
  ].join("\n");
  assert.deepEqual(otherHarnesses(ps, 101, undefined), ["node /x/tower-bench.mjs bisect --turns 30"],
    "the shell that started this run names the command too, and is not another harness");
  assert.deepEqual(otherHarnesses(ps, 102, "my-harness"),
    ["zsh -c cd bench && node tower-bench.mjs lab start --seed 1", "node tower-bench.mjs lab start --seed 1", "zsh my-harness.sh run"]);
});

test("lab stop refuses to kill a game that is not the lab's own", async () => {
  const user = tmp("tb-quit-");
  const lab = new Lab({ user, modsDb: path.join(user, "Mods.sqlite"), evidence: path.join(user, "ev"), cdpPort: 1 },
    { pid: () => 999999999 });
  await assert.rejects(lab.quit({ onlyPid: 1111 }), /not this lab's test game/);
  await assert.rejects(lab.quit({ onlyPid: null }), /not this lab's test game/);
});

test("the lab backs up a user folder whose path contains a quote", () => {
  const user = path.join(tmp("tb-quote-"), "o'brien");
  fs.mkdirSync(user);
  const db = path.join(user, "Mods.sqlite");
  execFileSync("sqlite3", [db,
    "CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT, LastWriteTime INTEGER);"
    + "CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ScannedFileRowId INTEGER, ModId TEXT, Version INTEGER, Disabled BOOLEAN);"]);
  execFileSync("sqlite3", [path.join(user, "LocalStorage.sqlite"), "CREATE TABLE kv(k TEXT); INSERT INTO kv VALUES ('x');"]);
  const lab = new Lab({ user, modsDb: db, evidence: path.join(user, "tb", "evidence"), cdpPort: 1 }, { pid: () => null });
  const run = path.join(user, "run");
  lab.backup(run);
  const copy = path.join(run, "backup", "LocalStorage.sqlite");
  assert.equal(execFileSync("sqlite3", [copy, "SELECT k FROM kv"], { encoding: "utf8" }).trim(), "x");
});

function fakeBench() {
  const bench = new EventEmitter();
  return Object.assign(bench, {
    events: new EventEmitter(),
    paths: { logs: tmp("tb-logs-") },
    watches: { defs: () => ({ watches: {}, invariants: {} }) },
    snapshots: { list: () => [] },
  });
}

function request(port, { method = "GET", pathName = "/api/snapshots", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: pathName, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the server refuses cross-site requests and survives a malformed Host", async () => {
  const server = await startServer(fakeBench(), { port: 0 });
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  try {
    assert.equal(await request(port), 200);
    assert.equal(await request(port, { headers: { "Sec-Fetch-Site": "same-origin" } }), 200);
    assert.equal(await request(port, { headers: { "Sec-Fetch-Site": "cross-site" } }), 403);
    assert.equal(await request(port, { headers: { "Sec-Fetch-Site": "same-site" } }), 403);
    assert.equal(await request(port, { headers: { Host: "evil.example" } }), 403);
    assert.equal(await request(port, { headers: { Host: "a b" } }), 403);
    assert.equal(await request(port, { method: "POST", pathName: "/api/arm" }), 403);
    assert.equal(await request(port), 200, "still serving after the bad requests");
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
