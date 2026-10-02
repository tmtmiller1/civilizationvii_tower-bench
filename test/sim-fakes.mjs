// Shared fakes for the sim, fuzz and arena tests: a registry, a lab and a bench that never touch the game.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { simDeps } from "../lib/sim-game.mjs";

export function tmpPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-sim-"));
  return { evidence: path.join(root, "evidence"), modsDb: path.join(root, "Mods.sqlite"), user: root,
    logs: path.join(root, "Logs"), userMods: "/u/Mods", install: null, cdpPort: 9555 };
}

/** A mutable registry: rows of { id, path, disabled } that applyModSet switches by path. */
export function fakeRegistry(rows) {
  const state = rows.map((r) => ({ ...r }));
  return {
    state,
    registryRows: () => state.map((r) => ({ ...r })),
    applyModSet: (_db, candidates, enabledIds) => {
      const on = new Set(enabledIds);
      for (const c of candidates) {
        const row = state.find((r) => r.path === c.path);
        if (row) row.disabled = on.has(c.id) ? 0 : 1;
      }
    },
    enabled: (id) => state.some((r) => r.id === id && !r.disabled),
  };
}

export function fakeLab(paths, { onStart = () => {}, failStart = null } = {}) {
  const calls = [];
  let current = null;
  const lab = {
    calls, root: path.join(path.dirname(paths.evidence), "runs"), turn: 1, games: 0,
    get current() { return current; },
    setCurrent: (c) => { current = c; },
    backup: (dir) => { fs.mkdirSync(dir, { recursive: true }); calls.push("backup"); return { files: [] }; },
    startNewGame: async ({ seed }) => {
      calls.push(`start ${seed}`);
      if (failStart) throw new Error(failStart);
      lab.turn = 1;
      lab.games += 1;
      onStart(seed);
      return { pid: 4321, turn: 1 };
    },
    endTurns: async (n) => {
      lab.turn += n;
      return [{ from: lab.turn - n, to: lab.turn, ms: 10, blocker: null }];
    },
    quit: async () => { calls.push("quit"); return { wasRunning: true }; },
    restore: () => { calls.push("restore"); return { restored: ["Mods.sqlite"], registry: [], crashReports: [], moved: [] }; },
    cdp: { close: () => {} },
  };
  return lab;
}

export function fakeBench(paths, { call = async () => null, write } = {}) {
  const logged = [];
  return {
    paths, version: "9.9.9", armed: false, logged,
    log: (e) => logged.push(e),
    cdp: { close: () => {}, ensure: async () => {}, call },
    write: write ?? (async (req) => ({ verdict: "LANDED", description: req.op })),
  };
}

export const ROWS = [
  { id: "target", path: "/u/Mods/target/target.modinfo", disabled: 1 },
  { id: "other", path: "/u/Mods/other/other.modinfo", disabled: 0 },
  { id: "base-standard", path: "/g/Resources/Base/modules/base-standard/b.modinfo", disabled: 0 },
];

/** Deps wired to the fakes; `over` replaces any of them. */
export function fakeDeps(paths, reg, lab, bench, over = {}) {
  return simDeps(bench, {
    lab, preflight: () => ({ problems: [], warnings: [] }), applyModSet: reg.applyModSet, gamePid: () => 4321,
    registryRows: reg.registryRows, candidateMods: () => [], wait: async () => {}, ps: () => "", ownPid: 1,
    makeTail: () => ({ poll: () => [] }), ...over,
  });
}
