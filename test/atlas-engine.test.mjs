import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { atlasCrawl } from "../lib/engine-atlas.mjs";
import { crawlArgs } from "../lib/atlas.mjs";

const g = /** @type {any} */ (globalThis);
const NAMES = ["FakeGame", "FakeNative", "FakeTypes", "FakeHost"];
afterEach(() => { for (const n of NAMES) delete g[n]; });

// A native-like object: members live behind a Proxy that hides them from getOwnPropertyNames (as Object.keys
// gives [] on the engine's objects) but answers a read by name.
function nativeLike(members, reads) {
  return new Proxy({}, {
    get: (_t, k) => { reads.push(String(k)); return members[k]; },
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => undefined,
  });
}

function fakeEngine() {
  const calls = [];
  const reads = [];
  class Library {
    getTurn(a, b) { calls.push("getTurn"); return a + b; }
    get turn() { calls.push("turn getter"); return 7; }
    get dangerous() { calls.push("dangerous getter"); throw new Error("side effect"); }
  }
  const game = new Library();
  game.self = game;
  game.Ops = { sendRequest: (p, op, args) => { calls.push("sendRequest"); return [p, op, args]; }, back: game };
  g.FakeGame = game;
  g.FakeNative = nativeLike({ getPlotIndex: (x, y) => x + y, width: 84 }, reads);
  g.FakeTypes = { YIELD_FOOD: 0, YIELD_GOLD: 1, YIELD_SCIENCE: 2 };
  return { calls, reads };
}

test("the crawl records kinds and arities and never calls a function", () => {
  const { calls } = fakeEngine();
  const r = atlasCrawl({ roots: ["FakeGame", "FakeTypes", "Missing"] });
  assert.deepEqual(calls, [], "no function or getter was run");
  assert.deepEqual(r.records["FakeGame.getTurn"], { kind: "function", arity: 2 });
  assert.equal(r.records["FakeGame.Ops.sendRequest"].arity, 3);
  assert.deepEqual(r.records["FakeGame.turn"], { kind: "accessor", get: true, set: false });
  assert.equal(r.records["FakeTypes.YIELD_GOLD"].value, 1);
  assert.equal(r.records.FakeTypes.enum, true, "an object of numbers is an enum");
  assert.equal(r.records.Missing.kind, "absent");
});

test("cycles end at the first path that reached the object", () => {
  fakeEngine();
  const r = atlasCrawl({ roots: ["FakeGame"], depth: 5 });
  assert.equal(r.records["FakeGame.self"].ref, "FakeGame");
  assert.equal(r.records["FakeGame.Ops.back"].ref, "FakeGame");
  assert.ok(!("FakeGame.self.self" in r.records));
});

test("only allowed getters are read, and a throwing one is recorded, not fatal", () => {
  const { calls } = fakeEngine();
  const r = atlasCrawl({ roots: ["FakeGame"], safe: { FakeGame: ["turn", "dangerous"] } });
  assert.deepEqual(r.records["FakeGame.turn"], { kind: "number", value: 7, via: "getter", accessor: true, set: false });
  assert.equal(r.records["FakeGame.dangerous"].kind, "throws");
  assert.match(r.records["FakeGame.dangerous"].error, /side effect/);
  assert.deepEqual(calls.sort(), ["dangerous getter", "turn getter"]);
  assert.equal(r.stats.errors, 1);
});

test("a native object that hides its names is probed with the names the game uses on it", () => {
  const { reads } = fakeEngine();
  assert.deepEqual(Object.keys(g.FakeNative), []);
  const blind = atlasCrawl({ roots: ["FakeNative"] });
  assert.deepEqual(Object.keys(blind.records), ["FakeNative"], "nothing is visible without probe names");
  const r = atlasCrawl({ roots: ["FakeNative"], probe: { FakeNative: ["getPlotIndex", "width", "gone"] } });
  assert.deepEqual(r.records["FakeNative.getPlotIndex"], { kind: "function", arity: 2, via: "probe" });
  assert.equal(r.records["FakeNative.width"].value, 84);
  assert.equal(r.records["FakeNative.gone"].kind, "absent");
  assert.ok(reads.includes("getPlotIndex"));
});

test("the crawl stops at its record and name limits and says so", () => {
  g.FakeHost = Object.fromEntries(Array.from({ length: 50 }, (_v, i) => [`m${i}`, i]));
  for (let i = 0; i < 30; i++) g.FakeHost[i] = i;
  const capped = atlasCrawl({ roots: ["FakeHost"], maxNames: 10 });
  assert.equal(capped.records.FakeHost.more, 40);
  assert.equal(capped.records.FakeHost.indexed, 30, "array-like indices are counted, not listed");
  const short = atlasCrawl({ roots: ["FakeHost"], maxRecords: 5 });
  assert.equal(short.stats.truncated, true);
  assert.ok(Object.keys(short.records).length <= 6);
});

test("crawl arguments allow reading only names the game reads without calling, and every root", () => {
  const usage = { members: {
    "Game.turn": { count: 4, called: 0 }, "Game.getTurn": { count: 2, called: 2 }, "Game.Ops.sendRequest": { count: 1, called: 1 },
  } };
  const a = crawlArgs(usage, { depth: 2 });
  assert.deepEqual(a.safe.Game, ["turn"]);
  assert.ok(a.safe[""].includes("Game") && a.roots.includes("UI"));
  assert.deepEqual(a.probe["Game.Ops"], ["sendRequest"]);
  assert.equal(a.depth, 2);
});

test("the crawl survives serialisation the way the bench sends it", () => {
  fakeEngine();
  const fn = new Function(`return (${atlasCrawl.toString()})`)();
  const r = fn({ roots: ["FakeTypes"] });
  assert.equal(r.records["FakeTypes.YIELD_FOOD"].kind, "number");
});
