import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { invariantFailure, loadInvariants, logFailure, pageFailure, sameFailure } from "../lib/fuzz-check.mjs";
import { FUZZ_OPS, generateStep } from "../lib/fuzz-gen.mjs";
import { BudgetExhausted, shrink } from "../lib/fuzz-shrink.mjs";
import { modSetter, runFuzz, toRecipe } from "../lib/fuzz.mjs";
import { parseLine } from "../lib/logs.mjs";
import { validateRecipe } from "../lib/recipes.mjs";
import { makeRng, seedOf } from "../lib/sim-random.mjs";
import { validateRequest } from "../lib/writes.mjs";
import { ROWS, fakeBench, fakeDeps, fakeLab, fakeRegistry, tmpPaths } from "./sim-fakes.mjs";

const TARGETS = {
  local: 0, w: 20, h: 10,
  players: [{ id: 0, major: true, human: true }, { id: 1, major: true, human: false },
    { id: 30, major: false, human: false }],
  units: [{ owner: 0, id: 65536, x: 3, y: 4, type: "UNIT_SCOUT" }, { owner: 1, id: 131072, x: 15, y: 2, type: "UNIT_WARRIOR" },
    { owner: 30, id: 9, x: 0, y: 9, type: "UNIT_ARCHER" }],
  cities: [{ owner: 0, id: 65536, x: 4, y: 4 }, { owner: 1, id: 131073, x: 14, y: 2 }],
};

test("the seeded generator repeats exactly and only emits requests the bench accepts", () => {
  const seq = (seed) => {
    const r = makeRng(seed);
    return Array.from({ length: 200 }, () => generateStep(r, TARGETS));
  };
  assert.deepEqual(seq(42), seq(42));
  assert.notDeepEqual(seq(42), seq(43));
  const steps = seq(7);
  for (const s of steps) {
    if (s.turns) { assert.equal(s.turns, 1); continue; }
    assert.equal(validateRequest(s.write), null, JSON.stringify(s.write));
    const a = s.write.args;
    if ("x" in a) assert.ok(a.x >= 0 && a.x < 20 && a.y >= 0 && a.y < 10, "plots stay on the map");
  }
  const ops = new Set(steps.filter((s) => s.write).map((s) => s.write.op));
  assert.ok(ops.size > 10, `a wide spread of ops (${[...ops].join(", ")})`);
  assert.ok(steps.some((s) => s.turns), "turn rolls are mixed in");
  const grows = steps.filter((s) => s.write?.op === "city.grow");
  assert.ok(grows.every((s) => s.write.args.player !== 0), "a human city is never grown: it blocks End Turn");
  const parties = steps.filter((s) => s.write?.op === "player.celebrate");
  assert.ok(parties.length && parties.every((s) => s.write.args.player === 1), "only AI players celebrate");
});

test("with nothing to target the generator falls back to a turn roll", () => {
  const empty = { ...TARGETS, units: [], cities: [], players: [] };
  const r = makeRng(1);
  for (let i = 0; i < 20; i++) assert.deepEqual(generateStep(r, empty, { turnChance: 0 }), { turns: 1 });
  assert.deepEqual(generateStep(makeRng(1), TARGETS, { ops: ["player.yield"], turnChance: 0 }).write.op, "player.yield");
  assert.ok(FUZZ_OPS.includes("unit.kill") && !FUZZ_OPS.includes("terrain.set"));
  assert.equal(seedOf("a", 1), seedOf("a", 1));
  assert.notEqual(seedOf("a", 1), seedOf("a", 2));
});

test("ddmin shrinks to the steps the failure needs, caching repeats", async () => {
  const seq = Array.from({ length: 16 }, (_, i) => i);
  let calls = 0;
  const fails = (sub) => { calls += 1; return sub.includes(3) && sub.includes(11); };
  const r = await shrink(seq, fails);
  assert.deepEqual(r.minimal, [3, 11]);
  assert.equal(r.exhausted, false);
  assert.equal(r.tests, calls, "every oracle call is counted and none is repeated");
  const one = await shrink(seq, (sub) => sub.includes(9));
  assert.deepEqual(one.minimal, [9]);
});

test("a shrink that runs out of budget keeps the smallest failing sequence found so far", async () => {
  const seq = Array.from({ length: 32 }, (_, i) => i);
  const r = await shrink(seq, (sub) => sub.includes(5) && sub.includes(20), { maxTests: 8 });
  assert.equal(r.exhausted, true);
  assert.equal(r.tests, 8);
  assert.ok(r.minimal.includes(5) && r.minimal.includes(20));
  assert.equal(r.minimal.length, 24, "the eighth test dropped a quarter; the rest was never tried");
  await assert.rejects(shrink(seq, () => { throw new Error("boom"); }), /boom/);
  assert.ok(new BudgetExhausted() instanceof Error);
});

test("invariants: a mod's error line, a rollback, a mod's page error and a user invariant are failures", () => {
  const line = parseLine("UI.log", "TypeError: x is not a function at fs://game/fuzzed-mod/ui/a.js:3");
  const base = parseLine("UI.log", "TypeError: y is not a function at fs://game/base-standard/ui/b.js:1");
  assert.equal(logFailure([base]), null, "official content is not a finding");
  const f = logFailure([base, line]);
  assert.equal(f?.kind, "mod-error");
  assert.equal(f?.key, "js-error:fuzzed-mod");
  const rb = logFailure([parseLine("Database.log", "Failed to apply enabled components")]);
  assert.equal(rb?.kind, "db-rollback");
  assert.equal(pageFailure([{ message: "boom", file: "fs://game/core/ui/x.js" }]), null);
  assert.equal(pageFailure([{ message: "boom", file: "fs://game/fuzzed-mod/ui/x.js", line: 4 }])?.key, "page-error:fuzzed-mod");
  const inv = invariantFailure({ invariants: { ok: { ok: true }, cities: { ok: false, detail: "false" } } });
  assert.equal(inv?.key, "invariant:cities");
  assert.ok(sameFailure(f, { ...f, detail: "other text" }));
  assert.ok(!sameFailure(f, inv));
});

test("user invariants load from a list or an object, and bad files are refused", () => {
  const dir = fs.mkdtempSync(path.join(tmpPaths().user, "inv-"));
  const a = path.join(dir, "a.json");
  fs.writeFileSync(a, JSON.stringify([{ name: "alive", expr: "Players.getAliveIds().length > 1" }]));
  assert.equal(loadInvariants(a)[0].name, "alive");
  fs.writeFileSync(a, JSON.stringify({ invariants: [{ name: "n", expr: "true" }] }));
  assert.equal(loadInvariants(a).length, 1);
  fs.writeFileSync(a, JSON.stringify({ watches: [] }));
  assert.throws(() => loadInvariants(a), /expected a list/);
  assert.deepEqual(loadInvariants(undefined), []);
});

test("a failing sequence becomes a valid recipe that fails the way the run did", () => {
  const seq = [{ write: { op: "unit.kill", args: { player: 1, unit: 3 } } }, { turns: 1 }];
  const inv = toRecipe(seq, { name: "m", seed: 4, age: null, failure: { kind: "invariant", key: "invariant:alive",
    detail: "" }, invariants: [{ name: "alive", expr: "Players.getAliveIds().length > 1" }] });
  assert.equal(validateRecipe(inv), null);
  assert.equal(inv.stopOnFail, false);
  assert.deepEqual(inv.steps.at(-1), { expect: "Players.getAliveIds().length > 1" });
  const page = toRecipe(seq, { name: "m", seed: 4, age: null, failure: { kind: "page-error", key: "page-error:x", mod: "x",
    detail: "" } });
  assert.equal(validateRecipe(page), null);
  assert.ok(page.steps[0].eval.includes("__tbSimErrors"));
  assert.match(page.steps.at(-1).expect, /fs:\/\/game\/x\//);
  const log = toRecipe([], { name: "m", seed: 4, age: null, failure: { kind: "mod-error", key: "k", mod: "x", detail: "" } });
  assert.equal(validateRecipe(log), null, "never an empty steps list");
  assert.match(log.fuzz.check, /logs --mod x/);
});

test("--mods <ids> enables exactly those mods and refuses unknown ids", () => {
  const paths = tmpPaths();
  const reg = fakeRegistry(ROWS);
  const d = fakeDeps(paths, reg, fakeLab(paths), fakeBench(paths));
  modSetter(paths, d, ["target"])();
  assert.deepEqual(reg.state.filter((r) => !r.disabled).map((r) => r.id), ["target", "base-standard"]);
  assert.throws(() => modSetter(paths, d, ["ghost"]), /not registered user mods: ghost/);
  const before = JSON.stringify(reg.state);
  modSetter(paths, d, "enabled")();
  assert.equal(JSON.stringify(reg.state), before);
});

// A game in which a mod throws once a unit has been killed and a yield granted, in either order.
function poisonedGame(paths, { flaky = false } = {}) {
  const reg = fakeRegistry(ROWS);
  const seen = new Set();
  let games = 0;
  const lab = fakeLab(paths, { onStart: () => { seen.clear(); games += 1; } });
  const call = async (fn) => {
    if (fn.name === "fuzzTargets") return TARGETS;
    if (fn.name === "pageErrors") return { total: 0, errors: [] };
    return null;
  };
  const write = async (req) => { seen.add(req.op); return { verdict: "LANDED", description: req.op }; };
  const bench = fakeBench(paths, { call, write });
  const bad = parseLine("UI.log", "TypeError: boom is not a function at fs://game/fuzzed-mod/ui/a.js:1");
  let reported = false;
  const makeTail = () => {
    reported = false;
    return { poll: () => {
      const fire = seen.has("unit.kill") && seen.has("player.yield") && !reported && !(flaky && games > 1);
      if (fire) reported = true;
      return fire ? [bad] : [];
    } };
  };
  return { reg, lab, bench, d: fakeDeps(paths, reg, lab, bench, { makeTail }) };
}

test("fuzz finds a failure, confirms it from the same seed, and shrinks it to the two actions it needs", async () => {
  const paths = tmpPaths();
  const { lab, bench, d } = poisonedGame(paths);
  const r = await runFuzz(d, { seed: 9, runs: 5, steps: 25, ops: ["unit.kill", "player.yield", "unit.heal", "city.complete"],
    budget: 60 });
  assert.equal(r.verdict, "FAILS: mod-error");
  assert.equal(r.failure?.mod, "fuzzed-mod");
  assert.equal(r.shrink?.status, "SHRUNK");
  assert.deepEqual(r.shrink?.minimalSteps.map((s) => s.write?.op).sort(), ["player.yield", "unit.kill"]);
  assert.ok(r.budget.used <= 60);
  assert.ok(lab.calls.filter((c) => c.startsWith("start")).every((c) => c === "start 9"), "every game uses the run's seed");
  assert.equal(lab.calls.filter((c) => c === "start 9").length, lab.calls.filter((c) => c === "restore").length);
  const minimal = JSON.parse(fs.readFileSync(r.recipes?.minimal ?? "", "utf8"));
  assert.equal(validateRecipe(minimal), null);
  assert.equal(minimal.seed, 9);
  assert.equal(bench.logged.filter((e) => e.kind === "fuzz-game").length, r.budget.used);
  assert.equal(bench.armed, false, "writes are disarmed again afterwards");
  assert.equal(r.determinism.verdict, "UNCONTROLLED");
});

test("a failure that does not come back from the same seed is reported as flaky and not shrunk", async () => {
  const paths = tmpPaths();
  const { d } = poisonedGame(paths, { flaky: true });
  const r = await runFuzz(d, { seed: 9, runs: 3, steps: 25, ops: ["unit.kill", "player.yield"], budget: 10 });
  assert.equal(r.shrink?.status, "FLAKY");
  assert.equal(r.recipes?.minimal, null);
  assert.ok(fs.existsSync(r.recipes?.failing ?? ""));
  assert.equal(r.budget.used, r.failingRun + 1);
});

test("runs with no failure stop at the requested count and respect the game budget", async () => {
  const paths = tmpPaths();
  const reg = fakeRegistry(ROWS);
  const lab = fakeLab(paths);
  const bench = fakeBench(paths, { call: async (fn) => (fn.name === "fuzzTargets" ? TARGETS
    : fn.name === "pageErrors" ? { total: 0, errors: [] } : null) });
  const d = fakeDeps(paths, reg, lab, bench);
  const r = await runFuzz(d, { seed: 1, runs: 4, steps: 3, budget: 2 });
  assert.equal(r.verdict, "NO FAILURE");
  assert.equal(r.runs.length, 2);
  let n = 0;
  const gamePid = () => (++n > 2 ? null : 4321);
  const died = fakeDeps(paths, reg, fakeLab(paths), bench, { gamePid });
  const r2 = await runFuzz(died, { seed: 1, runs: 1, steps: 3 });
  assert.equal(r2.failure?.kind, "game-exited");
});
