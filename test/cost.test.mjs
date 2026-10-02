import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  compareMetric, costPlan, costReport, costVerdict, describe, listCostReports, measureTurns, quantile, runCost,
  trialOrder, writeCostReport,
} from "../lib/cost.mjs";

// Deterministic "noise": a fixed jitter pattern around a centre.
const JITTER = [-20, 5, 12, -8, 0, 17, -15, 9, -3, 6, -11, 14, -6, 2, -17, 10, -1, 7, -12, 4];
const run = (centre, n = 20, scale = 1) => Array.from({ length: n },
  (_, i) => centre + JITTER[i % JITTER.length] * scale);

test("quantile interpolates and ignores non-numbers", () => {
  assert.equal(quantile([3, 1, 2, NaN], 0.5), 2);
  assert.equal(quantile([0, 10], 0.9), 9);
  assert.ok(Number.isNaN(quantile([], 0.5)));
  const d = describe([1, 2, 3, 4, 5]);
  assert.deepEqual([d.n, d.median, d.iqr, d.min, d.max], [5, 3, 2, 1, 5]);
});

test("a clear per-turn cost is reported with its size", () => {
  const wall = compareMetric([run(1000), run(1004)], [run(1300), run(1296)]);
  assert.ok(wall.significant);
  const v = costVerdict(wall);
  assert.equal(v.verdict, "COSTS ~296 ms per turn");
});

test("a difference inside small noise is no measurable cost", () => {
  const wall = compareMetric([run(1000), run(1003)], [run(1002), run(1001)]);
  assert.equal(wall.significant, false);
  assert.equal(costVerdict(wall).verdict, "NO MEASURABLE COST");
});

test("wide spread or drift between replicates means more replicates", () => {
  const wide = compareMetric([run(1000, 20, 30), run(1000, 20, 30)], [run(1100, 20, 30), run(1050, 20, 30)]);
  assert.equal(costVerdict(wide).verdict, "NOISY: more replicates");
  const drift = compareMetric([run(1000), run(1400)], [run(1010), run(1390)]);
  assert.ok(drift.noise >= 400, "replicate medians 400 ms apart set the noise");
  assert.equal(costVerdict(drift).verdict, "NOISY: more replicates");
});

test("one replicate never claims no cost, and on-faster-than-off is called drift", () => {
  const one = compareMetric([run(1000)], [run(1001)]);
  assert.match(costVerdict(one, { replicates: 1 }).detail, /no run-to-run spread/);
  const faster = compareMetric([run(1300), run(1302)], [run(1000), run(1001)]);
  assert.match(costVerdict(faster).detail, /drift between runs/);
  assert.equal(costVerdict(compareMetric([], [run(1)])).verdict, "NO DATA");
});

test("the report drops warm-up turns, compares every metric and lists failures", () => {
  const first = { turn: 1, metrics: { wallMs: 90000, rssMB: 1 } };
  const trial = (arm, replicate, base) => ({ arm, replicate, samples: [first,
    ...run(base).map((v, i) => ({ turn: i + 2, metrics: { wallMs: v, rssMB: 1000 + (arm === "on" ? 50 : 0) } }))] });
  const r = costReport([trial("off", 1, 1000), trial("on", 1, 1000), trial("on", 2, 1001), trial("off", 2, 1002),
    { arm: "on", replicate: 3, samples: [], error: "the game did not start" }]);
  assert.equal(r.metrics.wallMs.off.n, 40, "turn 1 of each game is dropped");
  assert.equal(r.verdict, "NO MEASURABLE COST");
  assert.equal(r.metrics.rssMB.diff, 50);
  assert.equal(r.replicates, 2);
  assert.deepEqual(r.failures, [{ arm: "on", replicate: 3, error: "the game did not start", crashReports: [] }]);
});

const rows = [
  { id: "target", path: "/u/Mods/target/target.modinfo", disabled: 1 },
  { id: "other", path: "/u/Mods/other/other.modinfo", disabled: 0 },
  { id: "off-already", path: "/u/Mods/x/x.modinfo", disabled: 1 },
  { id: "tower-bench-agent", path: "/u/Mods/a/a.modinfo", disabled: 0 },
  { id: "base-standard", path: "/g/Resources/Base/modules/base-standard/b.modinfo", disabled: 0 },
];

test("the plan switches only the target; other enabled user mods stay on in both arms", () => {
  const p = costPlan(rows, "target");
  assert.deepEqual(p.off, ["other"]);
  assert.deepEqual(p.on, ["other", "target"]);
  assert.deepEqual(p.candidates.map((c) => c.id), ["other", "target"]);
  assert.throws(() => costPlan(rows, "base-standard"), /not a registered user mod/);
  const two = [...rows, { id: "target", path: "/u/Mods/target-copy/target.modinfo", disabled: 1 }];
  assert.throws(() => costPlan(two, "target"), /2 copies/);
  assert.equal(costPlan([...two, { ...two[0], disabled: 0, path: "/u/live" }], "target").target.path, "/u/live");
});

test("arms alternate so drift over a session cancels", () => {
  assert.deepEqual(trialOrder(3).map((s) => `${s.arm}${s.replicate}`), ["off1", "on1", "on2", "off2", "off3", "on3"]);
});

// A bench whose event bridge and debugger are scripted: each ended turn emits the two turn events,
// `perTurnMs` apart on the page clock.
function fakeBench(perTurnMs) {
  const history = [];
  const logged = [];
  let clock = 1000;
  const sends = [];
  const bench = {
    logged, sends, history,
    events: {
      history, subscriptions: ["UnitMoved"],
      set: async (names) => { bench.events.subscriptions = names; },
      waitFor: async ({ event, from }) => {
        const i = history.findIndex((e, k) => k >= from && e.name === event);
        return i >= 0 ? { ok: true, event: history[i], index: i } : { ok: false, timedOut: true };
      },
    },
    cdp: {
      ensure: async () => {},
      close: () => {},
      send: async (method) => {
        sends.push(method);
        if (method === "Runtime.getHeapUsage") return { usedSize: 100 * 1048576, totalSize: 200 * 1048576 };
        if (method === "Performance.getMetrics") return { metrics: [{ name: "TaskDuration", value: history.length }] };
        if (method === "Memory.getDOMCounters") throw new Error("'Memory.getDOMCounters' wasn't found");
        return {};
      },
    },
    log: (e) => logged.push(e),
    emitTurn: (ms) => {
      history.push({ name: "LocalPlayerTurnEnd", t: clock });
      clock += ms;
      history.push({ name: "LocalPlayerTurnBegin", t: clock });
      clock += 5000;
    },
    perTurn: perTurnMs,
  };
  return bench;
}

function fakeLab(bench, { failStart = null } = {}) {
  const calls = [];
  let current = null;
  let turn = 1;
  const lab = {
    calls, root: fs.mkdtempSync(path.join(os.tmpdir(), "tb-cost-")),
    get current() { return current; },
    setCurrent: (c) => { current = c; },
    backup: (dir) => { calls.push(`backup ${path.basename(dir).replace(/^cost-[\dT-]+-/, "")}`); return { files: [] }; },
    startNewGame: async () => {
      calls.push("start");
      if (failStart) throw new Error(failStart);
      turn = 1;
      return { pid: 4321, turn };
    },
    endTurns: async (n) => {
      bench.emitTurn(bench.perTurn());
      turn += n;
      return [{ from: turn - 1, to: turn, ms: 99999, blocker: null }];
    },
    quit: async () => { calls.push("quit"); return { wasRunning: true }; },
    restore: () => { calls.push("restore"); return { restored: ["Mods.sqlite"], registry: [], crashReports: [], moved: [] }; },
  };
  return lab;
}

test("measureTurns reads wall time from the turn events, not the coarse poll, and samples each turn start", async () => {
  const bench = fakeBench(() => 1234);
  const lab = fakeLab(bench);
  const r = await measureTurns({ bench, lab, turns: 3, pid: () => 4321, rssOf: () => 2048,
    tail: { poll: () => [{ text: "[ERROR] boom", severity: "info" }, { text: "fine", severity: "info" }] } });
  assert.deepEqual(r.samples.map((s) => s.metrics.wallMs), [1234, 1234, 1234]);
  assert.equal(r.samples[0].wallSource, "events");
  assert.equal(r.samples[0].metrics.heapUsedMB, 100);
  assert.equal(r.samples[0].metrics.rssMB, 2048);
  assert.equal(r.samples[0].metrics.errorLines, 1);
  assert.equal(r.samples[1].metrics["Performance.getMetrics.TaskDuration (per turn)"], 2, "CDP counters as per-turn change");
  assert.equal(r.domains["Performance.getMetrics"], true);
  assert.match(String(r.domains["Memory.getDOMCounters"]), /wasn't found/);
  assert.ok(bench.events.subscriptions.includes("UnitMoved"), "the bench's own subscriptions are kept");
});

test("runCost runs off and on with the mod switched, restores after every game, and judges the difference", async () => {
  let arm = "off";
  const bench = fakeBench(() => (arm === "on" ? 1500 : 1000) + JITTER[bench.history.length % 20]);
  const lab = fakeLab(bench);
  const applied = [];
  const deps = {
    lab, bench, paths: { modsDb: "/fake/Mods.sqlite" }, registryRows: () => rows, gamePid: () => 4321, rssOf: () => 1000,
    applyModSet: (_db, candidates, enabled) => { arm = enabled.includes("target") ? "on" : "off"; applied.push([...enabled]); },
    makeTail: () => ({ poll: () => [] }), log: () => {},
  };
  const r = await runCost(deps, { modId: "target", turns: 6, replicates: 2 });
  assert.deepEqual(applied, [["other"], ["other", "target"], ["other", "target"], ["other"]]);
  assert.equal(lab.calls.filter((c) => c === "restore").length, 4);
  assert.match(r.verdict, /^COSTS ~(49|50)\d ms per turn$/);
  assert.equal(r.trials.length, 4);
  assert.equal(bench.logged.filter((e) => e.kind === "cost-trial").length, 4);
  assert.equal(bench.logged.at(-1).kind, "cost");
  assert.equal(lab.current, null);
});

test("a game that does not start is recorded, and the player's state is still restored", async () => {
  const bench = fakeBench(() => 1000);
  const lab = fakeLab(bench, { failStart: "timed out waiting for the main menu" });
  const deps = { lab, bench, paths: { modsDb: "x" }, registryRows: () => rows, gamePid: () => null, rssOf: () => NaN,
    applyModSet: () => {}, makeTail: () => ({ poll: () => [] }), log: () => {} };
  const r = await runCost(deps, { modId: "target", turns: 2, replicates: 1 });
  assert.equal(r.verdict, "NO DATA");
  assert.equal(r.failures.length, 2);
  assert.deepEqual(lab.calls, ["backup off-1", "start", "quit", "restore", "backup on-1", "start", "quit", "restore"]);
});

test("cost reports are written beside the lab runs and listed without their samples", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cost-reports-"));
  const paths = { evidence: path.join(root, "evidence") };
  const file = writeCostReport(paths, { mod: "m", verdict: "NO MEASURABLE COST", trials: [{ samples: [1, 2] }] });
  assert.ok(file.startsWith(path.join(root, "runs")));
  const list = listCostReports(paths);
  assert.equal(list[0].mod, "m");
  assert.equal(list[0].trials, undefined);
  assert.deepEqual(listCostReports({ evidence: path.join(root, "none", "evidence") }), []);
});
