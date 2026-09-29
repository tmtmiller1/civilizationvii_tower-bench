import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { fnv1a } from "../lib/deploy.mjs";
import { performWrite, readServed, sampleWatches, worldSnapshot } from "../lib/engine.mjs";

// A fake of the engine globals the in-game functions use. Map writes apply after `delay` ms, or
// never when delay is null, which is how the verification loop's verdicts are exercised offline.
function fakeEngine({ delay = 100, w = 6, h = 4, featureClears = false, initial = {} } = {}) {
  const terrains = [{ $index: 0, TerrainType: "TERRAIN_FLAT" }, { $index: 1, TerrainType: "TERRAIN_COAST" }];
  const features = [{ $index: 0, FeatureType: "FEATURE_FOREST" }, { $index: 1, FeatureType: "FEATURE_SAGEBRUSH_STEPPE" }];
  const table = (rows, key) =>
    Object.assign(rows, { lookup: (v) => rows.find((r) => r.$index === v || r[key] === v) ?? null });
  const plots = new Map(Object.entries(initial));
  const plot = (x, y) => plots.get(`${x},${y}`) ?? { t: 0, f: -1, r: -1, o: -1 };
  const later = (fn) => { if (delay !== null) setTimeout(fn, delay); };
  const g = {
    GameContext: { localPlayerID: 0 },
    Game: { turn: 7, PlayerOperations: { sendRequest: () => true, canStart: () => ({ Success: true }) } },
    GameInfo: {
      Terrains: table(terrains, "TerrainType"),
      Features: table(features, "FeatureType"),
      Resources: table([], "ResourceType"),
      Biomes: table([], "BiomeType"),
      Units: table([], "UnitType"),
    },
    FeatureTypes: { NO_FEATURE: -1 },
    ResourceTypes: { NO_RESOURCE: -1 },
    DirectionTypes: { DIRECTION_NORTHEAST: 5 },
    Players: { get: (id) => (id === 0 || id === 1 ? { name: `P${id}`, isMajor: true, Treasury: { goldBalance: 12.4 } } : null), getAliveIds: () => [0, 1] },
    GameplayMap: {
      getGridWidth: () => w,
      getGridHeight: () => h,
      isValidLocation: ({ x, y }) => x >= 0 && y >= 0 && x < w && y < h,
      getTerrainType: (x, y) => plot(x, y).t,
      getFeatureType: (x, y) => plot(x, y).f,
      getResourceType: (x, y) => plot(x, y).r,
      getBiomeType: () => -1,
      getOwner: (x, y) => plot(x, y).o,
      // odd-r layout with north = y + 1, the shape the map view expects by default
      getAdjacentPlotLocation: ({ x, y }) => ({ x: y % 2 === 1 ? x + 1 : x, y: y + 1 }),
    },
    WorldBuilder: {
      startBlock: () => {},
      endBlock: () => {},
      MapPlots: {
        setTerrain: (idx, { x, y }) => later(() => plots.set(`${x},${y}`, { ...plot(x, y), t: idx })),
        // featureClears reproduces 1.5.0 in normal play: placement is refused and the old feature is removed.
        setFeature: (idx, { x, y }) => later(() => plots.set(`${x},${y}`, { ...plot(x, y), f: featureClears ? -1 : idx })),
      },
    },
    MapUnits: { getUnits: () => [] },
    // Like the engine: the city answers for its centre and every plot it owns.
    MapCities: { getCity: (x, y) => (Math.abs(x - 3) <= 1 && Math.abs(y - 2) <= 1 ? { owner: 1, id: 777 } : null) },
    Units: { get: () => null },
    Cities: { get: (c) => (c?.id === 777 ? { name: "Nineveh", location: { x: 3, y: 2 }, population: 3 } : null) },
    Locale: { compose: (s) => s },
  };
  return g;
}

let saved;
function install(g) {
  saved = {};
  for (const [k, v] of Object.entries(g)) { saved[k] = globalThis[k]; globalThis[k] = v; }
}
beforeEach(() => { saved = null; });
afterEach(() => { if (saved) for (const [k, v] of Object.entries(saved)) globalThis[k] = v; });

test("a write that lands is LANDED with its time, and carries its inverse", async () => {
  install(fakeEngine({ delay: 120 }));
  const r = await performWrite({ op: "terrain.set", args: { x: 2, y: 1, type: "TERRAIN_COAST" }, waitMs: 2000 });
  assert.equal(r.verdict, "LANDED");
  assert.ok(r.landedMs >= 100 && r.landedMs < 1000, `landed in ${r.landedMs} ms`);
  assert.equal(r.before.terrain, "TERRAIN_FLAT");
  assert.equal(r.after.terrain, "TERRAIN_COAST");
  assert.deepEqual(r.inverse, { op: "terrain.set", args: { x: 2, y: 1, type: "TERRAIN_FLAT" } });
});

test("a write the engine accepts but never applies is NO EFFECT, with no inverse", async () => {
  install(fakeEngine({ delay: null }));
  const r = await performWrite({ op: "feature.set", args: { x: 0, y: 0, type: "FEATURE_FOREST" }, waitMs: 300 });
  assert.equal(r.verdict, "NO EFFECT");
  assert.equal(r.inverse, null);
  assert.ok(r.waitedMs >= 300);
});

test("a write that changes the plot, but not as asked, is UNEXPECTED and records how to put it back", async () => {
  install(fakeEngine({ featureClears: true, delay: 50, initial: { "3,2": { t: 0, f: 1, r: -1, o: -1 } } }));
  const r = await performWrite({ op: "feature.set", args: { x: 3, y: 2, type: "FEATURE_FOREST" }, waitMs: 400 });
  assert.equal(r.verdict, "UNEXPECTED");
  assert.equal(r.before.feature, "FEATURE_SAGEBRUSH_STEPPE");
  assert.equal(r.after.feature, null);
  assert.deepEqual(r.inverse, { op: "feature.set", args: { x: 3, y: 2, type: "FEATURE_SAGEBRUSH_STEPPE" } });
});

test("setting what is already there sends nothing", async () => {
  install(fakeEngine());
  const r = await performWrite({ op: "feature.set", args: { x: 0, y: 0, type: null }, waitMs: 300 });
  assert.equal(r.verdict, "ALREADY");
  assert.equal(r.sent, false);
});

test("an unknown player, an off-map plot and an unknown type are refused before anything is sent", async () => {
  const g = fakeEngine();
  let sent = 0;
  g.Game.PlayerOperations.sendRequest = () => { sent++; return true; };
  install(g);
  assert.equal((await performWrite({ op: "unit.place", args: { x: 1, y: 1, type: "UNIT_X", owner: 99 }, waitMs: 100 })).verdict, "REFUSED");
  assert.equal((await performWrite({ op: "terrain.set", args: { x: 50, y: 1, type: "TERRAIN_COAST" }, waitMs: 100 })).verdict, "REFUSED");
  assert.equal((await performWrite({ op: "terrain.set", args: { x: 1, y: 1, type: "TERRAIN_NOPE" }, waitMs: 100 })).verdict, "REFUSED");
  assert.equal(sent, 0);
});

test("the world snapshot reads the row shift and north from the engine", () => {
  install(fakeEngine({ w: 6, h: 4 }));
  const s = worldSnapshot();
  assert.equal(s.t.length, 24);
  assert.deepEqual(s.layout, { oddRowShift: true, northDy: 1 });
  assert.deepEqual(s.players.map((p) => p.gold), [12, 12]);
  assert.equal(s.names.terrains[1], "TERRAIN_COAST");
});

test("watches record values and errors; invariants pass only on exactly true", async () => {
  install(fakeEngine());
  const s = await sampleWatches({
    watches: [{ name: "turn", expr: "Game.turn" }, { name: "broken", expr: "nope.nope" }],
    invariants: [{ name: "ok", expr: "Game.turn > 0" }, { name: "truthy-not-true", expr: "1" }, { name: "throws", expr: "nope()" }],
  });
  assert.equal(s.turn, 7);
  assert.deepEqual(s.watches.turn, { value: 7 });
  assert.match(s.watches.broken.error, /nope/);
  assert.equal(s.invariants.ok.ok, true);
  assert.equal(s.invariants["truthy-not-true"].ok, false);
  assert.match(s.invariants.throws.detail, /threw/);
});

test("the page-side hash of served files matches the Node-side hash, read over XHR as in GameFace", async () => {
  const text = "export const x = 1;\nconsole.log('ünïcode');\n";
  const saved = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = class {
    open(method, url) { this.url = url; }
    send() { setTimeout(() => { this.status = this.url.endsWith("ok.js") ? 200 : 404; this.responseText = this.status === 200 ? text : ""; this.onload(); }, 5); }
  };
  try {
    const r = await readServed({ modId: "m", files: ["ok.js", "missing.js"] });
    assert.equal(r["ok.js"].hash, fnv1a(text));
    assert.equal(r["missing.js"].error, "HTTP 404");
  } finally {
    globalThis.XMLHttpRequest = saved;
  }
  assert.equal(fnv1a("abc"), "1a47e90b", "FNV-1a 32 reference value");
});

test("a city counts once, at its centre, though getCity answers for every plot it owns", () => {
  install(fakeEngine({ w: 6, h: 4 }));
  const snap = worldSnapshot();
  assert.deepEqual(snap.cities.map((c) => [c.i % 6, Math.floor(c.i / 6), c.name]), [[3, 2, "Nineveh"]]);
});

test("removing a town at a territory plot is refused, so it can never destroy the whole city", async () => {
  const g = fakeEngine();
  let sent = 0;
  g.Game.PlayerOperations.sendRequest = () => { sent++; return true; };
  install(g);
  const r = await performWrite({ op: "town.remove", args: { x: 4, y: 2 }, waitMs: 100 });
  assert.equal(r.verdict, "REFUSED");
  assert.match(r.reason, /no settlement on that plot/);
  assert.equal(sent, 0);
});
