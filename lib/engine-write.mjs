// Runs INSIDE the game's UI context, like everything in engine.mjs: CdpSession.call serialises it
// with toString(), so it must stay self-contained.

import { CHEAT_OPS } from "./cheats.mjs";
import { performCheat } from "./engine-cheats.mjs";

// One write, verified. Sends the request, then re-reads the plot until the intended change is
// observed or waitMs passes. The engine's own return value is recorded but never trusted:
// sendRequest is fire-and-forget and canStart checks request shape, not placement.
export async function performMapWrite({ op, args, waitMs }) {
  /** @type {(f: () => any, d?: any) => any} */
  const safe = (f, d = null) => { try { return f(); } catch { return d; } };
  const typeName = (table, key, v) => safe(() => GameInfo[table].lookup(v)?.[key] ?? null);
  const local = GameContext.localPlayerID;
  const loc = { x: args.x, y: args.y };
  const refuse = (reason) => ({ verdict: "REFUSED", reason, sent: false });

  const unitsAt = () => (safe(() => MapUnits.getUnits(loc.x, loc.y), []) || []).map((id) => ({
    owner: id.owner, id: id.id, type: typeName("Units", "UnitType", safe(() => Units.get(id)?.type)),
  }));
  // Only the centre plot holds the settlement; getCity also answers for every plot the city owns, so
  // without this check "remove the town at a territory plot" would destroy the whole city.
  const cityAt = () => {
    const c = safe(() => MapCities.getCity(loc.x, loc.y));
    const l = c ? safe(() => Cities.get(c).location) : null;
    return l && l.x === loc.x && l.y === loc.y ? { owner: c.owner, id: c.id } : null;
  };
  const plot = () => ({
    terrain: typeName("Terrains", "TerrainType", safe(() => GameplayMap.getTerrainType(loc.x, loc.y))),
    feature: typeName("Features", "FeatureType", safe(() => GameplayMap.getFeatureType(loc.x, loc.y))),
    resource: typeName("Resources", "ResourceType", safe(() => GameplayMap.getResourceType(loc.x, loc.y))),
    city: cityAt(),
    units: unitsAt(),
    water: safe(() => GameplayMap.isWater(loc.x, loc.y), null),
  });
  const withBlock = (f) => {
    const block = typeof WorldBuilder.startBlock === "function";
    if (block) WorldBuilder.startBlock();
    try { return f(); } finally { if (block) WorldBuilder.endBlock(); }
  };
  // An invalid player id passed to some engine calls segfaults the game, so ids are resolved first.
  const playerOk = (id) => Number.isInteger(id) && !!safe(() => Players.get(id));
  const requestAs = (kind, req) => ({
    send: () => Game.PlayerOperations.sendRequest(local, kind, req),
    canStart: () => safe(() => JSON.parse(JSON.stringify(Game.PlayerOperations.canStart(local, kind, req, false)))),
  });

  const setLayer = (before, isFeature) => {
    const [table, key, field] = isFeature ? ["Features", "FeatureType", "feature"] : ["Resources", "ResourceType", "resource"];
    const clear = args.type == null;
    const row = clear ? null : safe(() => GameInfo[table].lookup(args.type));
    if (!clear && !row) return `unknown ${field} ${args.type}`;
    const want = clear ? null : row[key];
    const idx = clear ? (isFeature ? FeatureTypes.NO_FEATURE : ResourceTypes.NO_RESOURCE) : row.$index;
    const write = isFeature
      ? () => WorldBuilder.MapPlots.setFeature(idx, loc)
      : () => WorldBuilder.MapPlots.setResource(idx, loc, clear ? 0 : (args.amount ?? 1));
    return {
      action: { send: () => withBlock(write) },
      landed: () => plot()[field] === want,
      inverse: () => ({ op, args: { x: loc.x, y: loc.y, type: before[field] } }),
    };
  };
  // Each operation checks the request against the plot as it was and returns the action, the test that
  // it landed and the write that undoes it, or a string: the reason it is refused.
  const OPS = {
    "unit.place": (before) => {
      if (!playerOk(args.owner)) return `player ${args.owner} does not exist`;
      const row = safe(() => GameInfo.Units.lookup(args.type));
      if (!row) return `unknown unit type ${args.type}`;
      const had = new Set(before.units.map((u) => `${u.owner}:${u.id}`));
      const fresh = () => unitsAt().find((u) => !had.has(`${u.owner}:${u.id}`)
        && u.owner === args.owner && u.type === row.UnitType);
      return {
        action: requestAs("CREATE_ELEMENT", { Kind: "UNIT", Type: row.UnitType, Location: loc, Owner: args.owner }),
        extra: { unitDomain: row.Domain ?? null },
        landed: () => !!fresh(),
        inverse: () => {
          const u = fresh();
          return u ? { op: "unit.remove", args: { x: loc.x, y: loc.y, owner: u.owner, id: u.id } } : null;
        },
      };
    },
    "unit.remove": (before) => {
      const target = before.units.find((u) => (args.id == null || u.id === args.id)
        && (args.owner == null || u.owner === args.owner));
      if (!target) return "no matching unit on that plot";
      return {
        action: requestAs("DESTROY_ELEMENT", { Kind: "UNIT", Owner: target.owner, LocalID: target.id }),
        landed: () => !unitsAt().some((u) => u.owner === target.owner && u.id === target.id),
        inverse: () => (target.type
          ? { op: "unit.place", args: { x: loc.x, y: loc.y, owner: target.owner, type: target.type } } : null),
      };
    },
    "town.place": (before) => {
      if (!playerOk(args.owner)) return `player ${args.owner} does not exist`;
      if (before.city) return "there is already a settlement on that plot";
      return {
        action: requestAs("CREATE_ELEMENT", { Kind: "CITY", Location: loc, Owner: args.owner }),
        landed: () => cityAt()?.owner === args.owner,
        inverse: () => ({ op: "town.remove", args: { x: loc.x, y: loc.y } }),
      };
    },
    "town.remove": (before) => {
      const c = before.city;
      if (!c) return "no settlement on that plot";
      return {
        action: requestAs("DESTROY_ELEMENT", { Kind: "CITY", Owner: c.owner, LocalID: c.id }),
        landed: () => !cityAt(),
        inverse: () => ({ op: "town.place", args: { x: loc.x, y: loc.y, owner: c.owner } }),
      };
    },
    "terrain.set": (before) => {
      const row = safe(() => GameInfo.Terrains.lookup(args.type));
      if (!row) return `unknown terrain ${args.type}`;
      return {
        action: { send: () => withBlock(() => WorldBuilder.MapPlots.setTerrain(row.$index, loc)) },
        landed: () => plot().terrain === row.TerrainType,
        inverse: () => ({ op: "terrain.set", args: { x: loc.x, y: loc.y, type: before.terrain } }),
      };
    },
    "feature.set": (before) => setLayer(before, true),
    "resource.set": (before) => setLayer(before, false),
  };
  const verify = async (spec, before) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const poll = async (t0) => {
      while (Date.now() - t0 < waitMs) {
        if (spec.landed()) return Date.now() - t0;
        await sleep(50);
      }
      return null;
    };
    // Not what was asked, but not nothing either: e.g. setFeature with a feature the plot cannot hold
    // clears the existing one. Report it, and record how to put the plot back as it was.
    const restore = () => {
      const key = { "terrain.set": "terrain", "feature.set": "feature", "resource.set": "resource" }[op];
      return key ? { op, args: { x: loc.x, y: loc.y, type: before[key] } } : null;
    };
    const canStart = spec.action.canStart ? spec.action.canStart() : undefined;
    const t0 = Date.now();
    let returned;
    try {
      returned = spec.action.send();
    } catch (e) {
      return { verdict: "THREW", reason: String(e), sent: true, canStart, before, after: plot() };
    }
    const landedMs = await poll(t0);
    const after = plot();
    const changed = !landedMs && JSON.stringify(after) !== JSON.stringify(before);
    return {
      verdict: landedMs !== null ? "LANDED" : changed ? "UNEXPECTED" : "NO EFFECT",
      landedMs,
      waitedMs: Date.now() - t0,
      sent: true,
      returned: returned === undefined ? null : returned,
      canStart,
      before,
      after,
      inverse: landedMs !== null ? spec.inverse() : changed ? restore() : null,
      ...(spec.extra ?? {}),
    };
  };
  const start = (before) => {
    if (!Object.prototype.hasOwnProperty.call(OPS, op)) return refuse(`unknown operation ${op}`);
    const spec = OPS[op](before);
    if (typeof spec === "string") return refuse(spec);
    if (spec.landed()) {
      return { verdict: "ALREADY", reason: "the plot already has that state; nothing was sent", sent: false, before, after: before };
    }
    return verify(spec, before);
  };

  if (!safe(() => GameplayMap.isValidLocation(loc), false)) return refuse(`(${loc.x}, ${loc.y}) is not on the map`);
  return start(plot());
}

const CHEAT_NAMES = Object.keys(CHEAT_OPS);

// Map writes and game-state actions share Bench.write. In Node this dispatches by op; sent to the game,
// toString() gives one self-contained bundle holding both performers, so neither needs the other's code.
export async function performWrite(request) {
  return CHEAT_NAMES.includes(request.op) ? performCheat(request) : performMapWrite(request);
}
performWrite.toString = () => `async (request) => (${JSON.stringify(CHEAT_NAMES)}.includes(request.op)\n`
  + `  ? (${performCheat.toString()})\n  : (${performMapWrite.toString()}))(request)`;
