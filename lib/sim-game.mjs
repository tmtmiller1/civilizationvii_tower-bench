// The engine shared by sim, fuzz and arena: one seeded lab game with a chosen mod set, driven turn by turn and
// sampled at every turn start, then quit with every file and registry flag restored (lib/labtools.mjs). All
// machine access comes in through `d`, so tests drive the whole flow against fakes.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BenchError } from "./bench.mjs";
import { otherHarnesses } from "./lab.mjs";
import { labDeps, refuseIfBusy, withLabGame } from "./labtools.mjs";
import { LogTail } from "./logs.mjs";
import { sourceOf } from "./mods.mjs";
import { playerNumbers } from "./engine-sim.mjs";

// This module's own commands, so two of them (or one and a lab run) never share the game.
export const SIM_HARNESS = /tower-bench(\.mjs)?\s+(sim\s+(diff|repeat)|fuzz|arena)\b/;
export const errorText = (e) => (e instanceof Error ? e.message : String(e));

/**
 * @typedef {import("./labtools.mjs").LabDeps & {
 *   bench: any, ps: () => string, ownPid: number, log: (line: string) => void,
 *   sample: (bench: any, o: { world: boolean }) => Promise<any>, makeTail: () => { poll: () => any[] },
 * }} SimDeps
 */

/** Reads the figures, and the whole map when asked, from the running game. */
export async function sampleGame(bench, { world }) {
  await bench.cdp.ensure();
  const numbers = await bench.cdp.call(playerNumbers, {}, { timeoutMs: 60000 });
  const snap = world ? await bench.liveWorld() : null;
  return { turn: numbers?.turn ?? snap?.turn ?? null, numbers, world: snap };
}

/** @param {any} bench @param {Partial<SimDeps>} [deps] @returns {SimDeps} */
export function simDeps(bench, deps = {}) {
  return {
    ...labDeps(bench.paths, deps),
    bench,
    ps: deps.ps ?? (() => spawnSync("ps", ["-Ao", "pid=,ppid=,args="], { encoding: "utf8" }).stdout ?? ""),
    ownPid: deps.ownPid ?? process.pid,
    log: deps.log ?? (() => {}),
    sample: deps.sample ?? sampleGame,
    // From the start of the files: the game truncates its logs at launch, so this is the test game's whole log.
    makeTail: deps.makeTail ?? (() => new LogTail(bench.paths.logs)),
  };
}

/** Refuses while a lab run is open, the game runs outside the lab, or any other harness (ours included) runs. */
export function refuseBusy(paths, d) {
  const warnings = refuseIfBusy(paths, d);
  const extra = [process.env.TOWER_BENCH_HARNESS, SIM_HARNESS.source].filter(Boolean).join("|");
  const others = otherHarnesses(d.ps(), d.ownPid, extra);
  if (others.length) throw new BenchError(`another harness is running: ${others[0].slice(0, 120)}`);
  return warnings;
}

/** The non-official mods the registry has enabled right now, sorted: the mod set a game launched now loads. */
export function enabledMods(paths, d) {
  return d.registryRows(paths.modsDb).filter((r) => !r.disabled && sourceOf(r.path, paths).kind !== "official")
    .map((r) => r.id).sort();
}

/**
 * The mod set after switching every copy of `id` off (`on` false) or its chosen copy on, computed from the
 * registry as it is, for looking up a control before any game runs.
 */
export function plannedMods(paths, d, copies, on) {
  const ids = enabledMods(paths, d).filter((m) => m !== copies.chosen.id);
  return on ? [...ids, copies.chosen.id].sort() : ids;
}

function saveTurn(dir, s) {
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `turn-${String(s.turn ?? "x").padStart(3, "0")}.json`), JSON.stringify(s));
}

async function rollAndSample(d, o, out) {
  out.samples.push(await d.sample(d.bench, { world: o.world }));
  saveTurn(out.turnsDir, out.samples.at(-1));
  for (let i = 0; i < o.turns; i++) {
    await d.lab.endTurns(1, { log: d.log });
    const s = await d.sample(d.bench, { world: o.world });
    out.samples.push(s);
    saveTurn(out.turnsDir, s);
    o.onTurn?.(s, i + 1);
  }
}

/**
 * One lab game: `turns` turns ended without Autoplay, a sample at the start and after each. Samples are also
 * written to <run dir>/turns/turn-NNN.json. The game is always quit and everything restored.
 * @param {SimDeps} d
 * @param {{ tool: string, label: string, seed: number, age?: string | null, turns: number, world: boolean,
 *   setMods: () => void, onTurn?: (s: any, n: number) => void }} o
 */
export async function playGame(d, o) {
  const paths = d.bench.paths;
  const run = await withLabGame(paths, d, { label: o.label, seed: o.seed, age: o.age ?? null, log: d.log,
    setMods: o.setMods }, async ({ dir, started, error }) => {
    /** @type {{ samples: any[], error: string | null, mods: string[], turnsDir: string }} */
    const out = { samples: [], error, mods: enabledMods(paths, d), turnsDir: path.join(dir, "turns") };
    if (!started) return out;
    d.bench.cdp.close(); // the bench re-attaches to the new game's page
    try {
      await rollAndSample(d, o, out);
    } catch (e) {
      out.error = d.gamePid() ? errorText(e) : `the game exited: ${errorText(e)}`;
    }
    return out;
  });
  return logGame(d, o, run);
}

function logGame(d, o, run) {
  const r = run.result ?? { samples: [], error: run.error, mods: [] };
  const restore = run.restore ?? { crashReports: [], restored: [], registry: [] };
  const crashReports = restore.crashReports;
  d.bench.log({ kind: "sim-game", request: { tool: o.tool, label: o.label, seed: o.seed, age: o.age ?? null,
    turns: o.turns }, result: { dir: run.dir, started: run.started, sampled: r.samples.length, error: r.error,
    crashReports, restored: restore.restored, registry: restore.registry.length } });
  return { dir: run.dir, started: run.started, samples: r.samples, error: r.error, mods: r.mods, crashReports };
}
