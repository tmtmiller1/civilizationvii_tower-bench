import { BenchError } from "../bench.mjs";
import { startServer } from "../server.mjs";
import { localPlayer, num, out, where } from "./common.mjs";

/** @typedef {import("./common.mjs").Ctx} Ctx */

const SET_KINDS = ["terrain", "feature", "resource"];

function playerLine(p) {
  const kind = p.major ? "" : p.independent ? "  [independent]" : "  [minor]";
  return `  ${String(p.id).padStart(3)}  ${p.name}${p.civ ? ` (${p.civ})` : ""}${kind}${p.human ? "  [human]" : ""}`;
}

function printSnapshot(g) {
  out(`turn ${g.turn}, ${g.age}, map ${g.map.width}x${g.map.height}, local player ${g.localPlayer}`);
  for (const p of g.players) out(playerLine(p));
  if (g.selectedUnit) out(`selected: ${g.selectedUnit.type} at (${g.selectedUnit.x}, ${g.selectedUnit.y})`);
}

function writeTiming(r) {
  if (r.verdict === "LANDED") return ` in ${r.landedMs} ms`;
  return r.verdict === "NO EFFECT" ? ` (waited ${r.waitedMs} ms)` : "";
}

const flagText = (v) => (v === null || v === undefined ? "default" : Number(v) ? "off" : "on");

function printDetails(r) {
  if (r.sent) {
    const canStart = r.canStart !== undefined ? `, canStart ${JSON.stringify(r.canStart)}` : "";
    out(`  engine returned ${JSON.stringify(r.returned)}${canStart} (neither proves anything)`);
  }
  for (const c of r.changes ?? []) out(`  ${c.label}: ${flagText(c.from)} -> ${flagText(c.to)}`);
  if (r.note) out(`  ${r.note}`);
}

export function printWrite(r) {
  const undid = r.undid ? `undo of: ${r.undid}\n` : "";
  out(`${undid}${r.description ?? ""}: ${r.verdict}${writeTiming(r)}${r.reason ? `: ${r.reason}` : ""}`);
  printDetails(r);
  for (const h of r.hints ?? []) out(`  note: ${h}`);
  if (r.inverse) out(`  undo with: tower-bench undo --yes`);
  if (r.snippet) out(`  as mod code:\n    ${r.snippet.replaceAll("\n", "\n    ")}`);
}

/** @param {Ctx} ctx */
async function doWrite({ bench, opt }, request) {
  if (!opt.yes) throw new BenchError("this changes the running game; add --yes");
  bench.armed = true;
  const r = await bench.write(request);
  printWrite(r);
  return r;
}

/** @param {Ctx} ctx */
async function ownerOrLocal({ bench, opt }) {
  return num(opt.owner) ?? await localPlayer(bench);
}

/** @param {Ctx} ctx @param {string[]} args */
async function place(ctx, args) {
  const [kind, ...more] = args;
  if (kind === "unit") {
    const [type, ...loc] = more;
    const { at } = await where(ctx.bench, loc);
    return doWrite(ctx, { op: "unit.place", args: { ...at, type, owner: await ownerOrLocal(ctx) } });
  }
  const { at } = await where(ctx.bench, more);
  if (kind === "town") return doWrite(ctx, { op: "town.place", args: { ...at, owner: await ownerOrLocal(ctx) } });
  throw new BenchError(`unknown: place ${kind}`);
}

/** @param {Ctx} ctx @param {string[]} args */
async function remove(ctx, args) {
  const [kind, ...more] = args;
  const { at } = await where(ctx.bench, more);
  const { opt } = ctx;
  if (kind === "unit") return doWrite(ctx, { op: "unit.remove", args: { ...at, owner: num(opt.owner), id: num(opt.id) } });
  if (kind === "town") return doWrite(ctx, { op: "town.remove", args: at });
  throw new BenchError(`unknown: remove ${kind}`);
}

/** @param {Ctx} ctx @param {string[]} args */
async function setPlot(ctx, args) {
  const [kind, type, ...loc] = args;
  if (!SET_KINDS.includes(kind)) throw new BenchError("set terrain|feature|resource <TYPE|none> <where>");
  const { at } = await where(ctx.bench, loc);
  const t = type === "none" ? null : type;
  if (kind === "terrain" && !t) throw new BenchError("terrain cannot be none");
  const amount = ctx.opt.amount ? { amount: num(ctx.opt.amount) } : {};
  return doWrite(ctx, { op: `${kind}.set`, args: { ...at, type: t, ...amount } });
}

async function smokeSteps(bench, at, plot, owner) {
  const cat = await bench.catalogs();
  // Unit rows are age-specific, so take a scout-like unit from the loaded game rather than hardcoding one.
  const unit = cat.units.find((u) => /SCOUT|EXPLORER/.test(u.type))?.type ?? cat.units[0].type;
  const steps = [{ op: "unit.place", args: { ...at, owner, type: unit } }];
  // Terrain round-trips (watched 2026-09-26). Features are left out: on some plots a
  // placement is deferred (watched 2026-09-26), which would leave the plot changed after the undo.
  const swap = { TERRAIN_FLAT: "TERRAIN_HILL", TERRAIN_HILL: "TERRAIN_FLAT" }[plot.terrain];
  if (swap) steps.push({ op: "terrain.set", args: { ...at, type: swap } });
  else out(`note: ${plot.terrain} is not flat or hill, so the terrain round trip is skipped`);
  return steps;
}

async function runSmokeSteps(bench, steps) {
  const results = [];
  for (const s of steps) {
    const r = await bench.write(s);
    results.push({ step: r.description, verdict: r.verdict, ms: r.landedMs });
    if (r.verdict === "LANDED" || r.verdict === "UNEXPECTED") {
      const u = await bench.undo();
      results.push({ step: `undo: ${u.undid}`, verdict: u.verdict, ms: u.landedMs });
    }
  }
  return results;
}

const samePlot = (a, b) => ["terrain", "feature", "resource"].every((k) => a[k] === b[k]) && a.units.length === b.units.length;

/** @param {Ctx} ctx @param {string[]} tokens */
async function smoke({ bench, opt }, tokens) {
  if (!opt.yes) throw new BenchError("smoke places and removes things in the running game; add --yes");
  bench.armed = true;
  const { at } = await where(bench, tokens);
  const owner = await localPlayer(bench);
  const plot = await bench.plot(at.x, at.y);
  if (!plot.valid) throw new BenchError("that plot is off the map");
  const results = await runSmokeSteps(bench, await smokeSteps(bench, at, plot, owner));
  const after = await bench.plot(at.x, at.y);
  const same = samePlot(after, plot);
  out(results.map((r) => `${r.verdict.padEnd(10)} ${String(r.ms ?? "-").padStart(5)} ms  ${r.step}`).join("\n"));
  out(same ? "plot restored to its starting state" : `PLOT DIFFERS FROM START: ${JSON.stringify({ before: plot, after })}`);
  return results.every((r) => r.verdict === "LANDED") && same;
}

function printLintIssues(issues) {
  const byRule = new Map();
  for (const i of issues) byRule.set(i.rule, [...(byRule.get(i.rule) ?? []), i]);
  for (const [rule, list] of byRule) {
    out(`${rule} (${list.length}): ${list[0].detail}`);
    for (const i of list.slice(0, 8)) out(`    ${i.path}`);
    if (list.length > 8) out(`    ... ${list.length - 8} more`);
  }
}

/** @param {Ctx} ctx */
function listWatches({ bench }) {
  const d = bench.watches.defs();
  for (const w of d.watches) out(`watch      ${w.name}: ${w.expr}`);
  for (const w of d.invariants) out(`invariant  ${w.name}: ${w.expr}`);
  return out(`${d.watches.length} watch(es), ${d.invariants.length} invariant(s)`);
}

/** @param {Ctx} ctx @param {string} sub @param {string} name @param {string[]} expr */
function addWatch({ bench }, sub, name, expr) {
  bench.watches.add(sub === "add" ? "watches" : "invariants", name, expr.join(" "));
  return out(`${sub === "add" ? "watch" : "invariant"} ${name} saved; "tower-bench serve" samples it every turn`);
}

/** @type {Record<string, import("./common.mjs").Handler>} */
export const GAME_COMMANDS = {
  serve: async ({ bench, paths, opt }) => {
    const port = num(opt.port) ?? 4380;
    await startServer(bench, { port });
    out(`tower-bench at http://127.0.0.1:${port}  (game debugger on port ${paths.cdpPort})`);
    return new Promise(() => {});
  },
  status: async ({ bench, paths }) => {
    const s = await bench.status();
    if (!("snapshot" in s)) {
      return out(`offline: ${s.reason}\nIs the game running with the UI debugger on port ${paths.cdpPort}?`);
    }
    out(`connected: ${s.scope} scope, game ${s.version ?? "version unknown"}`);
    if (s.snapshot) printSnapshot(s.snapshot);
    return out(`undoable writes today: ${s.undo}`);
  },
  eval: async ({ bench, opt }, args) => out(await bench.eval(args.join(" "), { depth: num(opt.depth) ?? 3 })),
  sql: async ({ bench, opt }, args) => {
    const r = await bench.sql(args.join(" "), { limit: num(opt.limit) ?? 500 });
    if (r.rows.length) console.table(r.rows);
    return out(`${r.total} row(s)${r.truncated ? `, showing ${r.rows.length}` : ""}`);
  },
  plot: async ({ bench }, args) => {
    const { at } = await where(bench, args);
    return out(await bench.plot(at.x, at.y));
  },
  place,
  remove,
  set: setPlot,
  undo: async ({ bench, opt }) => {
    if (!opt.yes) throw new BenchError("undo changes the game or its mod list; add --yes");
    bench.armed = true;
    return printWrite(await bench.undo({ skip: !!opt.skip }));
  },
  smoke: async (ctx, args) => {
    const ok = await smoke(ctx, args);
    process.exitCode = ok ? 0 : 1;
    return undefined;
  },
  snap: async ({ bench }, args) => out(await bench.snapshot(args[0])),
  snaps: ({ bench }) => {
    const list = bench.snapshots.list();
    for (const s of list) out(`${s.label.padEnd(28)} turn ${String(s.turn).padStart(4)}  ${s.size}  ${s.takenAt}`);
    return out(`${list.length} snapshot(s)`);
  },
  diff: async ({ bench, opt }, args) => {
    if (!args[0]) throw new BenchError("diff <snapshot> [other|now]");
    const d = await bench.diff(args[0], args[1] ?? "now");
    return out(opt.json ? d.diff : d.text);
  },
  lint: async ({ bench, opt }) => {
    const r = await bench.lint(opt.scope);
    if (r.error) throw new BenchError(r.error);
    if (opt.json) return out(r);
    printLintIssues(r.issues);
    return out(`${r.issues.length} issue(s) in ${r.visited} element(s)${r.truncated ? " (stopped at the element limit)" : ""}`);
  },
  watch: async (ctx, args) => {
    const [sub, name, ...expr] = args;
    if (sub === "add" || sub === "invariant") return addWatch(ctx, sub, name, expr);
    if (sub === "rm") {
      ctx.bench.watches.remove(name);
      return out(`removed ${name}`);
    }
    if (sub === "sample") return out(await ctx.bench.sampleWatches() ?? "no watches or invariants defined");
    return listWatches(ctx);
  },
};
