#!/usr/bin/env node
import { Bench, BenchError } from "./lib/bench.mjs";
import { resolvePaths } from "./lib/paths.mjs";
import { out, parseCli } from "./lib/cli/common.mjs";
import { EVENT_COMMANDS } from "./lib/cli/events.mjs";
import { FILE_COMMANDS } from "./lib/cli/files.mjs";
import { GAME_COMMANDS } from "./lib/cli/game.mjs";
import { LAB_COMMANDS } from "./lib/cli/lab.mjs";
import { INSPECT_COMMANDS } from "./lib/cli/inspect.mjs";
import { LABTOOLS_COMMANDS, LABTOOLS_HELP } from "./lib/cli/labtools.mjs";
import { DOCTOR_COMMANDS, DOCTOR_HELP } from "./lib/cli/doctor.mjs";
import { CHEATS_COMMANDS, CHEATS_HELP } from "./lib/cli/cheats.mjs";
import { PATCH_COMMANDS, PATCH_HELP } from "./lib/cli/patch.mjs";
import { COST_COMMANDS, COST_HELP } from "./lib/cli/cost.mjs";
import { RELEASE_COMMANDS, RELEASE_HELP } from "./lib/cli/release.mjs";
import { MCP_COMMANDS, MCP_HELP } from "./lib/cli/mcp.mjs";
import { LIBRARY_COMMANDS } from "./lib/cli/library.mjs";

const HELP = `tower-bench: a live test bench for Civilization VII mods

Reads and changes a running game through its UI debugger (port 9444). Every write is
re-read until the change is observed, recorded in an evidence log, and can be undone.

  serve [--port 4380]                  web UI at http://127.0.0.1:4380
  status                               connection, scope, turn, players
  eval <code> [--depth 3]              run JS in the game; objects list their methods
  sql <query> [--limit 500]            query the live gameplay database (read-only)
  plot <where>                         what is on a plot

  place unit <TYPE> <where> [--owner N] --yes
  place town <where> [--owner N] --yes
  remove unit <where> [--owner N] [--id N] --yes
  remove town <where> --yes
  set terrain|feature|resource <TYPE|none> <where> [--amount N] --yes
  undo --yes [--skip]                  revert today's most recent landed write; --skip passes over a
                                       newest change that cannot be undone

  mods [--all] [--filter TEXT]         duplicate ids and which copy is live; filter by id, name or author
  mods conflicts [--all] [--level low] [--schema DIR]
                                       static conflicts among the mods the game will load, each with
                                       the command that proves it and the technique that fixes it
  check <mod-folder> [--schema DIR]    will this mod start a game on this version? its defects and
                                       conflicts, read from files (DIR: a saved Debug database copy)
  mods on|off <id> [copy] --yes        switch a mod on or off for the next launch (game closed; undoable)
  mods live <id> <copy> --yes          load this copy and switch the id's other copies off
  logs [--follow] [--level warn] [--mod ID]
  evidence [--md] [--date YYYY-MM-DD]  what the bench did and what the game did back
  smoke --yes <where>                  self-test every write and its undo on one plot

  snap [name]                          save the whole map: plots, units, settlements, players
  snaps                                list saved snapshots
  diff <a> [b|now]                     what changed between two snapshots, or since one
  lint [--scope CSS]                   check the live UI for known GameFace failures
  watch add|invariant <name> <expr>    record a value each turn / require it stays true
  watch list | rm <name> | sample
  deploy <mod-folder> [--yes]          copy changed files into the copy the game loads, reload
                                       the UI (UI.reloadUI), and prove the game runs them
  deploy <mod-folder> --prove          copy nothing; does the game serve your current source?

  events list [text]                   the engine's gameplay events
  events watch <name...> [--log]       stream events as they fire (--log also writes UI.log)
  events wait <name> [--match JS] [--timeout 60]
                                       block until the event fires; exit 0, or 1 on timeout
  agent status | install --yes | set <name...> | off | canvas on|off | remove --yes
                                       a permanent inert UIScript that records events from page
                                       load and through reloads (takes effect at next launch)

  recipe run <file> --yes              run a recipe's steps in the current game
  recipe record [--since HH:MM]        today's landed writes as a recipe (prints JSON)

  lab start [--seed N] [--age AGE_X]   back up saves and settings, start a Play Now test game
  lab turns <n>                        end n turns without Autoplay
  lab run <recipe>                     start a seeded test game, run the recipe, restore
  lab stop                             quit the test game and restore everything it touched
  lab status                           the current test run, if any
  bisect [--recipe F | --turns N] [--seed N] [--replicates 2] [--mods a,b]
                                       find which enabled mod a failure needs

  registry [--json]                    what won in the running game: replaced components, ui-next
                                       overrides, mods applied now vs at the next launch
  canvas probe [--k 1000]              look for a readable canvas resource-pool counter
  canvas count [install]               paint calls counted on this page (agent canvas on: from load)
  canvas stress --yes [--reload-at N]  lab only: paint until the game crashes; read where it died
  techniques [query]                   techniques that work in Civ VII mods, by purpose or engine object
  techniques show <id>                 one technique: why it works, when to use it, a snippet, pitfalls

${[LABTOOLS_HELP, DOCTOR_HELP, CHEATS_HELP, PATCH_HELP, COST_HELP, RELEASE_HELP, MCP_HELP].map((s) => s.replace(/\n?$/, "\n")).join("")}
<where> is "x y", "cursor" (plot under the mouse), "selected" (the selected unit's plot) or
"unit" (the local player's first unit). Writes change the running game and need --yes.
--owner defaults to the local player.
`;

/** @type {Record<string, import("./lib/cli/common.mjs").Handler>} */
const COMMANDS = { ...GAME_COMMANDS, ...FILE_COMMANDS, ...EVENT_COMMANDS, ...LAB_COMMANDS, ...LIBRARY_COMMANDS,
  ...INSPECT_COMMANDS, ...LABTOOLS_COMMANDS, ...DOCTOR_COMMANDS, ...CHEATS_COMMANDS,
  ...PATCH_COMMANDS, ...COST_COMMANDS, ...RELEASE_COMMANDS,
  ...MCP_COMMANDS };

const { values: opt, positionals: pos } = parseCli();
const paths = resolvePaths();
const bench = new Bench(paths);

async function main() {
  const [cmd, ...rest] = pos;
  if (!cmd || opt.help) return out(HELP);
  if (!Object.hasOwn(COMMANDS, cmd)) throw new BenchError(`unknown command "${cmd}"; see --help`);
  return COMMANDS[cmd]({ bench, paths, opt }, rest, cmd);
}

main()
  .catch((e) => {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (!["serve"].includes(pos[0]) && !(pos[0] === "logs" && opt.follow)) bench.close();
  });
