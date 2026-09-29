#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { Bench, BenchError } from "./lib/bench.mjs";
import { localDate, toMarkdown } from "./lib/evidence.mjs";
import fs from "node:fs";
import { bisect } from "./lib/bisect.mjs";
import { Lab, applyModSet, candidateMods, gamePid, preflight } from "./lib/lab.mjs";
import { recipeFromEvidence, runRecipe, validateRecipe } from "./lib/recipes.mjs";
import { AGENT_ID, agentStatus, describeEvent, eventCatalogue, writeAgent } from "./lib/events.mjs";
import { LogTail, readRecent } from "./lib/logs.mjs";
import { modHealth, readMods } from "./lib/mods.mjs";
import { resolvePaths } from "./lib/paths.mjs";
import { startServer } from "./lib/server.mjs";

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
  undo --yes                           revert today's most recent landed write

  mods [--all]                         duplicate ids and which copy is live
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
  agent status | install --yes | set <name...> | off | remove --yes
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

<where> is "x y", "cursor" (plot under the mouse), "selected" (the selected unit's plot) or
"unit" (the local player's first unit). Writes change the running game and need --yes.
--owner defaults to the local player.
`;

const { values: opt, positionals: pos } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string" }, depth: { type: "string" }, limit: { type: "string" },
    owner: { type: "string" }, id: { type: "string" }, amount: { type: "string" },
    yes: { type: "boolean" }, all: { type: "boolean" }, follow: { type: "boolean" },
    level: { type: "string" }, mod: { type: "string" }, md: { type: "boolean" },
    date: { type: "string" }, help: { type: "boolean", short: "h" },
    seed: { type: "string" }, age: { type: "string" },
    scope: { type: "string" }, json: { type: "boolean" }, since: { type: "string" },
    turns: { type: "string" }, replicates: { type: "string" }, mods: { type: "string" },
    recipe: { type: "string" }, prove: { type: "boolean" },
    match: { type: "string" }, timeout: { type: "string" }, for: { type: "string" }, log: { type: "boolean" },
    backlog: { type: "boolean" }, "no-reload": { type: "boolean" },
  },
});

const paths = resolvePaths();
const bench = new Bench(paths);
const out = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
const num = (v) => (v === undefined ? undefined : Number(v));

async function where(tokens) {
  const [a, b] = tokens;
  if (a === "cursor") {
    const c = await bench.cursor();
    if (!c) throw new BenchError("no plot under the cursor: hover the map in game first");
    return { at: c, rest: tokens.slice(1) };
  }
  if (a === "selected" || a === "unit") {
    const st = await bench.status();
    if (!st.connected) throw new BenchError(`not connected to the game: ${st.reason}`);
    const s = a === "selected" ? st.snapshot?.selectedUnit : st.snapshot?.firstUnit;
    if (!s) throw new BenchError(a === "selected" ? "no unit is selected in game" : "the local player has no units");
    return { at: { x: s.x, y: s.y }, rest: tokens.slice(1) };
  }
  if (!Number.isInteger(Number(a)) || !Number.isInteger(Number(b))) throw new BenchError(`expected "x y", "cursor", "selected" or "unit", got "${tokens.join(" ")}"`);
  return { at: { x: Number(a), y: Number(b) }, rest: tokens.slice(2) };
}

async function localPlayer() {
  return (await bench.status()).snapshot?.localPlayer ?? 0;
}

function printWrite(r) {
  const timing = r.verdict === "LANDED" ? ` in ${r.landedMs} ms` : r.verdict === "NO EFFECT" ? ` (waited ${r.waitedMs} ms)` : "";
  out(`${r.undid ? `undo of: ${r.undid}\n` : ""}${r.description ?? ""}: ${r.verdict}${timing}${r.reason ? ` — ${r.reason}` : ""}`);
  if (r.sent) out(`  engine returned ${JSON.stringify(r.returned)}${r.canStart !== undefined ? `, canStart ${JSON.stringify(r.canStart)}` : ""} (neither proves anything)`);
  for (const h of r.hints ?? []) out(`  note: ${h}`);
  if (r.inverse) out(`  undo with: tower-bench undo --yes`);
  if (r.snippet) out(`  as mod code:\n    ${r.snippet.replaceAll("\n", "\n    ")}`);
}

async function doWrite(request) {
  if (!opt.yes) throw new BenchError("this changes the running game; add --yes");
  bench.armed = true;
  const r = await bench.write(request);
  printWrite(r);
  return r;
}

async function smoke(tokens) {
  if (!opt.yes) throw new BenchError("smoke places and removes things in the running game; add --yes");
  bench.armed = true;
  const { at } = await where(tokens);
  const owner = await localPlayer();
  const plot = await bench.plot(at.x, at.y);
  if (!plot.valid) throw new BenchError("that plot is off the map");
  const cat = await bench.catalogs();
  // Unit rows are age-specific, so take a scout-like unit from the loaded game rather than hardcoding one.
  const unit = cat.units.find((u) => /SCOUT|EXPLORER/.test(u.type))?.type ?? cat.units[0].type;
  const steps = [{ op: "unit.place", args: { ...at, owner, type: unit } }];
  // Terrain round-trips (watched here and in the canals probe). Features are left out: on some plots a
  // placement is deferred (watched 2026-09-26), which would leave the plot changed after the undo.
  const swap = { TERRAIN_FLAT: "TERRAIN_HILL", TERRAIN_HILL: "TERRAIN_FLAT" }[plot.terrain];
  if (swap) steps.push({ op: "terrain.set", args: { ...at, type: swap } });
  else out(`note: ${plot.terrain} is not flat or hill, so the terrain round trip is skipped`);
  const results = [];
  for (const s of steps) {
    const r = await bench.write(s);
    results.push({ step: r.description, verdict: r.verdict, ms: r.landedMs });
    if (r.verdict === "LANDED" || r.verdict === "UNEXPECTED") {
      const u = await bench.undo();
      results.push({ step: `undo: ${u.undid}`, verdict: u.verdict, ms: u.landedMs });
    }
  }
  const after = await bench.plot(at.x, at.y);
  const same = ["terrain", "feature", "resource"].every((k) => after[k] === plot[k]) && after.units.length === plot.units.length;
  out(results.map((r) => `${r.verdict.padEnd(10)} ${String(r.ms ?? "-").padStart(5)} ms  ${r.step}`).join("\n"));
  out(same ? "plot restored to its starting state" : `PLOT DIFFERS FROM START: ${JSON.stringify({ before: plot, after })}`);
  return results.every((r) => r.verdict === "LANDED") && same;
}

async function eventsCommand([sub, ...names]) {
  const catalogue = eventCatalogue(paths);
  if (sub === "list") {
    const f = names.join(" ").toLowerCase();
    const list = f ? catalogue.filter((n) => n.toLowerCase().includes(f)) : catalogue;
    if (list.length) out(list.join("\n"));
    return out(`${list.length} of ${catalogue.length} gameplay events; UI events such as UnitSelectionChanged work too`);
  }
  if (sub !== "watch" && sub !== "wait") throw new BenchError("events list | watch <name...> | wait <name>");
  if (!names.length) throw new BenchError(`events ${sub} needs at least one event name (see "events list")`);
  for (const n of names) if (catalogue.length && !catalogue.includes(n)) out(`note: ${n} is not a declared gameplay event; if it is a UI event it still works, otherwise nothing will arrive`);
  const unsubscribe = async () => { try { await bench.events.set([]); } catch { /* game gone */ } };
  if (sub === "watch") {
    await bench.events.set(names, { log: !!opt.log });
    // The page buffer is shared with the agent and holds everything since the page loaded: take it in
    // silently, then show only the requested events from now on (--backlog shows the history too).
    await bench.events.poll();
    if (opt.backlog) for (const e of bench.events.history) if (names.includes(e.name)) out(describeEvent(e));
    bench.events.on("event", (e) => { if (names.includes(e.name)) out(describeEvent(e)); });
    bench.events.on("gap", (g) => out(`--- ${g.note} ---`));
    bench.events.on("dropped", (d) => out(`--- ${d.count} event(s) fell out of the page buffer before they were read ---`));
    out(`listening for ${names.join(", ")}${opt.log ? ", also writing UI.log" : ""}. Ctrl-C stops and unsubscribes.`);
    const stop = async () => { await unsubscribe(); bench.close(); process.exit(0); };
    process.on("SIGINT", stop);
    if (opt.for) setTimeout(stop, num(opt.for) * 1000);
    return new Promise(() => {});
  }
  const [name] = names;
  await bench.events.set([name]);
  await bench.events.poll();
  // "wait" means the next one: anything the page recorded before now does not count.
  const w = await bench.events.waitFor({ event: name, match: opt.match, timeoutMs: (num(opt.timeout) ?? 60) * 1000, from: bench.events.history.length });
  await unsubscribe();
  process.exitCode = w.ok ? 0 : 1;
  return out(w.ok ? describeEvent(w.event) : `no ${name}${opt.match ? ` matching ${opt.match}` : ""} within ${num(opt.timeout) ?? 60} s`);
}

async function agentCommand([sub, ...names]) {
  const st = agentStatus(paths);
  switch (sub ?? "status") {
    case "status":
      if (!st.installed) return out(`not installed (would live at ${st.dir})`);
      return out(`installed at ${st.dir}\n${st.subscriptions?.length ? `records from page load: ${st.subscriptions.join(", ")}` : "inert: its event list is empty"}`);
    case "install": {
      if (!opt.yes) throw new BenchError(`installs ${AGENT_ID} into Mods/, where it loads into every game (inert until given events); add --yes`);
      const dir = writeAgent(paths, names);
      return out(`wrote ${dir}. The game registers it at its next launch${names.length ? `; it will record ${names.join(", ")} from page load` : "; it stays inert until \"agent set\""}.`);
    }
    case "set":
    case "off": {
      if (!st.installed) throw new BenchError("the agent is not installed; agent install --yes first");
      writeAgent(paths, sub === "off" ? [] : names);
      return out(sub === "off" ? "agent is inert from the next page load" : `agent records ${names.join(", ")} from the next page load (a reload, an age transition or a new game)`);
    }
    case "remove": {
      if (!st.installed) return out("not installed");
      if (!opt.yes) throw new BenchError("add --yes to move the agent out of Mods/");
      const to = path.join(path.dirname(paths.evidence), "removed", `${AGENT_ID}-${stampNow()}`);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(st.dir, to);
      return out(`moved to ${to} (not deleted). The game drops it at its next launch.`);
    }
    default:
      throw new BenchError("agent status | install --yes [events...] | set <events...> | off | remove --yes");
  }
}

function printRestore(rep) {
  out(`[lab] restored: ${rep.restored.join(", ") || "nothing"}`);
  if (rep.moved.length) out(`[lab] what the test game wrote was moved aside, not deleted: ${rep.moved.join(", ")}`);
  for (const r of rep.registry) out(`[lab] registry: ${r.id} ${r.note ?? `Disabled ${r.from} -> ${r.to}`}`);
  if (!rep.registry.length) out("[lab] registry: unchanged");
  for (const f of rep.crashReports) out(`[lab] CRASH REPORT: ${f}`);
}

function loadRecipe(file) {
  if (!file) throw new BenchError("which recipe file?");
  let r;
  try { r = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new BenchError(`cannot read recipe ${file}: ${e.message}`); }
  const problem = validateRecipe(r);
  if (problem) throw new BenchError(`${file}: ${problem}`);
  return r;
}

const stampNow = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

async function labStart(lab, { seed, age, say }) {
  if (lab.current) throw new BenchError(`a test run is already in progress (${lab.current.dir}); "lab stop" first`);
  const pf = preflight(paths);
  for (const w of pf.warnings) say(`warning: ${w}`);
  if (pf.problems.length) throw new BenchError(pf.problems.join("; "));
  const dir = path.join(lab.root, stampNow());
  const b = lab.backup(dir);
  say(`backed up ${b.files.join(", ")} and ${b.registryRows} registry rows to ${dir}`);
  lab.setCurrent({ dir, startedAt: new Date().toISOString(), seed: seed ?? null, age: age ?? null });
  try {
    const r = await lab.startNewGame({ seed, age, log: say });
    lab.setCurrent({ ...lab.current, pid: r.pid, setup: r.setup });
    return r;
  } catch (e) {
    say(`start failed: ${e.message}. Quitting and restoring.`);
    await lab.quit({ log: say });
    printRestore(lab.restore(dir));
    lab.setCurrent(null);
    throw new BenchError("lab start failed; your saves, settings and registry are restored");
  }
}

async function labStop(lab, say) {
  const cur = lab.current;
  if (!cur) throw new BenchError("no test run in progress");
  const q = await lab.quit({ log: say });
  if (!q.wasRunning) {
    say("the game had already exited; waiting 50 s for a crash report to land");
    await new Promise((r) => setTimeout(r, 50000));
  } else {
    say(`game ${q.pid} quit`);
  }
  const rep = lab.restore(cur.dir);
  printRestore(rep);
  lab.setCurrent(null);
  return rep;
}

async function bisectCommand() {
  const lab = new Lab(paths);
  const say = (m) => out(`[bisect] ${m}`);
  if (lab.current) throw new BenchError(`a test run is in progress (${lab.current.dir}); "lab stop" first`);
  const pf = preflight(paths);
  if (pf.problems.length) throw new BenchError(pf.problems.join("; "));
  const recipe = opt.recipe ? loadRecipe(opt.recipe) : null;
  const turns = num(opt.turns) ?? (recipe ? null : 20);
  const seed = num(opt.seed) ?? recipe?.seed ?? 4242;
  const age = opt.age ?? recipe?.age;
  const replicates = num(opt.replicates) ?? 2;
  const all = candidateMods(paths.modsDb);
  const wanted = opt.mods ? new Set(opt.mods.split(",")) : null;
  const candidates = wanted ? all.filter((c) => wanted.has(c.id)) : all;
  if (!candidates.length) throw new BenchError("no enabled, non-official mods to bisect over");
  say(`${candidates.length} candidate mods, seed ${seed}, ${replicates} replicate(s) per configuration, ${recipe ? `recipe ${recipe.name ?? opt.recipe}` : `${turns} turns`}`);

  const trial = async (enabledIds) => {
    const dir = path.join(lab.root, `bisect-${stampNow()}`);
    lab.backup(dir);
    lab.setCurrent({ dir, startedAt: new Date().toISOString(), seed, age: age ?? null, bisect: true });
    let failed = false;
    let detail = "";
    try {
      applyModSet(paths.modsDb, candidates, enabledIds);
      let started = false;
      try {
        await lab.startNewGame({ seed, age });
        started = true;
        lab.setCurrent({ ...lab.current, pid: gamePid() });
        if (recipe) {
          bench.armed = true;
          const r = await runRecipe(bench, recipe, { endTurns: (n) => lab.endTurns(n) });
          if (!r.passed) { failed = true; detail = `recipe failed at step ${r.results.find((x) => !x.ok)?.step}`; }
        } else {
          await lab.endTurns(turns);
        }
      } catch (e) {
        if (!started) { failed = true; detail = `the game did not start: ${e.message}`; } else detail = e.message;
      }
      if (!gamePid()) { failed = true; detail ||= "the game exited"; await new Promise((r) => setTimeout(r, 50000)); }
    } finally {
      await lab.quit();
      const rep = lab.restore(dir);
      lab.setCurrent(null);
      if (rep.crashReports.length) { failed = true; detail = `crash report ${path.basename(rep.crashReports[0])}`; }
    }
    return { failed, detail };
  };

  const result = await bisect({ candidates: candidates.map((c) => c.id), trial, replicates, log: say });
  const report = path.join(lab.root, `bisect-${stampNow()}.json`);
  fs.writeFileSync(report, JSON.stringify({ seed, age, turns, recipe: opt.recipe ?? null, replicates, ...result }, null, 2));
  say(`${result.verdict}${result.culprit ? `: ${result.culprit}` : ""}. ${result.detail}`);
  say(`${result.trials.length} game(s) run; report at ${report}`);
  process.exitCode = result.verdict === "ISOLATED" ? 0 : 1;
}

async function labCommand(args) {
  const lab = new Lab(paths);
  // The lab holds its own debugger socket; left open it keeps the process alive after the command is done.
  try {
    return await labSubcommand(lab, args);
  } finally {
    lab.cdp.close();
  }
}

async function labSubcommand(lab, [sub, ...more]) {
  const say = (m) => out(`[lab] ${m}`);
  const cur = lab.current;
  switch (sub) {
    case "status": {
      out(cur ? `test run ${cur.dir}, started ${cur.startedAt}${cur.seed != null ? `, seed ${cur.seed}` : ""}` : "no test run in progress");
      return out(`game ${gamePid() ? `running (pid ${gamePid()})` : "not running"}`);
    }
    case "start": {
      const r = await labStart(lab, { seed: num(opt.seed), age: opt.age, say });
      return say(`ready at turn ${r.turn}. Use the bench as normal; "lab stop" restores everything.`);
    }
    case "run": {
      const recipe = loadRecipe(more[0]);
      await labStart(lab, { seed: num(opt.seed) ?? recipe.seed, age: opt.age ?? recipe.age, say });
      bench.armed = true;
      let r;
      try {
        r = await runRecipe(bench, recipe, { endTurns: (n) => lab.endTurns(n, { log: say }), log: say });
      } finally {
        await labStop(lab, say);
      }
      process.exitCode = r.passed ? 0 : 1;
      return say(r.passed ? "recipe passed" : "recipe FAILED");
    }
    case "turns": {
      // Never end turns in a game the lab did not start: that could be the player's campaign.
      if (!cur?.pid || gamePid() !== cur.pid) throw new BenchError("the running game is not this lab's test game");
      const rolled = await lab.endTurns(Number(more[0] ?? 1), { log: say });
      return say(`${rolled.length} turn(s) ended${rolled.some((r) => r.blocker) ? `; blockers seen: ${[...new Set(rolled.map((r) => r.blocker).filter(Boolean))].join(", ")}` : ""}`);
    }
    case "stop": {
      await labStop(lab, say);
      return undefined;
    }
    default:
      throw new BenchError("lab start|turns|stop|status");
  }
}

async function main() {
  const [cmd, ...rest] = pos;
  if (!cmd || opt.help) return out(HELP);
  switch (cmd) {
    case "serve": {
      const port = num(opt.port) ?? 4380;
      await startServer(bench, { port });
      out(`tower-bench at http://127.0.0.1:${port}  (game debugger on port ${paths.cdpPort})`);
      return new Promise(() => {});
    }
    case "status": {
      const s = await bench.status();
      if (!s.connected) return out(`offline: ${s.reason}\nIs the game running with the UI debugger on port ${paths.cdpPort}?`);
      out(`connected: ${s.scope} scope, game ${s.version ?? "version unknown"}`);
      if (s.snapshot) {
        const g = s.snapshot;
        out(`turn ${g.turn}, ${g.age}, map ${g.map.width}x${g.map.height}, local player ${g.localPlayer}`);
        for (const p of g.players) out(`  ${String(p.id).padStart(3)}  ${p.name}${p.civ ? ` (${p.civ})` : ""}${p.major ? "" : p.independent ? "  [independent]" : "  [minor]"}${p.human ? "  [human]" : ""}`);
        if (g.selectedUnit) out(`selected: ${g.selectedUnit.type} at (${g.selectedUnit.x}, ${g.selectedUnit.y})`);
      }
      return out(`undoable writes today: ${s.undo}`);
    }
    case "eval": return out(await bench.eval(rest.join(" "), { depth: num(opt.depth) ?? 3 }));
    case "sql": {
      const r = await bench.sql(rest.join(" "), { limit: num(opt.limit) ?? 500 });
      if (r.rows.length) console.table(r.rows);
      return out(`${r.total} row(s)${r.truncated ? `, showing ${r.rows.length}` : ""}`);
    }
    case "plot": {
      const { at } = await where(rest);
      return out(await bench.plot(at.x, at.y));
    }
    case "place":
    case "remove": {
      const [kind, ...more] = rest;
      if (kind === "unit" && cmd === "place") {
        const [type, ...loc] = more;
        const { at } = await where(loc);
        return doWrite({ op: "unit.place", args: { ...at, type, owner: num(opt.owner) ?? await localPlayer() } });
      }
      const { at } = await where(more);
      if (kind === "unit") return doWrite({ op: "unit.remove", args: { ...at, owner: num(opt.owner), id: num(opt.id) } });
      if (kind === "town" && cmd === "place") return doWrite({ op: "town.place", args: { ...at, owner: num(opt.owner) ?? await localPlayer() } });
      if (kind === "town") return doWrite({ op: "town.remove", args: at });
      throw new BenchError(`unknown: ${cmd} ${kind}`);
    }
    case "set": {
      const [kind, type, ...loc] = rest;
      if (!["terrain", "feature", "resource"].includes(kind)) throw new BenchError("set terrain|feature|resource <TYPE|none> <where>");
      const { at } = await where(loc);
      const t = type === "none" ? null : type;
      if (kind === "terrain" && !t) throw new BenchError("terrain cannot be none");
      return doWrite({ op: `${kind}.set`, args: { ...at, type: t, ...(opt.amount ? { amount: num(opt.amount) } : {}) } });
    }
    case "undo": {
      if (!opt.yes) throw new BenchError("undo changes the running game; add --yes");
      bench.armed = true;
      return printWrite(await bench.undo());
    }
    case "mods": {
      const mods = modHealth(readMods(paths.modsDb), paths);
      const shown = opt.all ? mods : mods.filter((m) => m.issues.length);
      for (const m of shown) {
        out(`${m.enabled ? "on " : "off"}  ${m.id}${m.name !== m.id ? `  (${m.name})` : ""}`);
        for (const c of m.copies) out(`       ${c.enabled ? "live" : "    "}  ${c.source.label}  v${c.version}`);
        for (const i of m.issues) out(`       ${i.severity}: ${i.text}`);
      }
      return out(`${mods.length} mod ids, ${mods.filter((m) => m.enabled).length} enabled, ${mods.filter((m) => m.issues.length).length} with notes${opt.all ? "" : " (--all lists every mod)"}`);
    }
    case "logs": {
      const rank = { noise: 0, info: 1, warn: 2, error: 3 };
      const min = rank[opt.level ?? "warn"] ?? 2;
      const show = (lines) => {
        for (const l of lines) {
          if (rank[l.severity] < min || (opt.mod && l.mod !== opt.mod)) continue;
          out(`[${l.severity}] ${l.file}: ${l.text.trim()}`);
          if (l.hint) out(`        ${l.hint}`);
        }
      };
      show(readRecent(paths.logs));
      if (!opt.follow) return undefined;
      const tail = new LogTail(paths.logs);
      tail.seekToEnd();
      setInterval(() => show(tail.poll()), 700);
      return new Promise(() => {});
    }
    case "evidence": {
      const entries = bench.evidence.read(opt.date ?? localDate());
      if (opt.md) return out(toMarkdown(entries) || "(no writes recorded that day)");
      for (const e of entries) out(`${e.ts.slice(11, 19)}  ${e.kind.padEnd(5)}  ${JSON.stringify(e.request).slice(0, 90)}  ${e.result?.verdict ?? e.result?.error ?? ""}`);
      return out(`${entries.length} entries in ${bench.evidence.fileFor(opt.date ?? localDate())}`);
    }
    case "smoke": {
      const ok = await smoke(rest);
      process.exitCode = ok ? 0 : 1;
      return undefined;
    }
    case "lab": return labCommand(rest);
    case "events": return eventsCommand(rest);
    case "agent": return agentCommand(rest);
    case "bisect": return bisectCommand();
    case "snap": return out(await bench.snapshot(rest[0]));
    case "snaps": {
      const list = bench.snapshots.list();
      for (const s of list) out(`${s.label.padEnd(28)} turn ${String(s.turn).padStart(4)}  ${s.size}  ${s.takenAt}`);
      return out(`${list.length} snapshot(s)`);
    }
    case "diff": {
      if (!rest[0]) throw new BenchError("diff <snapshot> [other|now]");
      const d = await bench.diff(rest[0], rest[1] ?? "now");
      return out(opt.json ? d.diff : d.text);
    }
    case "lint": {
      const r = await bench.lint(opt.scope);
      if (r.error) throw new BenchError(r.error);
      if (opt.json) return out(r);
      const byRule = new Map();
      for (const i of r.issues) byRule.set(i.rule, [...(byRule.get(i.rule) ?? []), i]);
      for (const [rule, list] of byRule) {
        out(`${rule} (${list.length}): ${list[0].detail}`);
        for (const i of list.slice(0, 8)) out(`    ${i.path}`);
        if (list.length > 8) out(`    … ${list.length - 8} more`);
      }
      return out(`${r.issues.length} issue(s) in ${r.visited} element(s)${r.truncated ? " (stopped at the element limit)" : ""}`);
    }
    case "watch": {
      const [sub, name, ...expr] = rest;
      if (sub === "add" || sub === "invariant") {
        bench.watches.add(sub === "add" ? "watches" : "invariants", name, expr.join(" "));
        return out(`${sub === "add" ? "watch" : "invariant"} ${name} saved; "tower-bench serve" samples it every turn`);
      }
      if (sub === "rm") { bench.watches.remove(name); return out(`removed ${name}`); }
      if (sub === "sample") return out(await bench.sampleWatches() ?? "no watches or invariants defined");
      const d = bench.watches.defs();
      for (const w of d.watches) out(`watch      ${w.name}: ${w.expr}`);
      for (const w of d.invariants) out(`invariant  ${w.name}: ${w.expr}`);
      return out(`${d.watches.length} watch(es), ${d.invariants.length} invariant(s)`);
    }
    case "deploy": {
      if (!rest[0]) throw new BenchError("deploy <mod-folder> [--yes | --prove]");
      if (opt.prove) {
        const pr = await bench.prove(rest[0]);
        if (pr.refuse) out(`note: ${pr.refuse}`);
        for (const f of pr.files) out(`  ${f.live.padEnd(18)} ${f.rel}`);
        const stale = pr.files.filter((f) => f.live !== "SERVED").length;
        process.exitCode = stale ? 1 : 0;
        return out(stale ? `${stale} of ${pr.files.length} UI file(s) are not what the game serves` : `all ${pr.files.length} UI file(s) are what the game serves`);
      }
      const r = await bench.deploy(rest[0], { yes: !!opt.yes, reload: !opt["no-reload"] });
      const p = r.plan;
      if (p.refuse) throw new BenchError(p.refuse);
      out(`${p.modId}: live copy is ${p.liveLabel} (${p.liveDir})`);
      if (p.ownDeploy) out(`note: this mod has its own deploy (${p.ownDeploy}). Prefer it: it can ship files the modinfo does not declare, such as images. Then run "deploy ${rest[0]} --prove".`);
      if (p.inPlace) return out("that folder IS the live copy, so edits there are already on disk; nothing to copy");
      for (const m of p.missing) out(`  declared but missing in the source: ${m}`);
      if (!p.changes.length) return out("the live copy already matches the source");
      if (!r.applied) {
        for (const c of p.changes) out(`  would copy (${c.state}) ${c.rel}`);
        return out(`${p.changes.length} file(s) differ; add --yes to copy them`);
      }
      for (const f of r.files) out(`  ${f.live.padEnd(18)} ${f.state.padEnd(8)} ${f.rel}`);
      if (!r.connected) return out("copied. The game is not running, so nothing could be proven live yet.");
      return out(r.reloaded ? "the page reloaded after the copy, so SERVED files are now the running code"
        : r.reloaded === false ? "the page did NOT reload: SERVED files are on disk but the old code is still running (--no-reload, or not in a game)"
          : "could not tell whether the page reloaded");
    }
    case "recipe": {
      const [sub, file] = rest;
      if (sub === "record") return out(recipeFromEvidence(bench.evidence.read(localDate()), { since: opt.since }));
      if (sub === "run") {
        if (!opt.yes) throw new BenchError("a recipe changes the running game; add --yes");
        bench.armed = true;
        const lab = new Lab(paths);
        const inLab = lab.current?.pid && gamePid() === lab.current.pid;
        const r = await runRecipe(bench, loadRecipe(file), { endTurns: inLab ? (n) => lab.endTurns(n) : null, log: (m) => out(m) });
        process.exitCode = r.passed ? 0 : 1;
        return out(r.passed ? "recipe passed" : "recipe FAILED");
      }
      throw new BenchError("recipe run <file> --yes | recipe record [--since HH:MM]");
    }
    default:
      throw new BenchError(`unknown command "${cmd}"; see --help`);
  }
}

main()
  .catch((e) => {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (!["serve"].includes(pos[0]) && !(pos[0] === "logs" && opt.follow)) bench.close();
  });
