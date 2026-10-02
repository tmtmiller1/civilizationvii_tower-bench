// MCP tools that change something: the running game, the mod registry, the game's mod files, or test games.
// Each is refused unless the server was started with --allow-writes (lab_start and bisect: also --allow-lab).
// Lab, bisect and recipe runs go through the CLI's own commands so they keep every refusal the CLI has,
// above all that turns are never ended in a game the lab did not start.
import fs from "node:fs";
import { BenchError } from "./bench.mjs";
import { CHEAT_OPS } from "./cheats.mjs";
import { OPS } from "./writes.mjs";
import { localPlayer } from "./cli/common.mjs";
import { ACTIONS, actionRequest } from "./cli/cheats.mjs";
import { FILE_COMMANDS } from "./cli/files.mjs";
import { printWrite } from "./cli/game.mjs";
import { LAB_COMMANDS } from "./cli/lab.mjs";
import { S, VERDICTS, captureOut, messageOf } from "./mcp-common.mjs";

/** @typedef {import("./mcp-common.mjs").ToolDef} ToolDef @typedef {import("./mcp-common.mjs").ToolCtx} ToolCtx */

const MAP_OPS = Object.keys(OPS).filter((op) => !Object.hasOwn(CHEAT_OPS, op));
const OWNER_OPS = new Set(["unit.place", "town.place"]);

/** A verified write's result as the CLI prints it, with the result itself as data. */
async function writeOut(r) {
  const text = (await captureOut(() => printWrite(r))).text.replaceAll("tower-bench undo --yes", "the undo tool");
  return { text, data: r };
}

/**
 * Runs a CLI command with its printed lines as the tool text, echoed to stderr as they come for a long run.
 * @param {ToolCtx} ctx @param {(c: any) => unknown} fn @param {Record<string, unknown>} opt
 */
async function cli({ bench, paths }, fn, opt) {
  const echo = (line) => process.stderr.write(`${line}\n`);
  const r = await captureOut(() => fn({ bench, paths, opt: { yes: true, ...opt } }), { echo });
  return { text: r.text || "(no output)", isError: r.failed };
}

// Recipe steps that run code: expect and eval run JavaScript in the game, an await match runs in Node.
function codeSteps(file) {
  let recipe;
  try {
    recipe = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new BenchError(`cannot read recipe ${file}: ${messageOf(e)}`);
  }
  return (recipe.steps ?? []).filter((s) => s.expect !== undefined || s.eval !== undefined || s.await?.match).length;
}

/** @param {ToolCtx} ctx @param {string | undefined} file */
function refuseRecipeCode({ flags }, file) {
  if (!file || flags.allowEval) return;
  const n = codeSteps(file);
  if (n) {
    throw new BenchError(`Refused: this recipe has ${n} step(s) that run code (expect, eval, or an await match), which `
      + "needs the server started with --allow-eval as well. A human enables it by restarting the server.");
  }
}

const plotOf = (v) => {
  const m = /^(-?\d+)\s*,\s*(-?\d+)$/.exec(String(v ?? ""));
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
};

/** The player, unit and city an action names, as the CLI's --player, --unit and --city do. */
async function target(bench, { player, unit, city }) {
  if (unit === "selected") {
    const st = await bench.status();
    const s = "snapshot" in st ? st.snapshot?.selectedUnit : null;
    if (!s) throw new BenchError("no unit is selected in game");
    return { player: s.owner, unit: s.id };
  }
  const p = player ?? await localPlayer(bench);
  const num = (v) => (v === undefined || plotOf(v) ? undefined : Number(v));
  return { player: p, unit: num(unit), unitAt: plotOf(unit) ?? undefined, city: num(city),
    cityAt: plotOf(city) ?? undefined };
}

/** @type {ToolDef[]} */
export const WRITE_TOOLS = [
  {
    name: "write", title: "Change the map", gate: "write",
    description: `Places or removes a unit or town, or sets a plot's terrain, feature or resource, then re-reads the `
      + `plot until the change is observed. Logged and undoable with the undo tool. ${VERDICTS}`,
    input: { op: { type: "string", enum: MAP_OPS },
      args: { type: "object", description: "x, y and per op: type (unit/terrain/feature/resource; null clears a feature "
        + "or resource), owner (default the local player), id (unit.remove), amount (resource)" } },
    required: ["op", "args"],
    run: async ({ bench }, { op, args }) => {
      const a = { ...args };
      if (OWNER_OPS.has(op) && a.owner === undefined) a.owner = await localPlayer(bench);
      return writeOut(await bench.write({ op, args: a }));
    },
  },
  {
    name: "do_action", title: "Game-state action", gate: "write",
    description: `A test action on game state: yields, a unit's health, experience or moves, city production or growth, `
      + `research, map reveal or ownership (do_list lists them). Verified by re-reading, logged, and undone where the `
      + `engine allows. ${VERDICTS}`,
    input: { action: { type: "string", enum: Object.keys(ACTIONS) },
      params: { type: "array", items: { type: "string" }, description: 'positional values, e.g. ["500"] for gold' },
      player: { type: "integer", description: "default the local player" },
      unit: { type: "string", description: 'a unit id, "x,y" (the player\'s unit there) or "selected"' },
      city: { type: "string", description: 'a city id or "x,y" of its centre' } },
    required: ["action"],
    run: async ({ bench }, { action, params = [], ...t }) => {
      const request = actionRequest(action, params, await target(bench, t));
      return writeOut(await bench.write(request));
    },
  },
  {
    name: "undo", title: "Undo the newest change", gate: "write",
    description: "Reverts today's newest landed change (a map write, an action or a mod switch), verified like a write. "
      + "Refuses when the newest change cannot be undone, unless skip passes over it to the one before.",
    input: { skip: { type: "boolean" } },
    run: async ({ bench }, { skip = false }) => writeOut(await bench.undo({ skip })),
  },
  {
    name: "deploy", title: "Copy a mod into the live copy", gate: "write",
    description: "Copies the mod's changed files into the copy the game loads, reloads the game's UI, and proves the "
      + "game now serves them (SERVED, STALE, NEEDS A NEW GAME). Run deploy_plan first to see what it would copy.",
    input: { folder: S.folder, reload: { type: "boolean", description: "reload the UI after copying (default true)" } },
    required: ["folder"],
    run: async ({ bench }, { folder, reload = true }) => {
      const r = await bench.deploy(folder, { yes: true, reload });
      if (r.plan.refuse) return { text: `refused: ${r.plan.refuse}`, data: r.plan, isError: true };
      if (!r.applied) return { text: "nothing to copy: the live copy already matches the source", data: r.plan };
      return { text: r.files.map((f) => `${f.live}  ${f.state}  ${f.rel}`).join("\n")
        + `\npage reloaded: ${r.reloaded ?? "unknown"}${r.connected ? "" : " (game not running: nothing proven live)"}`, data: r };
    },
  },
  {
    name: "mods_switch", title: "Switch a mod on or off", gate: "write",
    description: "Switches a mod on or off in the registry for the next launch, or makes one copy the live one. Only "
      + "with the game closed and no lab run in progress; verified by reading the flags back; undoable.",
    input: { op: { type: "string", enum: ["on", "off", "live"] }, id: { type: "string" },
      copy: { type: "string", description: "which copy, as mods_list labels it (needed for live)" } },
    required: ["op", "id"],
    run: ({ bench }, { op, id, copy }) => writeOut(bench.setMods({ op, id, copy })),
  },
  {
    name: "recipe_run", title: "Run a recipe in the current game", gate: "write",
    description: "Runs a recipe file's steps (snapshot, write, turns, diff, expect, ...) in the loaded game and reports "
      + "pass or fail per step. Turns are ended only in a lab game. A recipe with expect, eval or await-match steps "
      + "runs code, and also needs --allow-eval.",
    input: { file: { type: "string", description: "path to the recipe JSON" } }, required: ["file"],
    run: (ctx, { file }) => {
      refuseRecipeCode(ctx, file);
      return cli(ctx, (c) => FILE_COMMANDS.recipe(c, ["run", file], "recipe"), {});
    },
  },
  {
    name: "lab_start", title: "Start a lab test game", gate: "lab",
    description: "Backs up the player's saves, settings and mod registry, then starts a seeded Play Now test game. "
      + "Refuses if the game or another harness is running. lab_stop restores everything.",
    input: { seed: { type: "integer" }, age: { type: "string", description: "e.g. AGE_ANTIQUITY" } },
    run: (ctx, { seed, age }) => cli(ctx, (c) => LAB_COMMANDS.lab(c, ["start"], "lab"),
      { seed: seed === undefined ? undefined : String(seed), age }),
  },
  {
    name: "lab_turns", title: "End turns in the lab game", gate: "write",
    description: "Ends n turns without Autoplay. Refused in any game the lab did not start.",
    input: { n: { type: "integer", minimum: 1, maximum: 200 } }, required: ["n"],
    run: (ctx, { n }) => cli(ctx, (c) => LAB_COMMANDS.lab(c, ["turns", String(n)], "lab"), {}),
  },
  {
    name: "lab_stop", title: "Stop the lab test game", gate: "write",
    description: "Quits the lab's test game (only that game) and restores every backed-up file and registry flag; "
      + "what the test game wrote is moved aside, not deleted. Reports any crash report the run left.",
    run: (ctx) => cli(ctx, (c) => LAB_COMMANDS.lab(c, ["stop"], "lab"), {}),
  },
  {
    name: "bisect", title: "Find which mod a failure needs", gate: "lab",
    description: "Runs the failure (a crash over n turns, or a failed recipe) in seeded test games with halves of the "
      + "enabled mods, until one mod remains: ISOLATED, INTERACTION, NOT REPRODUCED, NOT A CANDIDATE or INCONCLUSIVE. "
      + "Each trial is a full lab cycle with everything restored after. Takes many minutes per game.",
    input: { recipe: { type: "string", description: "recipe file; else turns" },
      turns: { type: "integer", minimum: 1, maximum: 500 }, seed: { type: "integer" },
      replicates: { type: "integer", minimum: 1, maximum: 5 },
      mods: { type: "array", items: { type: "string" }, description: "limit the candidates to these ids" } },
    run: (ctx, { recipe, turns, seed, replicates, mods }) => {
      refuseRecipeCode(ctx, recipe);
      const str = (v) => (v === undefined ? undefined : String(v));
      return cli(ctx, (c) => LAB_COMMANDS.bisect(c, [], "bisect"),
        { recipe, turns: str(turns), seed: str(seed), replicates: str(replicates), mods: mods?.join(",") });
    },
  },
];
