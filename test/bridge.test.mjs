import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { bridge } from "../lib/engine.mjs";
import { EventBridge, agentScript, agentStatus, eventCatalogue, parseLogEvent, writeAgent } from "../lib/events.mjs";
import { runRecipe } from "../lib/recipes.mjs";

// A fake of the engine's event system and the lookups the bridge uses to name things.
let handlers;
let logged;
let playersAsked;
let realError;
function emit(name, payload) {
  for (const h of [...(handlers.get(name) ?? [])]) h(payload);
}
beforeEach(() => {
  handlers = new Map();
  logged = [];
  playersAsked = [];
  delete globalThis.__towerBenchBridge;
  realError = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  Object.assign(globalThis, {
    engine: {
      on: (n, h) => handlers.set(n, [...(handlers.get(n) ?? []), h]),
      off: (n, h) => handlers.set(n, (handlers.get(n) ?? []).filter((x) => x !== h)),
    },
    Game: { turn: 31 },
    Players: { get: (id) => { playersAsked.push(id); return id < 2 ? { name: ["Augustus", "Ashurbanipal"][id] } : null; } },
    Cities: { get: (cid) => (cid.id === 100 ? { name: "Nineveh" } : null) },
    Units: { get: () => ({ type: 5 }) },
    GameInfo: { Units: { lookup: () => ({ UnitType: "UNIT_SCOUT" }) } },
    Locale: { compose: (s) => s },
  });
});
afterEach(() => {
  console.error = realError;
  delete globalThis.__towerBenchBridge;
});

// Runs the real page-side function in Node, the way CDP would run it in the game.
const fakeCdp = () => ({ scope: "game", ensure: async () => {}, call: async (fn, args) => fn(args) });

test("subscribed events are buffered with a page id, sequence, turn and readable names", () => {
  bridge({ op: "sync", names: ["CityTransfered"] });
  emit("CityTransfered", { cityID: { owner: 1, id: 100, type: 1 }, player: 0, previousPlayer: 1, bogusPlayer: 99 });
  emit("UnitMoved", { x: 1 }); // not subscribed
  const r = bridge({ op: "drain", since: 0 });
  assert.equal(r.events.length, 1);
  const [e] = r.events;
  assert.equal(e.seq, 1);
  assert.equal(e.turn, 31);
  assert.equal(e.bid, r.id);
  assert.deepEqual(e.names, { cityID: "Nineveh", player: "Augustus", previousPlayer: "Ashurbanipal" });
  assert.ok(playersAsked.includes(99), "an unknown id is checked through Players.get");
});

test("unsubscribing calls engine.off, and later events are not recorded", () => {
  bridge({ op: "sync", names: ["UnitMoved"] });
  bridge({ op: "sync", names: [] });
  emit("UnitMoved", {});
  assert.equal(handlers.get("UnitMoved").length, 0);
  assert.equal(bridge({ op: "drain", since: 0 }).events.length, 0);
});

test("a drain from an unknown page starts from zero, and overflow is counted as dropped", () => {
  bridge({ op: "sync", names: ["UnitMoved"], capacity: 3 });
  for (let i = 0; i < 5; i++) emit("UnitMoved", { i });
  const r = bridge({ op: "drain", since: 4, expect: "some-older-page" });
  assert.deepEqual(r.events.map((e) => e.seq), [3, 4, 5]);
  assert.equal(r.dropped, 2);
  assert.equal(bridge({ op: "drain", since: 4, expect: r.id }).events.length, 1);
});

test("log mode writes each event to UI.log, and the unload marker is always written", () => {
  bridge({ op: "sync", names: ["UnitMoved"], log: true });
  emit("UnitMoved", { x: 3 });
  emit("BeforeUnload");
  assert.ok(logged.some((l) => l.startsWith("[TB-EVENT] ") && l.includes('"name":"UnitMoved"')));
  assert.ok(logged.some((l) => /^\[TB-BRIDGE\] \w+ unload seq=1$/.test(l)));
});

test("the agent's pinned list and logging survive a live session unsubscribing", () => {
  bridge({ op: "sync", names: ["CityTransfered"], pin: true });
  bridge({ op: "sync", names: ["UnitMoved"], log: false });
  bridge({ op: "sync", names: [], log: false });
  const info = bridge({ op: "info" });
  assert.deepEqual(info.subs, ["CityTransfered"]);
  assert.equal(info.log, true);
  assert.equal(info.agent, true);
});

test("the Node bridge drains, notices a reload as a gap, and keeps reading on the new page", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ev-"));
  const b = new EventBridge(fakeCdp(), dir);
  const gaps = [];
  b.on("gap", (g) => gaps.push(g));
  await b.set(["UnitMoved"]);
  b.stop();
  emit("UnitMoved", { n: 1 });
  emit("UnitMoved", { n: 2 });
  await b.poll();
  assert.deepEqual(b.history.map((e) => e.data.n), [1, 2]);

  // The page reloads: the old bridge and its handlers are gone.
  delete globalThis.__towerBenchBridge;
  handlers = new Map();
  await b.poll(); // re-attaches and subscribes again
  emit("UnitMoved", { n: 3 });
  await b.poll();
  assert.equal(gaps.length, 1);
  assert.match(gaps[0].note, /install the agent/);
  assert.deepEqual(b.history.map((e) => e.data.n), [1, 2, 3]);
  assert.equal(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8").trim().split("\n").length, 4, "3 events + 1 gap recorded");
});

test("an event read both live and from UI.log is kept once; a clipped log line still identifies it", async () => {
  const b = new EventBridge(fakeCdp(), null);
  await b.set(["UnitMoved"], { log: true });
  b.stop();
  emit("UnitMoved", { n: 1 });
  await b.poll();
  const line = logged.find((l) => l.startsWith("[TB-EVENT] "));
  assert.equal(b.ingestLogLine(`[2026-09-26 21:00:00]\t${line}`), false, "duplicate refused");
  assert.equal(b.history.length, 1);
  const clipped = parseLogEvent('[TB-EVENT] {"bid":"abc","seq":7,"t":1,"turn":3,"name":"CityTransfered","data":{"cityID":{"owner":1,"id":1');
  assert.deepEqual([clipped.bid, clipped.seq, clipped.name, clipped.clipped], ["abc", 7, "CityTransfered", true]);
  assert.equal(b.ingestLogLine(`x [TB-EVENT] {"bid":"abc","seq":7,"name":"CityTransfered"}`), true);
});

test("waitFor finds a past match, a future match, honours match expressions, and supports none", async () => {
  const b = new EventBridge(fakeCdp(), null);
  await b.set(["CityTransfered"]);
  b.stop();
  emit("CityTransfered", { player: 1 });
  await b.poll();
  assert.equal((await b.waitFor({ event: "CityTransfered", timeoutMs: 50 })).ok, true);
  assert.equal((await b.waitFor({ event: "CityTransfered", match: "e.data.player === 0", timeoutMs: 50 })).ok, false);
  const later = b.waitFor({ event: "CityTransfered", match: "e.names.player === 'Augustus'", timeoutMs: 2000, from: b.history.length });
  setTimeout(async () => { emit("CityTransfered", { player: 0 }); await b.poll(); }, 30);
  assert.equal((await later).ok, true);
  assert.equal((await b.waitFor({ event: "UnitMoved", none: true, timeoutMs: 50 })).ok, true);
  assert.equal((await b.waitFor({ event: "CityTransfered", none: true, timeoutMs: 50 })).ok, false);
});

test("the agent script is valid on its own, pins its list at load, and says so in UI.log", () => {
  const src = agentScript(["CityTransfered", "UnitMoved"]);
  new Function(src)();
  const info = globalThis.__towerBenchBridge.info();
  assert.deepEqual(info.pinned, ["CityTransfered", "UnitMoved"]);
  assert.equal(info.log, true);
  assert.ok(logged.some((l) => /agent attached at load, subscribed to CityTransfered, UnitMoved/.test(l)));
  delete globalThis.__towerBenchBridge;
  new Function(agentScript([]))();
  assert.equal(globalThis.__towerBenchBridge, undefined, "an empty list leaves the agent inert");
});

test("writing the agent produces a save-safe modinfo and a readable status", () => {
  const userMods = fs.mkdtempSync(path.join(os.tmpdir(), "tb-agent-"));
  const paths = { userMods };
  assert.equal(agentStatus(paths).installed, false);
  const dir = writeAgent(paths, ["UnitMoved"]);
  assert.match(fs.readFileSync(path.join(dir, "tower-bench-agent.modinfo"), "utf8"), /<AffectsSavedGames>0<\/AffectsSavedGames>/);
  assert.deepEqual(agentStatus(paths).subscriptions, ["UnitMoved"]);
  writeAgent(paths, []);
  assert.deepEqual(agentStatus(paths).subscriptions, []);
});

test("recipes listen, then await an event that fires during the recipe, or assert that one does not", async () => {
  const events = new EventBridge(fakeCdp(), null);
  const bench = {
    events,
    status: async () => ({ snapshot: {} }),
    eval: async () => { emit("CityTransfered", { player: 1 }); return 1; },
  };
  const r = await runRecipe(bench, { steps: [
    { events: ["CityTransfered"] },
    { eval: "trigger" },
    { await: { event: "CityTransfered", match: "e.names.player === 'Ashurbanipal'", timeoutMs: 500 } },
    { await: { event: "CityTransfered", none: true, timeoutMs: 100 } },
  ] });
  events.stop();
  assert.deepEqual(r.results.map((x) => x.ok), [true, true, true, true]);
  assert.match(r.results[2].detail, /at turn 31/);
});

test("the event catalogue is read from the install", () => {
  const install = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cat-"));
  const dir = path.join(install, "Contents", "Resources", "Base", "modules", "core", "data");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "gamecore-events.xml"), '<Database><GameCoreEvents><Row Name="UnitMoved"/><Row Name="AgeOver"/></GameCoreEvents></Database>');
  assert.deepEqual(eventCatalogue({ install }), ["AgeOver", "UnitMoved"]);
  assert.deepEqual(eventCatalogue({ install: null }), []);
});
