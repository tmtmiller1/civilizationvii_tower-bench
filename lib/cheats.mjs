// Node-side knowledge about game-state actions ("cheats"): what each one is, what the engine is known to
// do with it, and the standalone code a mod would use. They go through Bench.write like the map writes:
// validated here, performed and re-read in the page (engine-cheats.mjs), logged, and undone only where
// the engine has been seen to reverse them.

// Players.grantYield per yield, watched 2026-09-18 on 1.5.0 (engine-closed.md, "JS engine APIs").
export const YIELDS = {
  gold: "YIELD_GOLD", influence: "YIELD_DIPLOMACY", happiness: "YIELD_HAPPINESS", science: "YIELD_SCIENCE",
  culture: "YIELD_CULTURE", food: "YIELD_FOOD", production: "YIELD_PRODUCTION",
};
const TWO_WAY = new Set(["YIELD_GOLD", "YIELD_DIPLOMACY", "YIELD_HAPPINESS"]);
const GAIN_ONLY = new Set(["YIELD_SCIENCE", "YIELD_CULTURE"]);
const NO_POOL = "Players.grantYield does nothing for Food or Production, either sign (watched 2026-09-18 on 1.5.0); "
  + "for city production use city.production";

const isInt = Number.isInteger;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const hasPlot = (a) => isInt(a.x) && isInt(a.y);

function yieldProblem(a) {
  if (TWO_WAY.has(a.yield) || GAIN_ONLY.has(a.yield)) {
    if (!isNum(a.amount) || a.amount === 0) return "amount must be a non-zero number";
    return GAIN_ONLY.has(a.yield) && a.amount < 0
      ? `${a.yield} only adds: a negative grant does nothing (watched 2026-09-18 on 1.5.0)` : null;
  }
  return a.yield === "YIELD_FOOD" || a.yield === "YIELD_PRODUCTION" ? NO_POOL : `unknown yield ${a.yield}`;
}

const positive = (a) => (isInt(a.amount) && a.amount > 0 ? null : "amount must be a positive whole number");
const nonZero = (a) => (isNum(a.amount) && a.amount !== 0 ? null : "amount must be a non-zero number");
const unitTarget = (a) => (isInt(a.unit) || hasPlot(a) ? null : "which unit? give unit (its id) or x and y");
const cityTarget = (a) => (isInt(a.city) || hasPlot(a) ? null : "which city? give city (its id) or the x and y of its centre");
const treeArg = (a) => (a.tree === "tech" || a.tree === "civic" ? null : "tree must be tech or civic");

function xpProblem(a) {
  if (a.to !== undefined) return isInt(a.to) && a.to >= 0 ? null : "to must be a whole number, 0 or more";
  return isInt(a.amount) && a.amount !== 0 ? null : "give amount (a change) or to (a total)";
}

/**
 * Every action targets one player, named by `player`. `undo` says what Undo does for it.
 * @type {Record<string, { group: string, label: string, check: (a: any) => string | null, undo: string }>}
 */
export const CHEAT_OPS = {
  "player.yield": {
    group: "player", label: "Grant a yield", check: yieldProblem,
    undo: "the opposite grant for Gold, Influence and Happiness; Science and Culture cannot be taken back",
  },
  "player.celebrate": {
    group: "player", label: "Fill the celebration meter", check: () => null,
    undo: "takes the granted Happiness back off the meter",
  },
  "player.attribute": {
    group: "player", label: "Add wildcard attribute points", check: positive,
    undo: "not undoable: removing attribute points is not watched",
  },
  "unit.heal": {
    group: "units", label: "Heal a unit", check: unitTarget,
    undo: "damages the unit back to where it was",
  },
  "unit.damage": {
    group: "units", label: "Damage a unit", check: (a) => unitTarget(a) ?? positive(a),
    undo: "sets the damage back, where the engine offers a damage setter",
  },
  "unit.xp": {
    group: "units", label: "Change a unit's experience", check: (a) => unitTarget(a) ?? xpProblem(a),
    undo: "not undoable: an experience deduction is not watched",
  },
  "unit.promote": {
    group: "units", label: "Promote a unit",
    check: (a) => unitTarget(a) ?? (a.promotion && a.discipline ? null : "promote needs promotion and discipline"),
    undo: "not undoable: no script removes a promotion",
  },
  "unit.moves": {
    group: "units", label: "Restore a unit's movement", check: unitTarget,
    undo: "not undoable: no script takes movement away",
  },
  "unit.move": {
    group: "units", label: "Move a unit (recreate)",
    check: (a) => (isInt(a.unit) ? null : "move needs unit (its id)") ?? (isInt(a.toX) && isInt(a.toY) ? null : "move needs toX and toY"),
    undo: "moves the new unit back the same way",
  },
  "unit.kill": {
    group: "units", label: "Kill a unit", check: unitTarget,
    undo: "places a new unit of the same type where it stood (not the same unit: no experience or promotions)",
  },
  "city.production": {
    group: "cities", label: "Add production progress", check: (a) => cityTarget(a) ?? nonZero(a),
    undo: "the opposite progress, while the same item is still in production",
  },
  "city.complete": {
    group: "cities", label: "Complete current production", check: cityTarget,
    undo: "not undoable: a finished item cannot be unbuilt by this action",
  },
  "city.grow": {
    group: "cities", label: "Add a population point", check: cityTarget,
    undo: "not undoable: no script removes a population point cleanly (watched)",
  },
  "progress.complete": {
    group: "progress", label: "Complete current research", check: treeArg,
    undo: "not undoable: Science and Culture cannot be taken back",
  },
  "progress.grant": {
    group: "progress", label: "Research a chosen tech or civic",
    check: (a) => treeArg(a) ?? (typeof a.node === "string" && a.node ? null : "which node? e.g. NODE_TECH_AQ_POTTERY"),
    undo: "not undoable: a completed node cannot be taken back",
  },
  "map.reveal": {
    group: "map", label: "Reveal the map",
    check: (a) => (a.x === undefined && a.y === undefined) || hasPlot(a) ? null : "give both x and y, or neither for the whole map",
    undo: "not undoable: hiding a plot again is not watched",
  },
  "map.owner": {
    group: "map", label: "Give a plot to a city",
    check: (a) => (hasPlot(a) ? null : "x and y must be integers") ?? (isInt(a.city) ? null : "which city takes it? give city"),
    undo: "gives the plot back to the city that held it; an unowned plot cannot be released again (watched)",
  },
};

export const isCheat = (op) => Object.hasOwn(CHEAT_OPS, op);

export function validateCheat({ op, args }) {
  if (!args || typeof args !== "object") return "args are missing";
  if (!isInt(args.player) || args.player < 0) return "player must be a player id";
  return CHEAT_OPS[op].check(args);
}

const landed = (r) => r.verdict === "LANDED";

// Known engine behaviour, surfaced where it explains a verdict. Checked in order; every match is shown.
const CHEAT_HINTS = [
  {
    when: ({ op }, r) => op === "player.yield" && landed(r),
    text: "Script-granted yields never show a source in the yield breakdown (watched); the change is in the store only.",
  },
  {
    when: ({ op, args }, r) => op === "player.yield" && args.yield === "YIELD_HAPPINESS" && r.sent,
    text: "Happiness from grantYield moves only the celebration meter (Stats.getLifetimeYield); no settlement's "
      + "happiness or unrest changes (watched 2026-09-11).",
  },
  {
    when: ({ op, args }, r) => op === "player.yield" && ["YIELD_SCIENCE", "YIELD_CULTURE"].includes(args.yield) && r.sent,
    text: "Science and Culture land on the node being researched and can complete it; a negative grant does nothing "
      + "(watched 2026-09-18 on 1.5.0).",
  },
  {
    when: ({ op }, r) => op === "player.celebrate" && landed(r),
    text: "The meter is at the threshold. The celebration itself starts the engine's way, at the turn roll with a "
      + "choice for a human player (not watched).",
  },
  {
    when: ({ op }, r) => op === "city.grow" && landed(r),
    text: "For a human player the game blocks End Turn with an undismissable Grow City notification until the point "
      + "is placed; AI cities place it themselves (watched 2026-09-15).",
  },
  {
    when: ({ op }, r) => (op === "city.production" || op === "city.complete") && r.sent,
    text: "BuildQueue.addProgress is scaled by the city's production bonuses (+-50 moved about +-57.5) and floors at 0 "
      + "(watched 2026-09-18 on 1.5.0).",
  },
  {
    when: ({ op }, r) => op === "progress.grant" && r.sent && !landed(r),
    text: "Watched 2026-09-27: choosing a node and granting its cost completed it across one turn. Re-read after "
      + "ending the turn before concluding it failed.",
  },
  {
    when: ({ op, args }, r) => op === "map.reveal" && args.x === undefined && r.sent,
    text: "Visibility.revealAllPlots queues one reveal cinematic per natural wonder it uncovers, each taking the camera "
      + "until CinematicManager.stop() (watched 2026-09-28 on 1.5.0).",
  },
  {
    when: ({ op }, r) => op === "map.owner" && landed(r),
    text: "A script purchasePlot costs no gold (watched 2026-09-25), and a plot more than about 7 rings from the city "
      + "is released at the turn roll (watched 2026-09-24).",
  },
  {
    when: ({ op }, r) => op === "unit.move" && r.sent,
    text: "No unit operation moves a unit (watched 2026-09-24), so this recreates it at the target: a new id, full "
      + "health and movement, no experience or promotions.",
  },
  {
    when: (_req, r) => r.verdict === "UNEXPECTED",
    text: "The value changed, but not as asked. Undo puts back what it can if the result carries an inverse.",
  },
  {
    when: (_req, r) => r.verdict === "NO EFFECT",
    text: "Some changes only land at the turn roll. Re-read after ending the turn before concluding it failed.",
  },
  {
    when: (_req, r) => (landed(r) || r.verdict === "UNEXPECTED") && !r.inverse,
    text: "", // filled in by cheatHints with the op's undo note
  },
];

export function cheatHints(request, result) {
  const undo = CHEAT_OPS[request.op]?.undo ?? "not undoable";
  return CHEAT_HINTS.filter((h) => h.when(request, result)).map((h) => h.text
    || `Undo skips this (${undo}); Undo reverts the most recent undoable write before it.`);
}

const str = (v) => JSON.stringify(v);
const loc = (x, y) => `{ x: ${x}, y: ${y} }`;

function unitLine(a) {
  if (Number.isInteger(a.unit)) return `const unit = Players.get(${a.player}).Units.getUnits().find((u) => u.id.id === ${a.unit});`;
  return `const unit = MapUnits.getUnits(${a.x}, ${a.y}).map((id) => Units.get(id)).find((u) => u.owner === ${a.player});`;
}

function cityLine(a) {
  if (Number.isInteger(a.city)) {
    return `const city = Players.get(${a.player}).Cities.getCities().find((c) => c.id.id === ${a.city});`;
  }
  return `const city = Cities.get(MapCities.getCity(${a.x}, ${a.y}));`;
}

function progressLines(a) {
  const [sub, tree, y] = a.tree === "tech" ? ["Techs", "getTreeType", "SCIENCE"] : ["Culture", "getActiveTree", "CULTURE"];
  return [`const tree = Players.get(${a.player}).${sub};`,
    `const t = Game.ProgressionTrees.getTree(${a.player}, tree.${tree}());`,
    "const node = t.nodes[t.activeNodeIndex].nodeType;",
    `const left = tree.getNodeCost(node) - Game.ProgressionTrees.getNode(${a.player}, node).progress;`,
    `Players.grantYield(${a.player}, YieldTypes.YIELD_${y}, Math.ceil(left));`];
}

const unitDo = (a, call) => `${unitLine(a)}\n${call}`;
const cityDo = (a, call) => `${cityLine(a)}\n${call}`;

const CHEAT_SNIPPETS = {
  "player.yield": (a) => `Players.grantYield(${a.player}, YieldTypes.${a.yield}, ${a.amount});`,
  "player.celebrate": (a) => [`const p = Players.get(${a.player});`,
    "const need = Math.ceil(p.Happiness.nextGoldenAgeThreshold - p.Stats.getLifetimeYield(YieldTypes.YIELD_HAPPINESS));",
    `if (need > 0) Players.grantYield(${a.player}, YieldTypes.YIELD_HAPPINESS, need);`].join("\n"),
  "player.attribute": (a) => `Players.get(${a.player}).Identity.addWildcardAttributePoints(${a.amount});`,
  "unit.heal": (a) => unitDo(a, `Units.setDamage(unit.id, ${a.to ?? 0});`),
  "unit.damage": (a) => unitDo(a, `unit.Health.damageUnit(${a.amount});`),
  "unit.xp": (a) => unitDo(a, a.to === undefined ? `Units.changeExperience(unit.id, ${a.amount});`
    : `Units.changeExperience(unit.id, ${a.to} - unit.Experience.experiencePoints);`),
  "unit.promote": (a) => unitDo(a, "Game.UnitCommands.sendRequest(unit.id, UnitCommandTypes.PROMOTE, "
    + `{ PromotionType: Database.makeHash(${str(a.promotion)}), PromotionDisciplineType: Database.makeHash(${str(a.discipline)}) });`),
  "unit.moves": (a) => unitDo(a, "Units.restoreMovement(unit.id);"),
  "unit.move": (a) => unitDo(a, [
    `Game.PlayerOperations.sendRequest(GameContext.localPlayerID, "CREATE_ELEMENT", { Kind: "UNIT", `
      + `Type: GameInfo.Units.lookup(unit.type).UnitType, Location: ${loc(a.toX, a.toY)}, Owner: unit.owner });`,
    "// once the new unit is seen at the target:",
    `Game.PlayerOperations.sendRequest(GameContext.localPlayerID, "DESTROY_ELEMENT", { Kind: "UNIT", Owner: unit.owner, LocalID: unit.id.id });`,
  ].join("\n")),
  "unit.kill": (a) => unitDo(a, `Game.PlayerOperations.sendRequest(GameContext.localPlayerID, "DESTROY_ELEMENT", `
    + "{ Kind: \"UNIT\", Owner: unit.owner, LocalID: unit.id.id });"),
  "city.production": (a) => cityDo(a, `city.BuildQueue.addProgress(${a.amount});`),
  "city.complete": (a) => cityDo(a, "city.BuildQueue.addProgress(Math.ceil(city.BuildQueue.currentBuildProgressRequired"
    + " - city.BuildQueue.currentBuildProgress));"),
  "city.grow": (a) => cityDo(a, "city.addRuralPopulation(1);"),
  "progress.complete": (a) => progressLines(a).join("\n"),
  "progress.grant": (a) => [`const row = GameInfo.ProgressionTreeNodes.lookup(${str(a.node)});`,
    `Game.PlayerOperations.sendRequest(GameContext.localPlayerID, PlayerOperationTypes.SET_${a.tree === "tech" ? "TECH" : "CULTURE"}_TREE_NODE, `
      + "{ ProgressionTreeNodeType: row.$hash });",
    "// then, once it is the active node:", ...progressLines(a)].join("\n"),
  "map.reveal": (a) => (a.x === undefined ? `Visibility.revealAllPlots(${a.player});`
    : `WorldBuilder.MapPlots.setRevealed(${a.player}, ${loc(a.x, a.y)}, true);`),
  "map.owner": (a) => `${cityLine({ player: a.player, city: a.city })}\ncity.purchasePlot(${loc(a.x, a.y)});`,
};

export function cheatSnippet({ op, args }) {
  return Object.hasOwn(CHEAT_SNIPPETS, op) ? CHEAT_SNIPPETS[op](args) : null;
}

const unitName = (a) => (Number.isInteger(a.unit) ? `unit ${a.player}:${a.unit}` : `player ${a.player}'s unit at (${a.x}, ${a.y})`);
const cityName = (a) => (Number.isInteger(a.city) ? `city ${a.player}:${a.city}` : `the city at (${a.x}, ${a.y})`);

const CHEAT_DESCRIPTIONS = {
  "player.yield": (a) => `grant ${a.amount} ${a.yield} to player ${a.player}`,
  "player.celebrate": (a) => `fill player ${a.player}'s celebration meter`,
  "player.attribute": (a) => `add ${a.amount} wildcard attribute point(s) for player ${a.player}`,
  "unit.heal": (a) => `heal ${unitName(a)}${a.to ? ` to ${a.to} damage` : ""}`,
  "unit.damage": (a) => `damage ${unitName(a)} by ${a.amount}`,
  "unit.xp": (a) => (a.to === undefined ? `change ${unitName(a)}'s experience by ${a.amount}`
    : `set ${unitName(a)}'s experience to ${a.to}`),
  "unit.promote": (a) => `promote ${unitName(a)} with ${a.promotion}`,
  "unit.moves": (a) => `restore ${unitName(a)}'s movement`,
  "unit.move": (a) => `move ${unitName(a)} to (${a.toX}, ${a.toY}) by recreating it`,
  "unit.kill": (a) => `kill ${unitName(a)}`,
  "city.production": (a) => `add ${a.amount} production progress in ${cityName(a)}`,
  "city.complete": (a) => `complete the current production in ${cityName(a)}`,
  "city.grow": (a) => `add a population point in ${cityName(a)}`,
  "progress.complete": (a) => `complete player ${a.player}'s current ${a.tree}`,
  "progress.grant": (a) => `research ${a.node} for player ${a.player}`,
  "map.reveal": (a) => (a.x === undefined ? `reveal the whole map for player ${a.player}`
    : `reveal (${a.x}, ${a.y}) for player ${a.player}`),
  "map.owner": (a) => `give (${a.x}, ${a.y}) to city ${a.player}:${a.city}`,
};

export function describeCheat({ op, args }) {
  return Object.hasOwn(CHEAT_DESCRIPTIONS, op) ? CHEAT_DESCRIPTIONS[op](args ?? {}) : op;
}
