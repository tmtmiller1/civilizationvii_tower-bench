import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { attribute, compareSeries, compareTurn, diffNumbers, repeatVerdict } from "../lib/sim-compare.mjs";
import { refuseBusy, SIM_HARNESS } from "../lib/sim-game.mjs";
import { runSimDiff, runSimRepeat } from "../lib/sim.mjs";
import { controlKey, findControl, listReports, pickControl, readReport, recordControl, writeReport } from "../lib/sim-store.mjs";
import { ROWS, fakeBench, fakeDeps, fakeLab, fakeRegistry, tmpPaths } from "./sim-fakes.mjs";

// A 4x3 world at a turn; `over` changes it.
function world(turn, over = {}) {
  return structuredClone({
    turn, w: 4, h: 3,
    t: new Array(12).fill(0), f: new Array(12).fill(-1), r: new Array(12).fill(-1),
    o: [0, 0, -1, -1, 0, 1, 1, -1, -1, -1, -1, -1],
    units: [{ i: 0, owner: 0, id: 1, type: "UNIT_WARRIOR" }, { i: 6, owner: 1, id: 7, type: "UNIT_SCOUT" }],
    cities: [{ i: 1, owner: 0, id: 100, name: "A", pop: 3 }],
    players: [{ id: 0, name: "P0", gold: 50 }, { id: 1, name: "P1", gold: 20 }],
    names: { terrains: ["TERRAIN_FLAT", "TERRAIN_HILL"], features: ["FEATURE_FOREST"], resources: ["RESOURCE_IRON"] },
    ...over,
  });
}
const numbers = (turn, gold = 50) => ({ turn, local: 0, players: [{ id: 0, major: true, gold, yields: { science: 4 } },
  { id: 1, major: true, gold: 20, yields: { science: 3 } }] });
const sample = (turn, w = {}, gold) => ({ turn, world: world(turn, w), numbers: numbers(turn, gold) });

test("identical turns compare to nothing; figures are compared per player and per yield", () => {
  const c = compareTurn(sample(1), sample(1));
  assert.deepEqual(c.counts, { plots: 0, units: 0, cities: 0, numbers: 0, total: 0 });
  const d = diffNumbers(numbers(1, 50), numbers(1, 51));
  assert.deepEqual(d, [{ key: "player 0 gold", a: 50, b: 51 }]);
  assert.deepEqual(diffNumbers(numbers(1, 50), numbers(1, 50.004)), [], "rounding noise is not a difference");
});

test("a mod that shifts type indices does not read as every plot retyped", () => {
  const a = world(1);
  const b = world(1, { t: new Array(12).fill(1), names: { terrains: ["TERRAIN_NEW", "TERRAIN_FLAT", "TERRAIN_HILL"],
    features: ["FEATURE_FOREST"], resources: ["RESOURCE_IRON"] } });
  assert.equal(compareTurn({ turn: 1, world: a, numbers: null }, { turn: 1, world: b, numbers: null }).counts.plots, 0);
  b.t[5] = 2;
  const c = compareTurn({ turn: 1, world: a, numbers: null }, { turn: 1, world: b, numbers: null });
  assert.equal(c.counts.plots, 1);
  assert.deepEqual(c.world.plots[0].terrain, ["TERRAIN_FLAT", "TERRAIN_HILL"]);
});

test("the series comparison finds the first divergent turn, says what, and draws the curve", () => {
  const off = [sample(1), sample(2), sample(3), sample(4)];
  const on = [sample(1), sample(2), sample(3, { o: [0, 0, 1, -1, 0, 1, 1, -1, -1, -1, -1, -1] }),
    sample(4, { units: [{ i: 0, owner: 0, id: 1, type: "UNIT_WARRIOR" }, { i: 7, owner: 1, id: 7, type: "UNIT_SCOUT" }] }, 60)];
  const cmp = compareSeries(off, on, { labels: ["off", "on"] });
  assert.equal(cmp.first?.turn, 3);
  assert.match(cmp.first?.lines[0] ?? "", /plot \(2, 0\): owner nobody in off, player 1 in on/);
  assert.deepEqual(cmp.curve.map((c) => c.total), [0, 0, 1, 2]);
  const t4 = cmp.curve[3];
  assert.deepEqual([t4.plots, t4.units, t4.numbers], [0, 1, 1]);
  assert.equal(repeatVerdict(cmp).verdict, "DIVERGES AT TURN 3");
  assert.equal(repeatVerdict(compareSeries(off, off)).verdict, "DETERMINISTIC");
  assert.equal(repeatVerdict(compareSeries([], off)).verdict, "NO DATA");
  assert.deepEqual(compareSeries(off, on.slice(0, 2)).missing.B, [], "turns only one game reached are listed");
  assert.deepEqual(compareSeries(off, on.slice(0, 2)).missing.A, [3, 4]);
});

test("a divergence is the mod's doing only under a passing control that reaches that turn", () => {
  const first = { turn: 5 };
  assert.equal(attribute(null, null).verdict, "NO DIVERGENCE");
  assert.equal(attribute(first, null).verdict, "UNCONTROLLED");
  assert.equal(attribute(first, { divergedAt: null, lastTurn: 10 }).verdict, "CAUSED BY THE MOD");
  assert.equal(attribute(first, { divergedAt: null, lastTurn: 4 }).verdict, "NOT ATTRIBUTABLE");
  assert.equal(attribute(first, { divergedAt: 8, lastTurn: 10 }).verdict, "CAUSED BY THE MOD");
  assert.match(attribute(first, { divergedAt: 5, lastTurn: 10 }).detail, /itself diverged at turn 5/);
});

test("controls are keyed by seed, age, mod set and version, and a known divergence wins", () => {
  const paths = tmpPaths();
  const scope = { seed: 7, age: null, mods: ["b", "a"], version: "1.5" };
  assert.equal(controlKey(scope), controlKey({ ...scope, mods: ["a", "b"] }), "mod order does not matter");
  assert.notEqual(controlKey(scope), controlKey({ ...scope, version: "1.6" }));
  assert.equal(findControl(paths, scope), null);
  recordControl(paths, { ...scope, turns: 10, lastTurn: 11, verdict: "DETERMINISTIC", divergedAt: null });
  recordControl(paths, { ...scope, turns: 30, lastTurn: 31, verdict: "DETERMINISTIC", divergedAt: null, source: "lead test" });
  assert.equal(findControl(paths, scope)?.lastTurn, 31);
  assert.equal(findControl(paths, scope)?.source, "lead test");
  recordControl(paths, { ...scope, turns: 30, lastTurn: 31, verdict: "DIVERGES AT TURN 20", divergedAt: 20 });
  assert.equal(findControl(paths, scope)?.divergedAt, 20);
  assert.equal(pickControl([], scope), null);
});

test("reports are written beside the lab runs, listed without per-turn data, and read back by name only", () => {
  const paths = tmpPaths();
  const file = writeReport(paths, "sim-diff", { mod: "m", verdict: "UNCONTROLLED", curve: [{ turn: 1 }] });
  writeReport(paths, "arena", { mod: "m", games: [1] });
  assert.ok(file.startsWith(path.join(path.dirname(paths.evidence), "runs")));
  const list = listReports(paths);
  assert.equal(list.length, 2);
  assert.equal(list.find((r) => r.kind === "sim-diff")?.curve, undefined);
  assert.equal(listReports(paths, { kinds: ["arena"] }).length, 1);
  assert.deepEqual(readReport(paths, path.basename(file)).curve, [{ turn: 1 }]);
  assert.throws(() => readReport(paths, "../evidence/x.json"), /no such report/);
  assert.throws(() => writeReport(paths, "other", {}), /unknown report kind/);
});

test("refuses while another sim, fuzz, arena or lab harness runs, but not for itself", () => {
  const paths = tmpPaths();
  const reg = fakeRegistry(ROWS);
  const lab = fakeLab(paths);
  const bench = fakeBench(paths);
  const ps = "10 1 node tower-bench.mjs fuzz --yes\n20 1 zsh\n30 20 node tower-bench.mjs sim diff x --yes\n";
  assert.throws(() => refuseBusy(paths, fakeDeps(paths, reg, lab, bench, { ps: () => ps, ownPid: 30 })),
    /another harness is running: node tower-bench.mjs fuzz/);
  assert.doesNotThrow(() => refuseBusy(paths, fakeDeps(paths, reg, lab, bench, { ps: () => ps.split("\n").slice(1).join("\n"),
    ownPid: 30 })));
  assert.ok(SIM_HARNESS.test("tower-bench arena my-mod --yes"));
  const busy = fakeDeps(paths, reg, lab, bench, { preflight: () => ({ problems: ["the game is running"], warnings: [] }) });
  assert.throws(() => refuseBusy(paths, busy), /the game is running/);
});

// A game whose plot (2, 0) goes to player 1 from turn `at` when the target mod is on, and whose AI also
// drifts from turn `drift` in every game when `drift` is set.
function scriptedSample(reg, lab, { at = 3, drift = null } = {}) {
  return async () => {
    const turn = lab.turn;
    const over = reg.enabled("target") && turn >= at ? { o: [0, 0, 1, -1, 0, 1, 1, -1, -1, -1, -1, -1] } : {};
    const gold = drift != null && turn >= drift ? 50 + lab.games : 50;
    return sample(turn, over, gold);
  };
}

test("sim repeat runs one seed twice with the registry untouched and records the control", async () => {
  const paths = tmpPaths();
  const reg = fakeRegistry(ROWS);
  const lab = fakeLab(paths);
  const bench = fakeBench(paths);
  const d = fakeDeps(paths, reg, lab, bench, { sample: scriptedSample(reg, lab) });
  const r = await runSimRepeat(d, { seed: 11, turns: 4 });
  assert.equal(r.verdict, "DETERMINISTIC");
  assert.deepEqual(lab.calls.filter((c) => c.startsWith("start")), ["start 11", "start 11"]);
  assert.equal(lab.calls.filter((c) => c === "restore").length, 2);
  assert.deepEqual(r.mods, ["other"]);
  const control = findControl(paths, { seed: 11, age: null, mods: ["other"], version: "9.9.9" });
  assert.equal(control?.lastTurn, 5);
  assert.equal(bench.logged.filter((e) => e.kind === "sim-game").length, 2);
  assert.ok(fs.existsSync(path.join(r.games[0].dir, "turns", "turn-005.json")), "per-turn snapshots are kept");
  assert.equal(lab.current, null);
});

test("sim diff switches the mod off then on, finds the first divergence and will not blame the mod uncontrolled", async () => {
  const paths = tmpPaths();
  const reg = fakeRegistry(ROWS);
  const lab = fakeLab(paths);
  const bench = fakeBench(paths);
  const d = fakeDeps(paths, reg, lab, bench, { sample: scriptedSample(reg, lab, { at: 3 }) });
  const r = await runSimDiff(d, { modId: "target", seed: 5, turns: 4 });
  assert.equal(r.first?.turn, 3);
  assert.equal(r.verdict, "UNCONTROLLED");
  assert.deepEqual(r.games.off.mods, ["other"]);
  assert.deepEqual(r.games.on.mods, ["other", "target"]);
  assert.ok(bench.logged.some((e) => e.kind === "sim-diff"));
  const again = await runSimDiff(d, { modId: "target", seed: 5, turns: 4, runControl: true });
  assert.equal(again.controlRanNow, true);
  assert.equal(again.verdict, "CAUSED BY THE MOD");
  assert.match(again.detail, /through turn 5/);
  assert.deepEqual(again.control?.mods, ["other"], "the control ran with the mod off");
});

test("sim diff with a game that drifts on its own is not attributable to the mod", async () => {
  const paths = tmpPaths();
  const reg = fakeRegistry(ROWS);
  const lab = fakeLab(paths);
  const bench = fakeBench(paths);
  const d = fakeDeps(paths, reg, lab, bench, { sample: scriptedSample(reg, lab, { at: 4, drift: 2 }) });
  const r = await runSimDiff(d, { modId: "target", seed: 5, turns: 4, runControl: true });
  assert.equal(r.control?.divergedAt, 2);
  assert.equal(r.verdict, "NOT ATTRIBUTABLE");
  await assert.rejects(runSimDiff(d, { modId: "nope", seed: 5, turns: 1 }), /no mod "nope"/);
});

test("a game that fails to start is recorded and everything is still restored", async () => {
  const paths = tmpPaths();
  const reg = fakeRegistry(ROWS);
  const lab = fakeLab(paths, { failStart: "timed out waiting for the main menu" });
  const bench = fakeBench(paths);
  const r = await runSimRepeat(fakeDeps(paths, reg, lab, bench), { seed: 1, turns: 2 });
  assert.equal(r.verdict, "NO DATA");
  assert.match(r.games[0].error, /did not start/);
  assert.equal(lab.calls.filter((c) => c === "restore").length, 2);
  assert.equal(findControl(paths, { seed: 1, age: null, mods: ["other"], version: "9.9.9" }), null);
});
