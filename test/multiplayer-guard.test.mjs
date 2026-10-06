import assert from "node:assert/strict";
import { test } from "node:test";
import { Bench } from "../lib/bench.mjs";
import { multiplayerFlags } from "../lib/engine.mjs";

const REQUEST = { op: "terrain.set", args: { x: 1, y: 1, type: "TERRAIN_GRASS" } };

/** A bench whose game answers `flags` (or throws it) to the multiplayer check; records what else was called. */
function fakeBench(flags, scope = "game") {
  const calls = [];
  const call = async (fn) => {
    calls.push(fn.name);
    if (fn.name === "multiplayerFlags") {
      if (flags instanceof Error) throw flags;
      return flags;
    }
    if (fn.name === "consoleEval") return 7;
    return { verdict: "LANDED" };
  };
  const bench = Object.create(Bench.prototype);
  Object.assign(bench, {
    armed: true, calls, logged: [],
    cdp: { scope, ensure: async () => {}, call },
    log(e) { this.logged.push(e); return { id: "1", ts: "t" }; },
    turn: async () => 5,
    achievementsRefusal: () => null,
  });
  return bench;
}

const SINGLE = { any: false, network: false, hotseat: false };

test("a write in a single-player game goes through", async () => {
  const bench = fakeBench(SINGLE);
  assert.equal((await bench.write(REQUEST)).verdict, "LANDED");
  assert.deepEqual(bench.calls, ["multiplayerFlags", "performWrite"]);
});

for (const [label, flags] of [["network", { any: true, network: true, hotseat: false }],
  ["hotseat", { any: true, network: false, hotseat: true }], ["flagged", { any: true, network: false, hotseat: false }]]) {
  test(`a write in a ${label} multiplayer game is refused before it reaches the game`, async () => {
    const bench = fakeBench(flags);
    await assert.rejects(bench.write(REQUEST), (e) => e.status === 409 && /this is a multiplayer game/.test(e.message));
    assert.deepEqual(bench.calls, ["multiplayerFlags"]);
  });
}

test("a write is refused when the engine cannot say what kind of game it is", async () => {
  for (const flags of [new Error("Configuration is not defined"), null, { any: false }, {}]) {
    const bench = fakeBench(flags);
    await assert.rejects(bench.write(REQUEST), /cannot tell whether this is a multiplayer game/);
    assert.ok(!bench.calls.includes("performWrite"));
  }
});

test("the console is refused in a multiplayer game but runs on the main menu and in single player", async () => {
  const mp = fakeBench({ any: true, network: true, hotseat: false });
  await assert.rejects(mp.eval("1"), /this is a multiplayer game/);
  assert.ok(!mp.calls.includes("consoleEval"));
  const menu = fakeBench(new Error("not in a game"), "shell");
  assert.equal(await menu.eval("1"), 7);
  assert.deepEqual(menu.calls, ["consoleEval"]);
  assert.equal(await fakeBench(SINGLE).eval("1"), 7);
});

test("the in-game check reads the same three flags the game's own UI reads", () => {
  const g = { isAnyMultiplayer: true, isNetworkMultiplayer: false, isHotseat: true };
  globalThis.Configuration = { getGame: () => g };
  try {
    assert.deepEqual(multiplayerFlags(), { any: true, network: false, hotseat: true });
  } finally {
    delete globalThis.Configuration;
  }
});

test("a write in a single-player game that can earn achievements is refused after the multiplayer check", async () => {
  const bench = fakeBench(SINGLE);
  bench.achievementsRefusal = () => "this game may be earning achievements";
  await assert.rejects(bench.write(REQUEST), (e) => e.status === 409 && /may be earning achievements/.test(e.message));
  assert.deepEqual(bench.calls, ["multiplayerFlags"]);
  await assert.rejects(bench.eval("1"), /may be earning achievements/);
  assert.ok(!bench.calls.includes("consoleEval"));
});
