import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Bench } from "../lib/bench.mjs";
import { CHEAT_OPS } from "../lib/cheats.mjs";
import { ACTIONS, CHEATS_COMMANDS, CHEATS_HELP, CHEATS_ROUTES, actionRequest } from "../lib/cli/cheats.mjs";
import { toMarkdown } from "../lib/evidence.mjs";
import { OPS, describeRequest, hintsFor, snippetFor, validateRequest } from "../lib/writes.mjs";

test("every action is a write operation with a label and an undo note", () => {
  for (const [op, c] of Object.entries(CHEAT_OPS)) {
    assert.ok(Object.hasOwn(OPS, op), op);
    assert.ok(c.label && c.undo && c.group, op);
  }
});

test("action requests are validated before anything reaches the game", () => {
  const ok = (op, args) => assert.equal(validateRequest({ op, args }), null, op);
  ok("player.yield", { player: 0, yield: "YIELD_GOLD", amount: -50 });
  ok("unit.heal", { player: 1, unit: 65536 });
  ok("unit.heal", { player: 1, x: 3, y: 4 });
  ok("city.complete", { player: 0, city: 7 });
  ok("map.reveal", { player: 0 });
  ok("progress.grant", { player: 0, tree: "civic", node: "NODE_CIVIC_AQ_MAIN_CHIEFDOM" });
  const bad = (op, args, re) => assert.match(validateRequest({ op, args }) ?? "", re, op);
  bad("player.yield", { yield: "YIELD_GOLD", amount: 5 }, /player must be a player id/);
  bad("player.yield", { player: "0", yield: "YIELD_GOLD", amount: 5 }, /player id/);
  bad("player.yield", { player: 0, yield: "YIELD_FOOD", amount: 5 }, /does nothing for Food or Production/);
  bad("player.yield", { player: 0, yield: "YIELD_SCIENCE", amount: -5 }, /only adds/);
  bad("player.yield", { player: 0, yield: "YIELD_GOLD", amount: 0 }, /non-zero/);
  bad("unit.heal", { player: 0 }, /which unit/);
  bad("unit.xp", { player: 0, unit: 1 }, /amount .* or to/);
  bad("unit.move", { player: 0, unit: 1, toX: 2 }, /toX and toY/);
  bad("city.grow", { player: 0 }, /which city/);
  bad("progress.complete", { player: 0, tree: "faith" }, /tech or civic/);
  bad("map.reveal", { player: 0, x: 1 }, /both x and y/);
  bad("map.owner", { player: 0, x: 1, y: 1 }, /which city/);
  bad("player.attribute", { player: 0, amount: 1.5 }, /positive whole/);
});

test("the map writes validate exactly as before", () => {
  assert.match(validateRequest({ op: "unit.place", args: { x: 1, y: 2, type: "U" } }), /needs owner/);
  assert.match(validateRequest({ op: "terrain.set", args: { player: 0 } }), /integers/);
});

test("snippets are the standalone calls a mod would make", () => {
  assert.equal(snippetFor({ op: "player.yield", args: { player: 2, yield: "YIELD_GOLD", amount: 100 } }),
    "Players.grantYield(2, YieldTypes.YIELD_GOLD, 100);");
  assert.match(snippetFor({ op: "unit.heal", args: { player: 1, unit: 9 } }),
    /getUnits\(\)\.find\(\(u\) => u\.id\.id === 9\);\nUnits\.setDamage\(unit\.id, 0\);/);
  assert.match(snippetFor({ op: "city.production", args: { player: 0, x: 3, y: 3, amount: 50 } }),
    /MapCities\.getCity\(3, 3\).*\ncity\.BuildQueue\.addProgress\(50\);/s);
  assert.match(snippetFor({ op: "progress.complete", args: { player: 0, tree: "civic" } }), /getActiveTree\(\).*YIELD_CULTURE/s);
  assert.match(snippetFor({ op: "progress.grant", args: { player: 0, tree: "tech", node: "N" } }), /SET_TECH_TREE_NODE/);
  assert.equal(snippetFor({ op: "map.reveal", args: { player: 0 } }), "Visibility.revealAllPlots(0);");
  assert.match(snippetFor({ op: "map.owner", args: { player: 0, city: 7, x: 1, y: 2 } }), /purchasePlot\(\{ x: 1, y: 2 \}\)/);
  for (const op of Object.keys(CHEAT_OPS)) {
    assert.ok(snippetFor({ op, args: { player: 0, unit: 1, city: 1, amount: 1, tree: "tech", node: "N", yield: "YIELD_GOLD",
      promotion: "P", discipline: "D", toX: 1, toY: 1 } }), op);
  }
});

test("hints carry the watched behaviour and say when Undo will skip an action", () => {
  const gold = hintsFor({ op: "player.yield", args: { yield: "YIELD_GOLD" } }, { verdict: "LANDED", sent: true, inverse: {} });
  assert.ok(gold.some((h) => /never show a source/.test(h)));
  assert.ok(!gold.some((h) => /Undo skips/.test(h)));
  const tech = hintsFor({ op: "progress.complete", args: { tree: "tech" } }, { verdict: "LANDED", sent: true, inverse: null });
  assert.ok(tech.some((h) => /Undo skips this \(not undoable: Science and Culture/.test(h)));
  const grow = hintsFor({ op: "city.grow", args: {} }, { verdict: "LANDED", sent: true, inverse: null });
  assert.ok(grow.some((h) => /Grow City notification/.test(h)));
  const none = hintsFor({ op: "unit.heal", args: {} }, { verdict: "NO EFFECT", sent: true });
  assert.ok(none.some((h) => /turn roll/.test(h)));
  assert.ok(!none.some((h) => /the plot/.test(h)), "map-write wording stays with map writes");
  const refused = hintsFor({ op: "unit.heal", args: {} }, { verdict: "REFUSED", sent: false });
  assert.deepEqual(refused, []);
});

test("descriptions read as sentences and the evidence log uses them", () => {
  assert.equal(describeRequest({ op: "player.yield", args: { player: 1, yield: "YIELD_GOLD", amount: 25 } }),
    "grant 25 YIELD_GOLD to player 1");
  assert.equal(describeRequest({ op: "unit.move", args: { player: 0, unit: 4, toX: 2, toY: 3 } }),
    "move unit 0:4 to (2, 3) by recreating it");
  const md = toMarkdown([{ ts: "2026-10-02T10:00:00.000Z", kind: "write", version: "1.5.0", turn: 4,
    request: { op: "city.grow", args: { player: 0, city: 7 } }, result: { verdict: "LANDED", landedMs: 90, sent: true, returned: null } }]);
  assert.match(md, /^- \*\*add a population point in city 0:7: LANDED in 90 ms\.\*\*/);
});

function tempBench() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cheat-"));
  return new Bench({ evidence: dir, cdpPort: 1, install: null, logs: dir, modsDb: "", userMods: "" });
}

test("bench.write validates actions first and keeps them disarmed until armed", async () => {
  const b = tempBench();
  await assert.rejects(b.write({ op: "player.yield", args: { player: 0, yield: "YIELD_FOOD", amount: 1 } }), /Food or Production/);
  await assert.rejects(b.write({ op: "player.yield", args: { player: 0, yield: "YIELD_GOLD", amount: 1 } }), /disarmed/);
});

test("an action without an inverse never enters the undo history", () => {
  const b = tempBench();
  const req = { op: "player.yield", args: { player: 0, yield: "YIELD_GOLD", amount: 5 } };
  const w = b.log({ kind: "write", request: req, result: { verdict: "LANDED", inverse: { ...req, args: { ...req.args, amount: -5 } } } });
  b.log({ kind: "write", request: { op: "progress.complete", args: { player: 0, tree: "tech" } }, result: { verdict: "LANDED", inverse: null } });
  assert.deepEqual(b.undoable().map((e) => e.id), [w.id]);
});

test("CLI actions build requests; each needs --yes", async () => {
  assert.deepEqual(actionRequest("gold", ["250"], { player: 1 }), { op: "player.yield", args: { player: 1, yield: "YIELD_GOLD", amount: 250 } });
  assert.deepEqual(actionRequest("xp", ["=40"], { player: 0, unit: 3 }), { op: "unit.xp", args: { player: 0, unit: 3, to: 40 } });
  assert.deepEqual(actionRequest("move", ["4", "5"], { player: 0, unit: 3 }), { op: "unit.move", args: { player: 0, unit: 3, toX: 4, toY: 5 } });
  assert.deepEqual(actionRequest("reveal", [], { player: 0 }), { op: "map.reveal", args: { player: 0 } });
  assert.deepEqual(actionRequest("own", ["2", "3"], { player: 0, city: 7 }), { op: "map.owner", args: { player: 0, city: 7, x: 2, y: 3 } });
  assert.throws(() => actionRequest("nope", [], { player: 0 }), /unknown action/);
  for (const name of Object.keys(ACTIONS)) assert.ok(Object.hasOwn(CHEAT_OPS, ACTIONS[name].op), name);
  const b = tempBench();
  await assert.rejects(CHEATS_COMMANDS.do({ bench: b, paths: b.paths, opt: { player: "0" } }, ["gold", "5"], "do"), /--yes/);
  assert.match(CHEATS_HELP, /do <action>/);
  assert.ok(CHEATS_ROUTES["POST /api/do"] && CHEATS_ROUTES["GET /api/do/list"]);
  const list = await CHEATS_ROUTES["GET /api/do/list"](b);
  assert.ok(list.actions.some((a) => a.name === "gold" && a.undo));
});
