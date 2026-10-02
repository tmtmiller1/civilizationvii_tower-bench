import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { performWrite } from "../lib/engine-write.mjs";

// A fake of the engine globals the game-state actions use. Every change applies after `delay` ms, or
// never when delay is null; `broken` names engine calls that throw. Player 0 is local, player 1 an AI.
function fakeEngine({ delay = 40, broken = [], scale = 1 } = {}) {
  const later = (fn) => { if (delay !== null) setTimeout(fn, delay); };
  const guard = (name, fn) => (...a) => { if (broken.includes(name)) throw new Error(`${name} failed`); return fn(...a); };
  const table = (rows, key) => Object.assign(rows, {
    lookup: (v) => rows.find((r) => r.$index === v || r[key] === v || r.$hash === v) ?? null,
  });
  const YieldTypes = {
    YIELD_FOOD: 0, YIELD_PRODUCTION: 1, YIELD_GOLD: 2, YIELD_SCIENCE: 3, YIELD_CULTURE: 4,
    YIELD_HAPPINESS: 5, YIELD_DIPLOMACY: 6,
  };
  const nodes = table([
    { ProgressionTreeNodeType: "NODE_TECH_A", $hash: 101 }, { ProgressionTreeNodeType: "NODE_TECH_B", $hash: 102 },
    { ProgressionTreeNodeType: "NODE_CIVIC_A", $hash: 201 },
  ], "ProgressionTreeNodeType");
  const tree = (order) => ({ order, active: 0, progress: 0, unlocked: new Set(), cost: 100 });
  const mkPlayer = (id) => ({
    gold: 100, influence: 10, happy: 40, threshold: 100, wild: 0,
    trees: { tech: tree([101, 102]), civic: tree([201]) },
    units: new Map(), cities: new Map(),
    id,
  });
  const players = new Map([[0, mkPlayer(0)], [1, mkPlayer(1)]]);
  const unitTypes = table([{ $index: 0, UnitType: "UNIT_WARRIOR", Domain: "DOMAIN_LAND" },
    { $index: 1, UnitType: "UNIT_ARMY_COMMANDER", Domain: "DOMAIN_LAND" }], "UnitType");
  let nextId = 50;
  const addUnit = (owner, type, x, y, extra = {}) => {
    const u = { owner, id: nextId++, type, x, y, damage: 0, maxDamage: 100, xp: 0, promotions: 0, moves: 0, maxMoves: 2,
      ...extra };
    players.get(owner).units.set(u.id, u);
    return u;
  };
  const cid = (u) => ({ owner: u.owner, id: u.id, type: 1 });
  const unitAt = (c) => players.get(c?.owner)?.units.get(c?.id);
  const city = { owner: 0, id: 7, x: 3, y: 3, population: 4, pending: 0, item: 900, progress: 10, required: 50,
    empty: false };
  players.get(0).cities.set(7, city);
  const owners = new Map([["4,3", { owner: 0, city: 7 }], ["5,5", { owner: 1, city: 9 }]]);
  const revealed = new Set(["0,0"]);
  const W = 8;
  const H = 6;
  const treeOf = (p, type) => (type === "TREE_TECH" ? p.trees.tech : p.trees.civic);
  const grantNode = (t, n) => {
    t.progress += n;
    if (t.progress >= t.cost) { t.unlocked.add(t.order[t.active]); t.active += 1; t.progress = 0; }
  };
  const grant = (pid, y, n) => later(() => {
    const p = players.get(pid);
    if (y === YieldTypes.YIELD_GOLD) p.gold += n;
    if (y === YieldTypes.YIELD_DIPLOMACY) p.influence += n;
    if (y === YieldTypes.YIELD_HAPPINESS) p.happy += n;
    if (y === YieldTypes.YIELD_SCIENCE && n > 0) grantNode(p.trees.tech, n);
    if (y === YieldTypes.YIELD_CULTURE && n > 0) grantNode(p.trees.civic, n);
  });
  const playerApi = (p) => ({
    Treasury: { get goldBalance() { return p.gold; } },
    DiplomacyTreasury: { get diplomacyBalance() { return p.influence; } },
    Stats: { getLifetimeYield: (y) => (y === YieldTypes.YIELD_HAPPINESS ? p.happy : 0) },
    Happiness: { get nextGoldenAgeThreshold() { return p.threshold; } },
    Identity: {
      getWildcardPoints: () => p.wild,
      addWildcardAttributePoints: guard("addWildcardAttributePoints", (n) => later(() => { p.wild += n; })),
    },
    Techs: {
      getTreeType: () => "TREE_TECH", getNodeCost: () => p.trees.tech.cost,
      isNodeUnlocked: (n) => p.trees.tech.unlocked.has(nodes.lookup(n)?.$hash),
    },
    Culture: {
      getActiveTree: () => "TREE_CIVIC", getNodeCost: () => p.trees.civic.cost,
      isNodeUnlocked: (n) => p.trees.civic.unlocked.has(nodes.lookup(n)?.$hash),
    },
    Units: { getUnitIds: () => [...p.units.values()].map(cid) },
    Cities: { getCities: () => [...p.cities.values()].map((c) => ({ id: { owner: c.owner, id: c.id, type: 2 } })) },
  });
  const cityApi = (c) => ({
    location: { x: c.x, y: c.y },
    get population() { return c.population; },
    get pendingPopulation() { return c.pending; },
    BuildQueue: {
      get currentProductionTypeHash() { return c.item; }, get currentBuildProgress() { return c.progress; },
      get currentBuildProgressRequired() { return c.required; }, get isEmpty() { return c.empty; },
      addProgress: guard("addProgress", (n) => later(() => {
        c.progress = Math.max(0, c.progress + n * scale);
        if (c.progress >= c.required) { c.item += 1; c.progress = 0; }
      })),
    },
    addRuralPopulation: (n) => later(() => { c.pending += n; }),
    purchasePlot: ({ x, y }) => later(() => owners.set(`${x},${y}`, { owner: c.owner, city: c.id })),
  });
  const sent = [];
  const g = {
    GameContext: { localPlayerID: 0 },
    YieldTypes,
    RevealedStates: { HIDDEN: 0, REVEALED: 1, VISIBLE: 2 },
    UnitCommandTypes: { PROMOTE: "UNITCOMMAND_PROMOTE" },
    PlayerOperationTypes: { SET_TECH_TREE_NODE: "SET_TECH_TREE_NODE", SET_CULTURE_TREE_NODE: "SET_CULTURE_TREE_NODE" },
    Database: { makeHash: (s) => s.length },
    Players: {
      get: (id) => (players.has(id) ? playerApi(players.get(id)) : null),
      grantYield: guard("grantYield", grant),
    },
    Game: {
      turn: 3,
      ProgressionTrees: {
        getTree: (pid, type) => {
          const t = treeOf(players.get(pid), type);
          const activeNodeIndex = t.active < t.order.length ? t.active : -1;
          return { activeNodeIndex, nodes: t.order.map((n) => ({ nodeType: n })) };
        },
        getNode: (pid, n) => {
          const p = players.get(pid);
          const t = p.trees.tech.order.includes(n) ? p.trees.tech : p.trees.civic;
          const progress = t.order[t.active] === n ? t.progress : 0;
          return { nodeType: n, progress, depthUnlocked: t.unlocked.has(n) ? 1 : 0 };
        },
      },
      PlayerOperations: {
        canStart: () => ({ Success: true }),
        sendRequest: guard("sendRequest", (local, kind, req) => {
          sent.push({ local, kind, req });
          const at = req.Location;
          if (kind === "CREATE_ELEMENT" && req.Kind === "UNIT") later(() => addUnit(req.Owner, unitTypes.lookup(req.Type).$index, at.x, at.y));
          if (kind === "DESTROY_ELEMENT" && req.Kind === "UNIT") later(() => players.get(req.Owner).units.delete(req.LocalID));
          if (kind.startsWith("SET_")) {
            later(() => {
              const t = kind === "SET_TECH_TREE_NODE" ? players.get(local).trees.tech : players.get(local).trees.civic;
              t.active = t.order.indexOf(req.ProgressionTreeNodeType);
            });
          }
          return true;
        }),
      },
      UnitCommands: {
        canStart: () => ({ Success: true }),
        sendRequest: (c, kind) => { if (kind === "UNITCOMMAND_PROMOTE") later(() => { unitAt(c).promotions += 1; }); },
      },
    },
    GameInfo: {
      Units: unitTypes,
      ProgressionTreeNodes: nodes,
      UnitPromotions: table([{ UnitPromotionType: "PROMOTION_X" }], "UnitPromotionType"),
      UnitPromotionDisciplines: table([{ UnitPromotionDisciplineType: "DISCIPLINE_X" }], "UnitPromotionDisciplineType"),
    },
    Units: {
      get: (c) => {
        const u = unitAt(c);
        return u ? {
          type: u.type, location: { x: u.x, y: u.y },
          Health: {
            get damage() { return u.damage; },
            maxDamage: u.maxDamage,
            damageUnit: (n) => later(() => { u.damage += n; }),
          },
          Experience: {
            get experiencePoints() { return u.xp; }, get getTotalPromotionsEarned() { return u.promotions; },
          },
          Movement: { get movementMovesRemaining() { return u.moves; }, maxMoves: u.maxMoves },
        } : null;
      },
      setDamage: (c, n) => later(() => { unitAt(c).damage = n; }),
      changeExperience: (c, n) => later(() => { unitAt(c).xp = Math.max(0, unitAt(c).xp + n); }),
      restoreMovement: (c) => later(() => { unitAt(c).moves = unitAt(c).maxMoves; }),
    },
    Cities: { get: (c) => (c?.owner === city.owner && c?.id === city.id ? cityApi(city) : null) },
    MapUnits: {
      getUnits: (x, y) => [...players.values()].flatMap((p) => [...p.units.values()])
        .filter((u) => u.x === x && u.y === y).map(cid),
    },
    MapCities: {
      getCity: (x, y) => (Math.abs(x - city.x) <= 1 && Math.abs(y - city.y) <= 1
        ? { owner: city.owner, id: city.id, type: 2 } : null),
    },
    GameplayMap: {
      getGridWidth: () => W,
      getGridHeight: () => H,
      isValidLocation: ({ x, y }) => x >= 0 && y >= 0 && x < W && y < H,
      isWater: (x) => x === 7,
      getRevealedState: (pid, x, y) => (revealed.has(`${x},${y}`) ? 1 : 0),
      getOwner: (x, y) => owners.get(`${x},${y}`)?.owner ?? -1,
      getOwningCityFromXY: (x, y) => {
        const o = owners.get(`${x},${y}`);
        return o ? { owner: o.owner, id: o.city, type: 2 } : null;
      },
    },
    WorldBuilder: { MapPlots: { setRevealed: (pid, { x, y }) => later(() => revealed.add(`${x},${y}`)) } },
    Visibility: {
      revealAllPlots: () => later(() => { for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) revealed.add(`${x},${y}`); }),
    },
  };
  return { g, players, city, owners, revealed, sent, addUnit };
}

let saved = null;
function install(fake) {
  saved = {};
  for (const [k, v] of Object.entries(fake.g)) { saved[k] = globalThis[k]; globalThis[k] = v; }
  return fake;
}
afterEach(() => { if (saved) for (const [k, v] of Object.entries(saved)) globalThis[k] = v; saved = null; });

// Everything runs through the serialised bundle, exactly as the game receives it: this also proves the
// bundle holds no outer references.
const bundled = new Function(`return (${performWrite.toString()})`)();
const run = (op, args, waitMs = 1500) => bundled({ op, args, waitMs, settleMs: waitMs });

test("the serialised performWrite still runs map writes and refuses unknown ops", async () => {
  install(fakeEngine());
  const r = await run("nuke.drop", { player: 0 });
  assert.equal(r.verdict, "REFUSED");
});

test("an unknown player is refused before anything is sent", async () => {
  const f = install(fakeEngine());
  for (const op of ["player.yield", "unit.heal", "city.grow", "map.reveal"]) {
    const r = await run(op, { player: 99, yield: "YIELD_GOLD", amount: 5, unit: 1, city: 7 });
    assert.equal(r.verdict, "REFUSED", op);
    assert.match(r.reason, /player 99 does not exist/);
  }
  assert.equal(f.sent.length, 0);
});

test("player.yield gold lands with its inverse; the inverse takes it back", async () => {
  const f = install(fakeEngine());
  const r = await run("player.yield", { player: 1, yield: "YIELD_GOLD", amount: 25 });
  assert.equal(r.verdict, "LANDED");
  assert.equal(r.before, 100);
  assert.equal(r.after, 125);
  assert.deepEqual(r.inverse, { op: "player.yield", args: { player: 1, yield: "YIELD_GOLD", amount: -25 } });
  assert.equal(r.undoable, true);
  const u = await bundled({ ...r.inverse, waitMs: 1500, settleMs: 1500 });
  assert.equal(u.verdict, "LANDED");
  assert.equal(f.players.get(1).gold, 100);
});

test("player.yield influence and happiness move both ways; science only adds and has no inverse", async () => {
  install(fakeEngine());
  assert.equal((await run("player.yield", { player: 0, yield: "YIELD_DIPLOMACY", amount: -20 })).after, -10);
  assert.equal((await run("player.yield", { player: 0, yield: "YIELD_HAPPINESS", amount: 5 })).verdict, "LANDED");
  const sci = await run("player.yield", { player: 0, yield: "YIELD_SCIENCE", amount: 30 });
  assert.equal(sci.verdict, "LANDED");
  assert.equal(sci.after.progress, 30);
  assert.equal(sci.inverse, null);
  assert.equal(sci.undoable, false);
});

test("player.yield refuses what was watched doing nothing", async () => {
  const f = install(fakeEngine());
  assert.match((await run("player.yield", { player: 0, yield: "YIELD_FOOD", amount: 5 })).reason, /Food or Production/);
  assert.match((await run("player.yield", { player: 0, yield: "YIELD_CULTURE", amount: -5 })).reason, /only adds/);
  assert.match((await run("player.yield", { player: 0, yield: "YIELD_FAITH", amount: 5 })).reason, /unknown yield/);
  assert.equal(f.sent.length, 0);
});

test("a grant the engine never applies is NO EFFECT; one that throws is THREW", async () => {
  install(fakeEngine({ delay: null }));
  const none = await run("player.yield", { player: 0, yield: "YIELD_GOLD", amount: 5 }, 150);
  assert.equal(none.verdict, "NO EFFECT");
  assert.equal(none.inverse, null);
  install(fakeEngine({ broken: ["grantYield"] }));
  const threw = await run("player.yield", { player: 0, yield: "YIELD_GOLD", amount: 5 });
  assert.equal(threw.verdict, "THREW");
  assert.match(threw.reason, /grantYield failed/);
});

test("a value that moves the wrong way is UNEXPECTED", async () => {
  const f = install(fakeEngine({ delay: null }));
  setTimeout(() => { f.players.get(0).gold -= 3; }, 30);
  const r = await run("player.yield", { player: 0, yield: "YIELD_GOLD", amount: 5 }, 150);
  assert.equal(r.verdict, "UNEXPECTED");
  assert.equal(r.inverse, null);
});

test("player.celebrate grants the gap to the threshold, undoably; a full meter is ALREADY", async () => {
  const f = install(fakeEngine());
  const r = await run("player.celebrate", { player: 0 });
  assert.equal(r.verdict, "LANDED");
  assert.equal(r.granted, 60);
  assert.deepEqual(r.inverse, { op: "player.yield", args: { player: 0, yield: "YIELD_HAPPINESS", amount: -60 } });
  assert.equal(f.players.get(0).happy, 100);
  assert.equal((await run("player.celebrate", { player: 0 })).verdict, "ALREADY");
});

test("player.attribute lands without an inverse and reports a missing engine call", async () => {
  install(fakeEngine());
  const r = await run("player.attribute", { player: 0, amount: 2 });
  assert.equal(r.verdict, "LANDED");
  assert.equal(r.after, 2);
  assert.equal(r.inverse, null);
  install(fakeEngine({ broken: ["addWildcardAttributePoints"] }));
  assert.equal((await run("player.attribute", { player: 0, amount: 1 })).verdict, "THREW");
});

test("unit.heal by id lands, and its inverse damages the unit back", async () => {
  const f = install(fakeEngine());
  const u = f.addUnit(1, 0, 2, 2, { damage: 30 });
  const r = await run("unit.heal", { player: 1, unit: u.id });
  assert.equal(r.verdict, "LANDED");
  assert.equal(r.after.damage, 0);
  assert.deepEqual(r.inverse, { op: "unit.damage", args: { player: 1, unit: u.id, amount: 30 } });
  const back = await bundled({ ...r.inverse, waitMs: 1500 });
  assert.equal(back.verdict, "LANDED");
  assert.equal(u.damage, 30);
  assert.equal((await run("unit.heal", { player: 1, x: 9, y: 9 })).verdict, "REFUSED");
});

test("unit.heal on a healthy unit is ALREADY; unit.damage refuses a killing blow", async () => {
  const f = install(fakeEngine());
  const u = f.addUnit(0, 0, 1, 1, { damage: 90 });
  const healthy = f.addUnit(0, 0, 1, 2);
  assert.equal((await run("unit.heal", { player: 0, x: 1, y: 2 })).verdict, "ALREADY");
  assert.match((await run("unit.damage", { player: 0, unit: u.id, amount: 10 })).reason, /would kill/);
  const d = await run("unit.damage", { player: 0, unit: healthy.id, amount: 15 });
  assert.equal(d.verdict, "LANDED");
  assert.deepEqual(d.inverse, { op: "unit.heal", args: { player: 0, unit: healthy.id, to: 0 } });
});

test("unit.xp changes or sets experience, with no inverse; a zero change is ALREADY", async () => {
  const f = install(fakeEngine());
  const u = f.addUnit(0, 0, 1, 1, { xp: 5 });
  const r = await run("unit.xp", { player: 0, unit: u.id, to: 40 });
  assert.equal(r.verdict, "LANDED");
  assert.equal(r.delta, 35);
  assert.equal(r.after.xp, 40);
  assert.equal(r.inverse, null);
  assert.equal((await run("unit.xp", { player: 0, unit: u.id, to: 40 })).verdict, "ALREADY");
});

test("unit.promote is local-only and checks its rows; it lands on the promotion count", async () => {
  const f = install(fakeEngine());
  const mine = f.addUnit(0, 1, 1, 1);
  const theirs = f.addUnit(1, 1, 2, 1);
  const args = { player: 0, unit: mine.id, promotion: "PROMOTION_X", discipline: "DISCIPLINE_X" };
  const r = await run("unit.promote", args);
  assert.equal(r.verdict, "LANDED");
  assert.deepEqual(r.canStart, { Success: true });
  assert.match((await run("unit.promote", { ...args, player: 1, unit: theirs.id })).reason, /local player/);
  assert.match((await run("unit.promote", { ...args, promotion: "PROMOTION_NOPE" })).reason, /unknown promotion/);
});

test("unit.moves restores movement; a unit already at full movement is ALREADY", async () => {
  const f = install(fakeEngine());
  const u = f.addUnit(0, 0, 1, 1);
  const r = await run("unit.moves", { player: 0, unit: u.id });
  assert.equal(r.verdict, "LANDED");
  assert.equal(r.after.moves, 2);
  assert.equal((await run("unit.moves", { player: 0, unit: u.id })).verdict, "ALREADY");
});

test("unit.move recreates the unit at the target and can move it back", async () => {
  const f = install(fakeEngine());
  const u = f.addUnit(1, 0, 1, 1);
  const r = await run("unit.move", { player: 1, unit: u.id, toX: 4, toY: 1 });
  assert.equal(r.verdict, "LANDED");
  assert.equal(f.players.get(1).units.has(u.id), false);
  const fresh = [...f.players.get(1).units.values()][0];
  assert.equal(fresh.x, 4);
  assert.deepEqual(r.inverse, { op: "unit.move", args: { player: 1, unit: fresh.id, toX: 1, toY: 1 } });
  assert.deepEqual(f.sent.map((s) => [s.local, s.kind, s.req.Owner]), [[0, "CREATE_ELEMENT", 1], [0, "DESTROY_ELEMENT", 1]],
    "sent as the local player, naming the owner");
  assert.match((await run("unit.move", { player: 1, unit: fresh.id, toX: 7, toY: 1 })).reason, /water plot/);
  assert.match((await run("unit.move", { player: 1, unit: fresh.id, toX: 40, toY: 1 })).reason, /not on the map/);
});

test("unit.move keeps the old unit when the new one never appears", async () => {
  const f = install(fakeEngine({ delay: null }));
  const u = f.addUnit(0, 0, 1, 1);
  const r = await run("unit.move", { player: 0, unit: u.id, toX: 4, toY: 1 }, 120);
  assert.equal(r.verdict, "NO EFFECT");
  assert.match(r.returned, /old one was kept/);
  assert.equal(f.sent.filter((s) => s.kind === "DESTROY_ELEMENT").length, 0);
});

test("unit.kill destroys the unit and records a unit.place to undo it", async () => {
  const f = install(fakeEngine());
  const u = f.addUnit(1, 0, 2, 4);
  const r = await run("unit.kill", { player: 1, x: 2, y: 4 });
  assert.equal(r.verdict, "LANDED");
  assert.equal(r.after, null);
  assert.deepEqual(r.inverse, { op: "unit.place", args: { x: 2, y: 4, owner: 1, type: "UNIT_WARRIOR" } });
  assert.equal(f.players.get(1).units.has(u.id), false);
});

test("city.production adds progress and offers the opposite while the item is unchanged", async () => {
  install(fakeEngine());
  const r = await run("city.production", { player: 0, city: 7, amount: 20 });
  assert.equal(r.verdict, "LANDED");
  assert.equal(r.after.progress, 30);
  assert.deepEqual(r.inverse, { op: "city.production", args: { player: 0, city: 7, amount: -20 } });
  const by = await run("city.production", { player: 0, x: 3, y: 3, amount: 5 });
  assert.equal(by.verdict, "LANDED", "a city is also found by its centre plot");
  assert.match((await run("city.production", { player: 0, x: 4, y: 3, amount: 5 })).reason, /no settlement centre/);
  assert.match((await run("city.production", { player: 1, city: 7, amount: 5 })).reason, /no city 7/);
});

test("city.production refuses an empty queue and a deduction from 0", async () => {
  const f = install(fakeEngine());
  f.city.progress = 0;
  assert.match((await run("city.production", { player: 0, city: 7, amount: -5 })).reason, /already 0/);
  f.city.empty = true;
  assert.match((await run("city.production", { player: 0, city: 7, amount: 5 })).reason, /queue is empty/);
});

test("city.complete finishes the item without an inverse; a weak city that only part-fills it is UNEXPECTED", async () => {
  install(fakeEngine());
  const r = await run("city.complete", { player: 0, city: 7 });
  assert.equal(r.verdict, "LANDED");
  assert.equal(r.granted, 40);
  assert.equal(r.inverse, null);
  install(fakeEngine({ scale: 0.5 }));
  assert.equal((await run("city.complete", { player: 0, city: 7 })).verdict, "UNEXPECTED");
});

test("city.grow adds a pending population point", async () => {
  install(fakeEngine());
  const r = await run("city.grow", { player: 0, city: 7 });
  assert.equal(r.verdict, "LANDED");
  assert.equal(r.after.pending, 1);
  assert.equal(r.inverse, null);
});

test("progress.complete grants the remaining cost and lands when the node moves on", async () => {
  const f = install(fakeEngine());
  f.players.get(1).trees.tech.progress = 70;
  const r = await run("progress.complete", { player: 1, tree: "tech" });
  assert.equal(r.verdict, "LANDED");
  assert.equal(r.granted, 30);
  assert.equal(r.after.name, "NODE_TECH_B");
  f.players.get(0).trees.civic.active = 1;
  assert.match((await run("progress.complete", { player: 0, tree: "civic" })).reason, /nothing is being researched/);
});

test("progress.grant chooses the node, grants its cost and is local-only", async () => {
  const f = install(fakeEngine());
  const r = await run("progress.grant", { player: 0, tree: "tech", node: "NODE_TECH_B" });
  assert.equal(r.verdict, "LANDED");
  assert.equal(r.after.unlocked, true);
  assert.equal(f.sent[0].kind, "SET_TECH_TREE_NODE");
  assert.equal((await run("progress.grant", { player: 0, tree: "tech", node: "NODE_TECH_B" })).verdict, "ALREADY");
  assert.match((await run("progress.grant", { player: 1, tree: "tech", node: "NODE_TECH_A" })).reason, /local player/);
  assert.match((await run("progress.grant", { player: 0, tree: "tech", node: "NODE_NOPE" })).reason, /unknown node/);
});

test("map.reveal reveals one plot or the whole map, without an inverse", async () => {
  install(fakeEngine());
  assert.equal((await run("map.reveal", { player: 0, x: 0, y: 0 })).verdict, "ALREADY");
  const one = await run("map.reveal", { player: 1, x: 2, y: 2 });
  assert.equal(one.verdict, "LANDED");
  assert.equal(one.inverse, null);
  const all = await run("map.reveal", { player: 0 });
  assert.equal(all.verdict, "LANDED");
  assert.equal(all.after, 0);
  assert.ok(all.sampled > 0);
});

test("map.owner buys a plot for a city; giving it back is offered only when another city held it", async () => {
  const f = install(fakeEngine());
  const r = await run("map.owner", { player: 0, city: 7, x: 5, y: 5 });
  assert.equal(r.verdict, "LANDED");
  assert.deepEqual(r.inverse, { op: "map.owner", args: { x: 5, y: 5, player: 1, city: 9 } });
  const free = await run("map.owner", { player: 0, city: 7, x: 1, y: 4 });
  assert.equal(free.verdict, "LANDED");
  assert.equal(free.inverse, null, "an unowned plot cannot be released again");
  assert.equal((await run("map.owner", { player: 0, city: 7, x: 4, y: 3 })).verdict, "ALREADY");
  assert.match((await run("map.owner", { player: 0, city: 7, x: 3, y: 3 })).reason, /centre/);
  assert.equal(f.owners.get("1,4").owner, 0);
});
