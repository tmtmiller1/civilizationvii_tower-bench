import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
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

test("a backed-up file the test game created is moved aside, and one the player had is put back", () => {
  const { user, paths } = sandbox();
  const lab = new Lab(paths, { pid: () => null });
  const run = path.join(user, "run");
  const hof = path.join(user, "demographics-halloffame.sqlite");
  lab.backup(run);
  execFileSync("sqlite3", [hof, "CREATE TABLE HallOfFame(Id INTEGER PRIMARY KEY, Payload TEXT); INSERT INTO HallOfFame VALUES (1, 'test game');"]);
  const rep = lab.restore(run);
  assert.ok(!fs.existsSync(hof), "the player had no file, so none is left behind");
  assert.ok(fs.existsSync(path.join(run, "written-by-test-game", "demographics-halloffame.sqlite")), "moved, not deleted");
  assert.ok(rep.moved.includes("demographics-halloffame.sqlite"));

  execFileSync("sqlite3", [hof, "CREATE TABLE HallOfFame(Id INTEGER PRIMARY KEY, Payload TEXT); INSERT INTO HallOfFame VALUES (1, 'player');"]);
  const run2 = path.join(user, "run2");
  lab.backup(run2);
  execFileSync("sqlite3", [hof, "UPDATE HallOfFame SET Payload = 'test game';"]);
  lab.restore(run2);
  assert.equal(execFileSync("sqlite3", [hof, "SELECT Payload FROM HallOfFame"], { encoding: "utf8" }).trim(), "player");
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

// The last turn of an age ends in the next age's turn 1 (G5 and H4, block 2): the turn number goes down, the age
// changes, and the new age's page waits on its curtain. The fake page runs each page function against fake globals.
test("ending the last turn of an age counts as a turn once the new age is ready", async () => {
  const { paths } = sandbox();
  const lab = new Lab(paths, { pid: () => 1 });
  const page = { turn: 120, age: "AGE_ANTIQUITY", loading: 8, readyCalls: 0 };
  const saved = Object.fromEntries(["Game", "GameContext", "UI"].map((k) => [k, globalThis[k]]));
  Object.assign(globalThis, {
    Game: { get turn() { return page.turn; }, get age() { return page.age; }, Notifications: null },
    GameContext: {
      localPlayerID: 0,
      sendTurnComplete() { Object.assign(page, { turn: 1, age: "AGE_EXPLORATION", loading: 3 }); },
    },
    UI: {
      Player: { deselectAllUnits() {} }, getGameLoadingState: () => page.loading,
      notifyUIReady() { if (++page.readyCalls >= 2) page.loading = 8; },
    },
  });
  lab.cdp = { ensure: async () => {}, call: async (fn, args) => JSON.parse(JSON.stringify((await fn(args)) ?? null)) };
  try {
    const [r] = await lab.endTurns(1, { timeoutMs: 6000 });
    assert.deepEqual([r.from, r.to, r.age], [120, 1, "AGE_EXPLORATION"]);
    assert.equal(page.loading, 8);
  } finally {
    Object.assign(globalThis, saved);
  }
});

// The crossing a player gets, without Autoplay: the last turn ends, the endgame cinematic moves itself on to the
// victories screen, whose Exit goes to the main menu's civ select, whose Choose loads the next age behind its curtain.
// The fake page swaps the page URL, the screen stack and the globals the way the game does at each step.
function fakeCrossing() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-age-"));
  const context = path.join(dir, "context-manager.js");
  const queue = path.join(dir, "display-queue-manager.js");
  fs.writeFileSync(context, "export const ContextManager = { get screens() { return globalThis.__fakeAge.stack; } };");
  fs.writeFileSync(queue, "export const DisplayQueueManager = { get activeDisplays() { return globalThis.__fakeAge.queue; } };");
  const el = (t, component) => ({ tagName: t.toUpperCase(), component });
  const page = {
    scope: "game", turn: 120, age: "AGE_ANTIQUITY", points: 118, loading: 8, ageOver: false, readyCalls: 0,
    stack: [el("mouse-guard")], queue: [], chosen: null, sent: 0,
  };
  const later = (ms, f) => setTimeout(f, ms);
  const civSelect = {
    civData: [{ civID: "CIVILIZATION_MONGOLIA", isLocked: true }, { civID: "CIVILIZATION_SPAIN", isLocked: false }],
    selectedCivInfo: null,
    startGame() {
      page.chosen = this.selectedCivInfo.civID;
      later(150, () => Object.assign(page, {
        scope: "game", turn: 1, age: "AGE_EXPLORATION", points: 0, loading: 3, ageOver: false, stack: [],
      }));
    },
  };
  const globals = {
    __fakeAge: page,
    location: { get pathname() { return page.scope === "shell" ? "/root-shell.html" : "/root-game.html"; } },
    // The main-menu page has a Game too; its age isn't the next age's, and its loading state reads 8.
    Game: {
      get turn() { return page.turn; }, get age() { return page.scope === "shell" ? "SHELL" : page.age; },
      Notifications: null,
      AgeProgressManager: {
        get isAgeOver() { return page.ageOver; },
        getCurrentAgeProgressionPoints: () => page.points, getMaxAgeProgressionPoints: () => 120,
      },
    },
    GameInfo: { Ages: { lookup: (a) => ({ AgeType: a }) } },
    GameContext: {
      localPlayerID: 0,
      sendTurnComplete() {
        page.sent++;
        if (page.turn !== 120 || page.ageOver) return;
        Object.assign(page, { ageOver: true, points: 120, stack: [el("mouse-guard"), el("endgame-screen")] });
        page.queue = [{ category: "EndgameScreen" }];
        later(200, () => { page.stack = [el("mouse-guard"), el("screen-victory-progress")]; });
      },
    },
    engine: {
      call(name) {
        if (name !== "exitToMainMenu") return;
        Object.assign(page, { scope: "shell", queue: [], stack: [el("age-transition-civ-select", civSelect)] });
      },
    },
    UI: {
      Player: { deselectAllUnits() {} },
      getGameLoadingState: () => (page.scope === "shell" ? 8 : page.loading),
      notifyUIReady() { if (page.scope === "game" && ++page.readyCalls >= 3) page.loading = 8; },
    },
  };
  const modules = { queueModule: pathToFileURL(queue).href, contextModule: pathToFileURL(context).href };
  return { page, globals, modules };
}

test("lab age-change steps through the end-of-age screens into the next age, naming each and what cleared it", async () => {
  const { paths } = sandbox();
  const lab = new Lab(paths, { pid: () => 1, stepMs: 60 });
  const { page, globals, modules } = fakeCrossing();
  const saved = Object.fromEntries(Object.keys(globals).map((k) => [k, globalThis[k]]));
  Object.defineProperties(globalThis, Object.getOwnPropertyDescriptors(globals));
  lab.cdp = {
    get scope() { return page.scope; }, ensure: async () => {},
    call: async (fn, args) => JSON.parse(JSON.stringify((await fn(args)) ?? null)),
  };
  const lines = [];
  try {
    const r = await lab.ageChange({
      graceMs: 300, civ: "CIVILIZATION_MONGOLIA", timeoutMs: 20000, modules, log: (l) => lines.push(l),
    });
    assert.deepEqual([r.from.ageType, r.from.turn, r.to.ageType, r.to.turn, r.turns],
      ["AGE_ANTIQUITY", 120, "AGE_EXPLORATION", 1, 1]);
    assert.equal(page.chosen, "CIVILIZATION_SPAIN", "a locked civ asked for isn't chosen");
    assert.equal(page.loading, 8);
    assert.equal(page.sent, 1, "the turn is sent once; the end-of-age screens hold the nudges");
    const text = lines.join("\n");
    for (const want of [
      /endgame-screen up \(game page\)/,
      /queue EndgameScreen up/,
      /endgame-screen cleared by the game/,
      /screen-victory-progress up \(game page\)/,
      /screen-victory-progress: exitToMainMenu \(the Exit button\)/,
      /screen-victory-progress cleared by exitToMainMenu \(the Exit button\)/,
      /age-transition-civ-select up \(shell page\)/,
      /startGame with CIVILIZATION_SPAIN \(the Choose button\); CIVILIZATION_MONGOLIA isn't offered unlocked/,
      /age-transition-civ-select cleared by startGame with CIVILIZATION_SPAIN/,
      /loading curtain up \(game page, loading state 3\)/,
      /loading curtain cleared by UI\.notifyUIReady\(\)/,
      /turn 120 -> 1, into the next age/,
    ]) assert.match(text, want);
    assert.ok(r.screens.includes("age-transition-civ-select"));
  } finally {
    for (const k of Object.keys(globals)) delete globalThis[k];
    Object.assign(globalThis, Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined)));
  }
});
