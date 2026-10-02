import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { registryRows } from "../lib/lab.mjs";
import { withProofs } from "../lib/cli/labtools.mjs";
import {
  loadProofs, logVerdict, matchProof, proofKind, proofLabel, proveConflicts, registryVerdict, sameIdVerdict,
} from "../lib/prove.mjs";

const sql = (db, s) => execFileSync("sqlite3", [db], { input: s, encoding: "utf8" });

const finding = (rule, text, extra = {}) => ({ a: "alpha", b: "beta", aRoot: "/m/alpha", bRoot: "/m/beta",
  severity: "High", rule, text, ...extra });

const reg = (over = {}) => ({ active: { onlyNow: [], onlyNext: [] }, controls: [], components: [], ...over });

test("proofKind sorts rules into registry, logs, registered copies and recipe-only", () => {
  assert.equal(proofKind("define-collision"), "registry");
  assert.equal(proofKind("db-key-collision"), "logs");
  assert.equal(proofKind("loc-tag-collision"), "logs");
  assert.equal(proofKind("same-id"), "registered-copies");
  for (const r of ["proto-patch", "localstorage-key", "shared-global"]) assert.equal(proofKind(r), "recipe");
});

test("registryVerdict names the definition that won, by the mod its files come from", () => {
  const c = finding("define-collision", "both register component `panel-x` with Controls.define; ...");
  const won = registryVerdict(c, reg({ controls: [{ name: "panel-x", priority: 0, className: "PanelX", mods: ["beta"] }] }));
  assert.equal(won.verdict, "CONFIRMED");
  assert.match(won.detail, /from beta is live; alpha's was replaced/);
  const byFolder = registryVerdict(c, reg({ controls: [{ name: "panel-x", priority: 0, className: "P", mods: ["alpha"] }] }));
  assert.match(byFolder.detail, /from alpha is live/);
  assert.equal(registryVerdict(c, reg()).verdict, "INCONCLUSIVE");
  const notLoaded = registryVerdict(c, reg({ active: { onlyNow: [], onlyNext: ["beta"] } }));
  assert.match(notLoaded.detail, /beta did not load/);
});

test("registryVerdict for ui-next registrations and redefined-and-decorated components", () => {
  const r = finding("registry-collision", "both register ui-next component `HudThing` through ComponentRegistry");
  assert.equal(registryVerdict(r, reg({ components: [{ name: "HudThing", priority: 2, factory: "Mine" }] })).verdict, "CONFIRMED");
  assert.equal(registryVerdict(r, reg()).verdict, "INCONCLUSIVE");
  const d = finding("define-over-decorated", "Alpha redefines vanilla `unit-panel` and Beta decorates it");
  assert.equal(registryVerdict(d, reg({ controls: [{ name: "unit-panel", priority: 0, className: "U", mods: ["alpha"] }] }))
    .verdict, "CONFIRMED");
  assert.equal(registryVerdict(d, reg()).verdict, "REFUTED");
});

const ROLLBACK_LINES = [
  "[2026-10-02 10:00:00]\tUNIQUE constraint failed: Units.UnitType",
  "[2026-10-02 10:00:00]\tThere were errors loading 'data/units.xml' that require a rollback.",
  "[2026-10-02 10:00:00]\tFailed to apply enabled components",
];

test("logVerdict confirms a rollback, refutes a clean load, and is inconclusive on a silent failure", () => {
  const c = finding("db-key-collision", "both insert the same primary key");
  const hit = logVerdict(c, ["ordinary line", ...ROLLBACK_LINES], false);
  assert.equal(hit.verdict, "CONFIRMED");
  assert.match(hit.detail, /rolled back: .*UNIQUE constraint failed/);
  assert.equal(logVerdict(c, [ROLLBACK_LINES[0]], true).verdict, "CONFIRMED");
  assert.equal(logVerdict(c, ["Loading Mod - x"], true).verdict, "REFUTED");
  const update = logVerdict(finding("db-update-collision", "x"), [], true);
  assert.equal(update.verdict, "INCONCLUSIVE", "a clean load does not settle which value won");
  assert.match(update.detail, /dbdiff/);
  assert.equal(logVerdict(c, [], false).verdict, "INCONCLUSIVE");
});

test("sameIdVerdict reads registered and enabled copies and what the last launch read", () => {
  const c = finding("same-id", "same modinfo id `dup`", { a: "dup", b: "dup" });
  const rows = [{ id: "dup", path: "/m/a/dup.modinfo", disabled: 0 }, { id: "dup", path: "/m/b/dup.modinfo", disabled: 1 }];
  const one = sameIdVerdict(c, rows, ["[t]\tLoading Mod - /m/a/dup.modinfo"]);
  assert.equal(one.verdict, "CONFIRMED");
  assert.match(one.detail, /the enabled one is \/m\/a\/dup.modinfo.*last launch read \/m\/a\/dup.modinfo/);
  assert.match(sameIdVerdict(c, rows.map((r) => ({ ...r, disabled: 0 })), []).detail, /2 copies of dup are enabled/);
  assert.equal(sameIdVerdict(c, rows.slice(0, 1), []).verdict, "REFUTED");
  assert.equal(sameIdVerdict(c, rows.map((r) => ({ ...r, disabled: 1 })), []).verdict, "REFUTED");
});

// ---- the lab flow, against a fake lab ----

function sandbox() {
  const user = fs.mkdtempSync(path.join(os.tmpdir(), "tb-prove-"));
  const db = path.join(user, "Mods.sqlite");
  sql(db, "CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT, LastWriteTime INTEGER);"
    + "CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ScannedFileRowId INTEGER, ModId TEXT, Version INTEGER, Disabled BOOLEAN);"
    + "INSERT INTO ScannedFiles VALUES (1, '/m/alpha/alpha.modinfo', 0), (2, '/m/beta/beta.modinfo', 0),"
    + " (3, '/m/gamma/gamma.modinfo', 0), (4, '/m/bystander/b.modinfo', 0), (5, '/m/dup1/dup.modinfo', 0),"
    + " (6, '/m/dup2/dup.modinfo', 0);"
    + "INSERT INTO Mods VALUES (1, 1, 'alpha', 1, NULL), (2, 2, 'beta', 1, 1), (3, 3, 'gamma', 1, NULL),"
    + " (4, 4, 'bystander', 1, NULL), (5, 5, 'dup', 1, 0), (6, 6, 'dup', 1, 0);");
  const paths = { user, modsDb: db, logs: path.join(user, "Logs"), userMods: path.join(user, "Mods"),
    evidence: path.join(user, "tb", "evidence"), cdpPort: 1 };
  fs.mkdirSync(paths.logs);
  return paths;
}

function applySet(db, candidates, enabledIds) {
  const on = new Set(enabledIds);
  const q = (s) => `'${s.replaceAll("'", "''")}'`;
  sql(db, candidates.map((c) => `UPDATE Mods SET Disabled = ${on.has(c.id) ? 0 : 1} WHERE ScannedFileRowId = `
    + `(SELECT ScannedFileRowId FROM ScannedFiles WHERE Path = ${q(c.path)});`).join("\n"));
}

const enabledIds = (paths) => registryRows(paths.modsDb).filter((r) => r.disabled === 0 || r.disabled === null)
  .map((r) => r.id).sort();

function fakeLab(paths, games) {
  let current = null;
  return {
    root: path.join(paths.user, "runs"),
    get current() { return current; },
    setCurrent(r) { current = r; },
    backup(dir) { fs.mkdirSync(dir, { recursive: true }); return { files: [], registryRows: 0 }; },
    restore() { games.at(-1).restored = true; return { moved: [], restored: ["Mods.sqlite"], registry: [], crashReports: [] }; },
    async startNewGame() {
      const on = enabledIds(paths);
      games.push({ on });
      // The game's load log: gamma's table collides with alpha's, so loading both rolls back.
      const clash = on.includes("alpha") && on.includes("gamma");
      fs.writeFileSync(path.join(paths.logs, "Database.log"), clash ? ROLLBACK_LINES.join("\n") : "all good\n");
      fs.writeFileSync(path.join(paths.logs, "Modding.log"), "Configuring game content\n");
      return { pid: 7, setup: {}, turn: 1 };
    },
    async quit() { return { wasRunning: true }; },
  };
}

function fakeBench(paths) {
  const logged = [];
  return {
    paths, logged, log: (e) => logged.push(e), cdp: { close() {} },
    registry: async () => reg({ controls: [{ name: "panel-x", priority: 0, className: "P", mods: ["beta"] }] }),
  };
}

const CONFLICTS = [
  finding("define-collision", "both register component `panel-x` with Controls.define"),
  finding("define-over-decorated", "Alpha redefines vanilla `panel-x` and Beta decorates it", { severity: "Medium" }),
  finding("db-key-collision", "both insert the same primary key", { b: "gamma", bRoot: "/m/gamma" }),
  finding("same-id", "same modinfo id `dup`", { a: "dup", b: "dup", aRoot: "/m/dup1", bRoot: "/m/dup2" }),
  finding("proto-patch", "both patch Foo.prototype.bar"),
  finding("loc-tag-collision", "1 English text tag(s) with different text", { severity: "Low" }),
];

const deps = (lab) => ({ lab, preflight: () => ({ problems: [], warnings: [] }), applyModSet: applySet,
  gamePid: () => 7, wait: async () => {} });

test("proveConflicts runs one game per pair with only that pair on, and stores a verdict per finding", async () => {
  const paths = sandbox();
  const games = [];
  const bench = fakeBench(paths);
  const r = await proveConflicts(/** @type {any} */ (bench), CONFLICTS, { deps: deps(fakeLab(paths, games)) });

  assert.equal(games.length, 2, "two pairs need the game: alpha+beta and alpha+gamma");
  assert.deepEqual(games.map((g) => g.on), [["alpha", "beta"], ["alpha", "gamma"]], "only the pair is enabled");
  assert.ok(games.every((g) => g.restored));
  const by = Object.fromEntries(r.proofs.map((p) => [p.rule, p]));
  assert.equal(by["define-collision"].verdict, "CONFIRMED");
  assert.equal(by["db-key-collision"].verdict, "CONFIRMED");
  assert.equal(by["same-id"].verdict, "CONFIRMED");
  assert.equal(by["proto-patch"].verdict, "NOT PROVABLE");
  assert.match(by["proto-patch"].command, /bisect --mods alpha,beta --recipe/);
  assert.equal(by["define-over-decorated"], undefined, "Medium is left out at the default level");
  assert.equal(r.skipped, 2);
  assert.equal(bench.logged.filter((e) => e.kind === "prove-conflict").length, 4);
  assert.ok(fs.existsSync(path.join(by["db-key-collision"].run, "logs", "Database.log")), "the logs are kept with the run");

  const stored = loadProofs(paths);
  assert.equal(stored.length, 4);
  const p = matchProof(stored, CONFLICTS[0]);
  assert.match(proofLabel(p) ?? "", /^confirmed on \d{4}-\d{2}-\d{2}$/);
  assert.equal(matchProof(stored, CONFLICTS[1]), null);
  const shown = withProofs(paths, CONFLICTS);
  assert.equal(shown[0].proof.verdict, "CONFIRMED");
  assert.equal(shown[1].proof, undefined);
});

test("proveConflicts at level medium adds Medium findings, and a rerun replaces today's proofs", async () => {
  const paths = sandbox();
  const games = [];
  const lab = fakeLab(paths, games);
  await proveConflicts(/** @type {any} */ (fakeBench(paths)), CONFLICTS, { deps: deps(lab) });
  const r = await proveConflicts(/** @type {any} */ (fakeBench(paths)), CONFLICTS, { level: "medium", deps: deps(lab) });
  assert.equal(r.proofs.find((p) => p.rule === "define-over-decorated")?.verdict, "CONFIRMED");
  assert.equal(loadProofs(paths).length, 5, "same findings proved twice today are stored once");
});

test("proveConflicts refuses while the game or another harness runs, before touching anything", async () => {
  const paths = sandbox();
  const games = [];
  const busy = { ...deps(fakeLab(paths, games)), preflight: () => ({ problems: ["another harness is running"], warnings: [] }) };
  await assert.rejects(proveConflicts(/** @type {any} */ (fakeBench(paths)), CONFLICTS, { deps: busy }), /another harness/);
  assert.equal(games.length, 0);
  assert.deepEqual(loadProofs(paths), []);
});
