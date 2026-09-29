import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SnapshotStore, describeDiff, diffWorlds } from "../lib/world.mjs";

// A 4x3 world. Plot index = y * w + x.
function world(over = {}) {
  const base = {
    turn: 10, w: 4, h: 3,
    t: [0, 0, 1, 1, 0, 0, 1, 1, 2, 2, 2, 2],
    f: new Array(12).fill(-1),
    r: new Array(12).fill(-1),
    o: [0, 0, -1, -1, 0, 1, 1, -1, -1, -1, -1, -1],
    units: [{ i: 0, owner: 0, id: 1, type: "UNIT_WARRIOR" }, { i: 6, owner: 1, id: 7, type: "UNIT_SCOUT" }],
    cities: [{ i: 1, owner: 0, id: 100, name: "Rome", pop: 3 }, { i: 5, owner: 1, id: 200, name: "Nineveh", pop: 2 }],
    players: [{ id: 0, name: "Augustus", gold: 50 }, { id: 1, name: "Ashurbanipal", gold: 20 }],
    names: { terrains: ["TERRAIN_FLAT", "TERRAIN_HILL", "TERRAIN_OCEAN"], features: ["FEATURE_FOREST"], resources: ["RESOURCE_IRON"] },
  };
  return structuredClone({ ...base, ...over });
}

test("an unchanged world diffs to nothing", () => {
  const d = diffWorlds(world(), world());
  assert.equal(d.plots.length, 0);
  assert.equal(d.transfers.length, 0);
  assert.match(describeDiff(d, world()), /nothing changed/);
});

test("territory transfers are grouped by who gave to whom, and player totals follow", () => {
  const b = world({ turn: 11 });
  b.o[4] = 1; b.o[0] = 1; b.o[2] = 0;
  const d = diffWorlds(world(), b);
  assert.deepEqual(d.transfers, [{ from: 0, to: 1, tiles: 2 }, { from: -1, to: 0, tiles: 1 }]);
  const p0 = d.players.find((p) => p.id === 0);
  assert.deepEqual(p0.tiles, [3, 2]);
  const text = describeDiff(d, b);
  assert.match(text, /territory: 2 tile\(s\) Augustus \(0\) -> Ashurbanipal \(1\)/);
  assert.match(text, /territory: 1 tile\(s\) nobody -> Augustus \(0\)/);
});

test("retyped plots name their before and after types", () => {
  const b = world();
  b.t[3] = 2; b.f[3] = 0; b.r[3] = 0;
  const [p] = diffWorlds(world(), b).plots;
  assert.deepEqual([p.x, p.y], [3, 0]);
  assert.deepEqual(p.terrain, ["TERRAIN_HILL", "TERRAIN_OCEAN"]);
  assert.deepEqual(p.feature, [null, "FEATURE_FOREST"]);
  assert.deepEqual(p.resource, [null, "RESOURCE_IRON"]);
});

test("units are tracked by owner and id: appeared, gone and moved", () => {
  const b = world();
  b.units = [{ i: 2, owner: 0, id: 1, type: "UNIT_WARRIOR" }, { i: 9, owner: 0, id: 3, type: "UNIT_SETTLER" }];
  const d = diffWorlds(world(), b);
  assert.deepEqual(d.units.moved.map((u) => [u.from, u.to]), [[{ x: 0, y: 0 }, { x: 2, y: 0 }]]);
  assert.deepEqual(d.units.appeared.map((u) => [u.type, u.x, u.y]), [["UNIT_SETTLER", 1, 2]]);
  assert.deepEqual(d.units.gone.map((u) => u.type), ["UNIT_SCOUT"]);
});

test("settlements are matched by plot, so a capture is a capture, not a loss plus a founding", () => {
  const b = world();
  b.cities = [
    { i: 1, owner: 0, id: 100, name: "Rome", pop: 4 },
    { i: 5, owner: 0, id: 555, name: "Nineveh", pop: 2 },
    { i: 10, owner: 1, id: 201, name: "Ashur", pop: 1 },
  ];
  const d = diffWorlds(world(), b);
  assert.deepEqual(d.cities.captured.map((c) => [c.name, c.from, c.owner]), [["Nineveh", 1, 0]]);
  assert.deepEqual(d.cities.grew.map((c) => [c.name, c.popFrom, c.pop]), [["Rome", 3, 4]]);
  assert.deepEqual(d.cities.founded.map((c) => c.name), ["Ashur"]);
  assert.equal(d.cities.lost.length, 0);
});

test("different map sizes are refused rather than diffed", () => {
  assert.throws(() => diffWorlds(world(), world({ w: 5, t: new Array(15).fill(0) })), /different games/);
});

test("the snapshot store saves, loads, lists and rejects unsafe names", () => {
  const store = new SnapshotStore(fs.mkdtempSync(path.join(os.tmpdir(), "tb-snap-")));
  store.save("before", world());
  store.save("after", world({ turn: 12 }));
  assert.equal(store.load("after").turn, 12);
  assert.deepEqual(store.list().map((s) => s.label), ["before", "after"]);
  assert.throws(() => store.save("../escape", world()), /names use/);
  assert.throws(() => store.load("missing"), /no snapshot named "missing"/);
});
