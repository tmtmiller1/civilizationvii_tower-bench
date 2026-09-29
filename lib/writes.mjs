// Node-side knowledge about writes: what each operation is, what the engine is known to do with it,
// and the standalone code a mod would use to do the same thing.

export const OPS = {
  "unit.place": { label: "Place unit", needs: ["type", "owner"] },
  "unit.remove": { label: "Remove unit", needs: [] },
  "town.place": { label: "Found town", needs: ["owner"] },
  "town.remove": { label: "Remove settlement", needs: [] },
  "terrain.set": { label: "Set terrain", needs: ["type"] },
  "feature.set": { label: "Set feature", needs: [] },
  "resource.set": { label: "Set resource", needs: [] },
};

const missing = (v) => v === undefined || v === null || v === "";

export function validateRequest({ op, args }) {
  const spec = Object.hasOwn(OPS, op) ? OPS[op] : null;
  if (!spec) return `unknown operation "${op}"`;
  if (!args || !Number.isInteger(args.x) || !Number.isInteger(args.y)) return "x and y must be integers";
  const absent = spec.needs.find((k) => missing(args[k]));
  if (absent) return `${op} needs ${absent}`;
  if (spec.needs.includes("owner") && !Number.isInteger(args.owner)) return "owner must be a player id";
  return null;
}

const landUnitOnWater = (r) => r.unitDomain === "DOMAIN_LAND" && r.before?.water === true;

// Known engine behaviour, surfaced where it explains a verdict. Checked in order; every match is shown.
const HINTS = [
  {
    when: ({ op, args }, r) => (op === "feature.set" || op === "resource.set") && args.type != null && r.verdict !== "LANDED",
    text: "Watched 2026-09-26 on 1.5.0: placement landed at once on a clean plot, but on a plot holding a unit whose feature had just been cleared it did not land until the plot's terrain was rewritten. Cause not isolated. Re-read after a turn or a terrain write before concluding.",
  },
  {
    when: (_req, r) => r.verdict === "UNEXPECTED",
    text: "The plot changed, but not to what was asked. Undo puts back the original state if the engine accepts it.",
  },
  {
    when: ({ op }, r) => r.verdict === "NO EFFECT" && op === "town.place",
    text: "The engine silently rejects some founding spots; a NO EFFECT here is not a tool fault.",
  },
  {
    when: ({ op }, r) => r.verdict === "NO EFFECT" && op === "unit.place" && landUnitOnWater(r),
    text: "A land unit sent to a water plot is discarded without an error, and it does not appear at the turn roll either (watched 2026-09-29 on 1.5.0: eight turns, no unit). Choose a land plot.",
  },
  {
    when: ({ op }, r) => r.verdict === "NO EFFECT" && !(op === "unit.place" && landUnitOnWater(r)),
    text: "Some writes only land at the turn roll. Re-read the plot after ending the turn before concluding it failed.",
  },
  {
    when: ({ op, args }, r) => r.verdict === "LANDED" && op === "terrain.set" && args.type === "TERRAIN_NAVIGABLE_RIVER",
    text: "The navigation graph is not rebuilt for a retyped navigable river: pathing will not see it until an age transition (inferred).",
  },
  {
    when: ({ op }, r) => r.verdict === "LANDED" && op === "terrain.set",
    text: "Retyped terrain persists in the save. Undo restores the terrain type, not any adjacent changes the engine made.",
  },
];

export function hintsFor(request, result) {
  return HINTS.filter((h) => h.when(request, result)).map((h) => h.text);
}

const loc = ({ x, y }) => `{ x: ${x}, y: ${y} }`;
const str = (v) => JSON.stringify(v);

const block = (call) => `WorldBuilder.startBlock();\n${call}\nWorldBuilder.endBlock();`;
const typeIndex = (table, type, none) => (type == null ? none : `GameInfo.${table}.lookup(${str(type)}).$index`);

const SNIPPETS = {
  "unit.place": (args) => `Game.PlayerOperations.sendRequest(GameContext.localPlayerID, "CREATE_ELEMENT", `
    + `{ Kind: "UNIT", Type: ${str(args.type)}, Location: ${loc(args)}, Owner: ${args.owner} });`,
  "unit.remove": (args) => `Game.PlayerOperations.sendRequest(GameContext.localPlayerID, "DESTROY_ELEMENT", `
    + `{ Kind: "UNIT", Owner: ${args.owner ?? "<owner>"}, LocalID: ${args.id ?? "<unit id>"} });`,
  "town.place": (args) => `Game.PlayerOperations.sendRequest(GameContext.localPlayerID, "CREATE_ELEMENT", `
    + `{ Kind: "CITY", Location: ${loc(args)}, Owner: ${args.owner} });`,
  // getCity answers for every plot a city owns, so check the plot is the city's centre first.
  "town.remove": (args) => `const c = MapCities.getCity(${args.x}, ${args.y});\n`
    + `const at = c && Cities.get(c)?.location;\n`
    + `if (at && at.x === ${args.x} && at.y === ${args.y}) {\n`
    + `  Game.PlayerOperations.sendRequest(GameContext.localPlayerID, "DESTROY_ELEMENT", { Kind: "CITY", Owner: c.owner, LocalID: c.id });\n}`,
  "terrain.set": (args) => block(`WorldBuilder.MapPlots.setTerrain(GameInfo.Terrains.lookup(${str(args.type)}).$index, ${loc(args)});`),
  "feature.set": (args) => block(`WorldBuilder.MapPlots.setFeature(${typeIndex("Features", args.type, "FeatureTypes.NO_FEATURE")}, ${loc(args)});`),
  "resource.set": (args) => {
    const amount = args.type == null ? 0 : (args.amount ?? 1);
    return block(`WorldBuilder.MapPlots.setResource(${typeIndex("Resources", args.type, "ResourceTypes.NO_RESOURCE")}, ${loc(args)}, ${amount});`);
  },
};

export function snippetFor({ op, args }) {
  return Object.hasOwn(SNIPPETS, op) ? SNIPPETS[op](args) : null;
}

const setOrClear = (what, args, at) => (args.type == null ? `clear the ${what} at ${at}` : `set ${what} ${args.type} at ${at}`);

const DESCRIPTIONS = {
  "unit.place": (args, at) => `place ${args.type} for player ${args.owner} at ${at}`,
  "unit.remove": (args, at) => `remove unit ${args.owner ?? "?"}:${args.id ?? "first"} at ${at}`,
  "town.place": (args, at) => `found a town for player ${args.owner} at ${at}`,
  "town.remove": (_args, at) => `remove the settlement at ${at}`,
  "terrain.set": (args, at) => `set terrain ${args.type} at ${at}`,
  "feature.set": (args, at) => setOrClear("feature", args, at),
  "resource.set": (args, at) => setOrClear("resource", args, at),
};

export function describeRequest({ op, args }) {
  const at = `(${args.x}, ${args.y})`;
  return Object.hasOwn(DESCRIPTIONS, op) ? DESCRIPTIONS[op](args, at) : `${op} at ${at}`;
}
