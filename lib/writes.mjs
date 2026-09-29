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

export function validateRequest({ op, args }) {
  const spec = OPS[op];
  if (!spec) return `unknown operation "${op}"`;
  if (!args || !Number.isInteger(args.x) || !Number.isInteger(args.y)) return "x and y must be integers";
  for (const k of spec.needs) {
    if (args[k] === undefined || args[k] === null || args[k] === "") return `${op} needs ${k}`;
  }
  if (spec.needs.includes("owner") && !Number.isInteger(args.owner)) return "owner must be a player id";
  return null;
}

// Known engine behaviour, surfaced where it explains a verdict.
export function hintsFor({ op, args }, result) {
  const hints = [];
  const placing = (op === "feature.set" || op === "resource.set") && args.type != null;
  if (placing && result.verdict !== "LANDED") {
    hints.push("Watched 2026-09-26 on 1.5.0: placement landed at once on a clean plot, but on a plot holding a unit whose feature had just been cleared it did not land until the plot's terrain was rewritten. Cause not isolated. Re-read after a turn or a terrain write before concluding.");
  }
  if (result.verdict === "UNEXPECTED") {
    hints.push("The plot changed, but not to what was asked. Undo puts back the original state if the engine accepts it.");
  }
  if (result.verdict === "NO EFFECT") {
    if (op === "town.place") hints.push("The engine silently rejects some founding spots; a NO EFFECT here is not a tool fault.");
    hints.push("Some writes only land at the turn roll. Re-read the plot after ending the turn before concluding it failed.");
  }
  if (result.verdict === "LANDED" && op === "terrain.set" && args.type === "TERRAIN_NAVIGABLE_RIVER") {
    hints.push("The navigation graph is not rebuilt for a retyped navigable river: pathing will not see it until an age transition (inferred).");
  }
  if (result.verdict === "LANDED" && op === "terrain.set") {
    hints.push("Retyped terrain persists in the save. Undo restores the terrain type, not any adjacent changes the engine made.");
  }
  return hints;
}

const loc = ({ x, y }) => `{ x: ${x}, y: ${y} }`;
const str = (v) => JSON.stringify(v);

export function snippetFor({ op, args }) {
  switch (op) {
    case "unit.place":
      return `Game.PlayerOperations.sendRequest(GameContext.localPlayerID, "CREATE_ELEMENT", `
        + `{ Kind: "UNIT", Type: ${str(args.type)}, Location: ${loc(args)}, Owner: ${args.owner} });`;
    case "unit.remove":
      return `Game.PlayerOperations.sendRequest(GameContext.localPlayerID, "DESTROY_ELEMENT", `
        + `{ Kind: "UNIT", Owner: ${args.owner ?? "<owner>"}, LocalID: ${args.id ?? "<unit id>"} });`;
    case "town.place":
      return `Game.PlayerOperations.sendRequest(GameContext.localPlayerID, "CREATE_ELEMENT", `
        + `{ Kind: "CITY", Location: ${loc(args)}, Owner: ${args.owner} });`;
    case "town.remove":
      // getCity answers for every plot a city owns, so check the plot is the city's centre first.
      return `const c = MapCities.getCity(${args.x}, ${args.y});\n`
        + `const at = c && Cities.get(c)?.location;\n`
        + `if (at && at.x === ${args.x} && at.y === ${args.y}) {\n`
        + `  Game.PlayerOperations.sendRequest(GameContext.localPlayerID, "DESTROY_ELEMENT", { Kind: "CITY", Owner: c.owner, LocalID: c.id });\n}`;
    case "terrain.set":
      return `WorldBuilder.startBlock();\n`
        + `WorldBuilder.MapPlots.setTerrain(GameInfo.Terrains.lookup(${str(args.type)}).$index, ${loc(args)});\n`
        + `WorldBuilder.endBlock();`;
    case "feature.set": {
      const idx = args.type == null ? "FeatureTypes.NO_FEATURE" : `GameInfo.Features.lookup(${str(args.type)}).$index`;
      return `WorldBuilder.startBlock();\nWorldBuilder.MapPlots.setFeature(${idx}, ${loc(args)});\nWorldBuilder.endBlock();`;
    }
    case "resource.set": {
      const idx = args.type == null ? "ResourceTypes.NO_RESOURCE" : `GameInfo.Resources.lookup(${str(args.type)}).$index`;
      const amount = args.type == null ? 0 : (args.amount ?? 1);
      return `WorldBuilder.startBlock();\nWorldBuilder.MapPlots.setResource(${idx}, ${loc(args)}, ${amount});\nWorldBuilder.endBlock();`;
    }
    default:
      return null;
  }
}

export function describeRequest({ op, args }) {
  const at = `(${args.x}, ${args.y})`;
  switch (op) {
    case "unit.place": return `place ${args.type} for player ${args.owner} at ${at}`;
    case "unit.remove": return `remove unit ${args.owner ?? "?"}:${args.id ?? "first"} at ${at}`;
    case "town.place": return `found a town for player ${args.owner} at ${at}`;
    case "town.remove": return `remove the settlement at ${at}`;
    case "terrain.set": return `set terrain ${args.type} at ${at}`;
    case "feature.set": return args.type == null ? `clear the feature at ${at}` : `set feature ${args.type} at ${at}`;
    case "resource.set": return args.type == null ? `clear the resource at ${at}` : `set resource ${args.type} at ${at}`;
    default: return `${op} at ${at}`;
  }
}
