import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { applyQuickOptions, pageAgeScreens, pageDriveStart, pageDriveStop, pagePopups, parseSetup, setOptionKeys } from "../lib/engine-lab.mjs";

test("setup specs expand presets and route player parameters to the player", () => {
  assert.equal(parseSetup(undefined), null);
  // A mod's own setup parameter can carry a hyphen in its id (Emigration's EMIG-AiStrategy).
  assert.equal(parseSetup("EMIG-AiStrategy=EMIG_AI_STRATEGY_OFF").game["EMIG-AiStrategy"], "EMIG_AI_STRATEGY_OFF");
  const s = parseSetup("fast,MapSize=MAPSIZE_TINY,PlayerDifficulty=DIFFICULTY_KING");
  assert.equal(s.game.AgeLength, "AGE_LENGTH_ABBREVIATED");
  assert.equal(s.game.MapSize, "MAPSIZE_TINY");
  assert.equal(s.player.PlayerDifficulty, "DIFFICULTY_KING");
  assert.throws(() => parseSetup("quick"), /unknown setup preset/);
  assert.throws(() => parseSetup("Age Length=x"), /bad setup value/);
});

test("option keys are set on their own line, commented or not, and a missing key is reported", () => {
  const text = "[Gameplay]\n;Skips combat animations, 0 = off\n;QuickCombat 0\nQuickMovement 0\n";
  const r = setOptionKeys(text, { QuickCombat: "1", QuickMovement: "1", Nope: "1" });
  assert.equal(r.text, "[Gameplay]\n;Skips combat animations, 0 = off\nQuickCombat 1\nQuickMovement 1\n");
  assert.deepEqual(r.missing, ["Nope"]);
  assert.deepEqual(setOptionKeys(r.text, { QuickCombat: "1" }).changed, []);
});

test("quick options write only the files that are there", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-quick-"));
  fs.writeFileSync(path.join(dir, "UserOptions.txt"), ";QuickCombat 0\n;QuickMovement 0\n;PlayHistoricMomentAnimation 1\n");
  const rep = applyQuickOptions(dir);
  assert.match(fs.readFileSync(path.join(dir, "UserOptions.txt"), "utf8"), /^QuickCombat 1$/m);
  assert.ok(rep.some((l) => /TutorialOptions.txt: not found/.test(l)));
});

// The game page has no ContextManager global (G5, block 2): the screen stack is reached through its module, as the
// display queue is. These fakes stand in for both modules and for the one global pagePopups uses, UI.
function fakePageModules() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-popups-"));
  const queue = path.join(dir, "display-queue-manager.js");
  const context = path.join(dir, "context-manager.js");
  fs.writeFileSync(queue, `
    const recs = [{ category: "AgeProgressionPopup", id: 1 }, { category: "TechCivicPopup", id: 2 }];
    export const DisplayQueueManager = {
      activeDisplays: [], findAll: (f) => recs.filter(f), isSuspended: () => false,
      closeMatching(f) { const out = recs.filter(f); recs.length = 0; return out; },
    };`);
  fs.writeFileSync(context, `
    const el = (t) => ({ tagName: t.toUpperCase() });
    const stack = [el("mouse-guard"), el("screen-age-progression")];
    export const ContextManager = {
      get screens() { return stack; }, get isEmpty() { return stack.length === 0; },
      getCurrentTarget: () => stack[stack.length - 1], pop(s) { stack.splice(stack.indexOf(s), 1); },
    };
    export default ContextManager;`);
  return { queueModule: pathToFileURL(queue).href, contextModule: pathToFileURL(context).href };
}

test("lab popups lists and clears pushed screens by name in a page with no ContextManager global", async () => {
  assert.equal(typeof globalThis.ContextManager, "undefined");
  const ui = globalThis.UI;
  globalThis.UI = { getGameLoadingState: () => 8, notifyUIReady() {} };
  try {
    const mods = fakePageModules();
    const listed = await pagePopups({ action: "list", keep: [], ...mods });
    assert.deepEqual(listed.screens, ["mouse-guard", "screen-age-progression"]);
    const r = await pagePopups({ action: "clear", keep: ["mouse-guard"], ...mods });
    assert.deepEqual(r.closed, ["AgeProgressionPopup#1", "TechCivicPopup#2", "screen-age-progression"]);
  } finally {
    globalThis.UI = ui;
  }
});

// Fake globals for the in-page functions, put back after each test.
async function withGlobals(fakes, body) {
  const saved = Object.fromEntries(Object.keys(fakes).map((k) => [k, globalThis[k]]));
  Object.assign(globalThis, fakes);
  try {
    return await body();
  } finally {
    Object.assign(globalThis, saved);
  }
}

// Milestones push age progress faster than a point a turn (block 2), so the drive checks before each turn it arms.
test("lab drive --stop-before-age-end stops before arming a turn once progress is within the margin", async () => {
  const page = { turn: 100, points: 100 };
  const autoplay = {
    isActive: false, setTurns() {}, setReturnAsPlayer() {}, setObserveAsPlayer() {},
    setActive(on) { if (on) setTimeout(() => { page.turn++; page.points += 5; }, 50); },
  };
  await withGlobals({
    window: {}, Autoplay: autoplay, Players: { get: () => ({ isAlive: true }) }, GameContext: { localPlayerID: 0 },
    UI: { getGameLoadingState: () => 8, notifyUIReady() {} },
    Game: {
      get turn() { return page.turn; }, age: "AGE_ANTIQUITY",
      AgeProgressManager: { getCurrentAgeProgressionPoints: () => page.points, getMaxAgeProgressionPoints: () => 120 },
    },
  }, async () => {
    await pageDriveStart({
      turns: 50, every: 5, sample: null, settleMs: 0, popups: false, keep: [], stuckMs: 5000,
      queueModule: "data:text/javascript,", stopBeforeAgeEnd: 10,
    });
    const d = /** @type {any} */ (globalThis).window.__benchDrive;
    for (let i = 0; i < 40 && d.state === "running"; i++) await new Promise((r) => setTimeout(r, 100));
    pageDriveStop();
    assert.equal(d.state, "near the age's end");
    assert.equal(d.reason, "age progress 110 of 120, within 10 of the age's end");
    assert.equal(d.done, 2);
    assert.equal(page.turn, 102, "no turn armed after the stop");
  });
});

test("the age-change step refuses Exit while the age is still on", async () => {
  const calls = [];
  await withGlobals({
    location: { pathname: "/root-game.html" }, engine: { call: (n) => calls.push(n) },
    UI: { getGameLoadingState: () => 8 }, Game: { AgeProgressManager: { isAgeOver: false } },
  }, async () => {
    const r = await pageAgeScreens({ queueModule: "nope", contextModule: "nope", press: "exit", civ: null });
    assert.equal(r.page, "game");
    assert.equal(r.pressed, null);
    assert.match(r.refused, /isn't over/);
    assert.deepEqual(calls, []);
  });
});
