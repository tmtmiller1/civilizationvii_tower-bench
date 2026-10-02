import { BenchError } from "../bench.mjs";
import { CHEAT_OPS, YIELDS } from "../cheats.mjs";
import { localPlayer, num, out } from "./common.mjs";

/** @typedef {import("./common.mjs").Ctx} Ctx */
/** @typedef {{ player: number, unit?: number, city?: number, x?: number, y?: number, unitAt?: { x: number, y: number },
 *   cityAt?: { x: number, y: number } }} Target */

const int = (v, what) => {
  const n = Number(v);
  if (v === undefined || v === "" || !Number.isFinite(n)) throw new BenchError(`${what} must be a number`);
  return n;
};

/** @param {Target} t */
const unitOf = (t) => (t.unitAt ? { player: t.player, ...t.unitAt } : { player: t.player, unit: t.unit });
/** @param {Target} t */
const cityOf = (t) => (t.cityAt ? { player: t.player, ...t.cityAt } : { player: t.player, city: t.city });
/** @param {string} key @param {string} usage */
const yieldAction = (key, usage) => ({
  op: "player.yield", usage, build: (/** @type {string[]} */ [n], /** @type {Target} */ t) => ({ player: t.player, yield: YIELDS[key], amount: int(n, "amount") }),
});
const tree = (v) => {
  if (v !== "tech" && v !== "civic") throw new BenchError("which tree? tech or civic");
  return v;
};

/**
 * The friendly action names, each building one request for Bench.write.
 * @type {Record<string, { op: string, usage: string, build: (rest: string[], t: Target) => any }>}
 */
export const ACTIONS = {
  gold: yieldAction("gold", "gold <N>              grant (or with -N take) Gold"),
  influence: yieldAction("influence", "influence <N>         grant or take Influence"),
  happiness: yieldAction("happiness", "happiness <N>         move the celebration meter"),
  science: yieldAction("science", "science <N>           add Science to the tech in research"),
  culture: yieldAction("culture", "culture <N>           add Culture to the civic in research"),
  celebrate: { op: "player.celebrate", usage: "celebrate             fill the celebration meter", build: (_r, t) => ({ player: t.player }) },
  attribute: {
    op: "player.attribute", usage: "attribute [N]         add wildcard attribute points",
    build: ([n = "1"], t) => ({ player: t.player, amount: int(n, "amount") }),
  },
  heal: {
    op: "unit.heal", usage: "heal [DAMAGE]         set a unit's damage (default 0)",
    build: ([to], t) => ({ ...unitOf(t), ...(to === undefined ? {} : { to: int(to, "damage") }) }),
  },
  damage: { op: "unit.damage", usage: "damage <N>            damage a unit", build: ([n], t) => ({ ...unitOf(t), amount: int(n, "amount") }) },
  xp: {
    op: "unit.xp", usage: "xp <N | =N>           change a unit's experience, or set it with =N",
    build: ([n = ""], t) => (n.startsWith("=") ? { ...unitOf(t), to: int(n.slice(1), "experience") }
      : { ...unitOf(t), amount: int(n, "amount") }),
  },
  promote: {
    op: "unit.promote", usage: "promote <PROMOTION> <DISCIPLINE>   promote one of your units",
    build: ([promotion, discipline], t) => ({ ...unitOf(t), promotion, discipline }),
  },
  moves: { op: "unit.moves", usage: "moves                 restore a unit's movement", build: (_r, t) => unitOf(t) },
  move: {
    op: "unit.move", usage: "move <x> <y>          recreate a unit on another plot",
    build: ([x, y], t) => ({ player: t.player, unit: t.unit, toX: int(x, "x"), toY: int(y, "y") }),
  },
  kill: { op: "unit.kill", usage: "kill                  destroy a unit", build: (_r, t) => unitOf(t) },
  production: {
    op: "city.production", usage: "production <N>        add (or with -N remove) production progress",
    build: ([n], t) => ({ ...cityOf(t), amount: int(n, "amount") }),
  },
  complete: { op: "city.complete", usage: "complete              finish the item in production", build: (_r, t) => cityOf(t) },
  grow: { op: "city.grow", usage: "grow                  add a population point", build: (_r, t) => cityOf(t) },
  research: {
    op: "progress.complete", usage: "research tech|civic   complete what is being researched",
    build: ([which], t) => ({ player: t.player, tree: tree(which) }),
  },
  unlock: {
    op: "progress.grant", usage: "unlock tech|civic <NODE>   research a chosen node (your own player)",
    build: ([which, node], t) => ({ player: t.player, tree: tree(which), node }),
  },
  reveal: {
    op: "map.reveal", usage: "reveal [x y]          reveal one plot, or the whole map",
    build: ([x, y], t) => (x === undefined ? { player: t.player } : { player: t.player, x: int(x, "x"), y: int(y, "y") }),
  },
  own: {
    op: "map.owner", usage: "own <x> <y>           give a plot to the city named by --city",
    build: ([x, y], t) => ({ player: t.player, city: t.city, x: int(x, "x"), y: int(y, "y") }),
  },
};

/** @param {string} name @param {string[]} rest @param {Target} target */
export function actionRequest(name, rest, target) {
  if (!Object.hasOwn(ACTIONS, name)) throw new BenchError(`unknown action "${name}"; do list shows them`);
  const a = ACTIONS[name];
  return { op: a.op, args: a.build(rest, target) };
}

// One op covers every yield, but whether the grant can be taken back depends on the yield.
const ONE_WAY_YIELDS = new Set(["science", "culture"]);
const undoNote = (name, note) => {
  if (ONE_WAY_YIELDS.has(name)) return "not undoable: the engine only adds Science and Culture";
  if (["gold", "influence", "happiness"].includes(name)) return "the opposite grant";
  return note;
};

export function actionList() {
  return Object.entries(ACTIONS).map(([name, a]) => {
    const c = CHEAT_OPS[a.op];
    return { name, op: a.op, usage: a.usage, group: c.group, label: c.label, undo: undoNote(name, c.undo) };
  });
}

// "--unit 12" names a unit by id, "--unit 3,4" the player's unit on a plot, "--unit selected" the
// unit selected in game. "--city" takes an id or the x,y of a settlement's centre.
const plotOf = (v) => {
  const m = /^(-?\d+),(-?\d+)$/.exec(String(v ?? ""));
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
};

/** @param {import("../bench.mjs").Bench} bench */
async function selectedUnit(bench) {
  const st = await bench.status();
  const s = "snapshot" in st ? st.snapshot?.selectedUnit : null;
  if (!s) throw new BenchError("no unit is selected in game");
  return s;
}

/** @param {Ctx} ctx @returns {Promise<Target>} */
async function resolveTarget({ bench, opt }) {
  const unitOpt = opt["unit"] ?? opt.id;
  if (unitOpt === "selected") {
    const s = await selectedUnit(bench);
    return { player: s.owner, unit: s.id };
  }
  const player = num(opt["player"] ?? opt.owner) ?? await localPlayer(bench);
  const cityOpt = opt["city"];
  return {
    player, unit: plotOf(unitOpt) ? undefined : num(unitOpt), unitAt: plotOf(unitOpt) ?? undefined,
    city: plotOf(cityOpt) ? undefined : num(cityOpt), cityAt: plotOf(cityOpt) ?? undefined,
  };
}

function printList() {
  let group = "";
  for (const a of actionList()) {
    if (a.group !== group) out(`\n${(group = a.group)}`);
    out(`  do ${a.usage}`);
    out(`       undo: ${a.undo}`);
  }
}

const preview = (v) => {
  const s = JSON.stringify(v);
  return s && s.length > 160 ? `${s.slice(0, 160)}...` : s;
};

const TIMING = { LANDED: (r) => ` in ${r.landedMs} ms`, "NO EFFECT": (r) => ` (waited ${r.waitedMs} ms)` };

function printAction(r) {
  const timing = Object.hasOwn(TIMING, r.verdict) ? TIMING[r.verdict](r) : "";
  out(`${r.description}: ${r.verdict}${timing}${r.reason ? `: ${r.reason}` : ""}`);
  if (r.sent) {
    const canStart = r.canStart !== undefined ? `, canStart ${JSON.stringify(r.canStart)}` : "";
    out(`  engine returned ${JSON.stringify(r.returned)}${canStart} (neither proves anything)`);
    out(`  before ${preview(r.before)}\n  after  ${preview(r.after)}`);
  }
  for (const h of r.hints ?? []) out(`  note: ${h}`);
  if (r.inverse) out("  undo with: tower-bench undo --yes");
  if (r.snippet) out(`  as mod code:\n    ${r.snippet.replaceAll("\n", "\n    ")}`);
}

/** @type {Record<string, import("./common.mjs").Handler>} */
export const CHEATS_COMMANDS = {
  async do(ctx, [name, ...rest]) {
    const { bench, opt } = ctx;
    if (!name || name === "list") return opt.json ? out(actionList()) : printList();
    if (!Object.hasOwn(ACTIONS, name)) throw new BenchError(`unknown action "${name}"; do list shows them`);
    if (!opt.yes) throw new BenchError("this changes the running game; add --yes");
    const request = actionRequest(name, rest, await resolveTarget(ctx));
    bench.armed = true;
    const r = await bench.write(request);
    return opt.json ? out(r) : printAction(r);
  },
};

export const CHEATS_HELP = `  do list                              game-state actions for testing: yields, units, cities,
                                       research, map; each is verified, logged and undone where it can be
  do <action> [args] [--player N] [--unit ID|x,y|selected] [--city ID|x,y] --yes
                                       e.g. do gold 500 --yes; do heal --unit selected --yes`;

/** @typedef {import("../bench.mjs").Bench} Bench */
/** @typedef {(bench: Bench, req?: any, query?: any, readBody?: () => Promise<any>) => any} Route */
/** @type {Record<string, Route>} */
export const CHEATS_ROUTES = {
  "GET /api/do/list": () => ({ actions: actionList() }),
  "POST /api/do": async (bench, _req, _query, readBody) => {
    const b = (await readBody?.()) ?? {};
    const request = b.action
      ? actionRequest(b.action, (b.params ?? []).map(String), b.target ?? {}) : { op: b.op, args: b.args };
    if (!Object.hasOwn(CHEAT_OPS, request.op ?? "")) throw new BenchError(`not a game-state action: ${request.op}`);
    return bench.write(request, { waitMs: b.waitMs ?? 3000 });
  },
};
