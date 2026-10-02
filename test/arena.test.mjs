import assert from "node:assert/strict";
import { test } from "node:test";
import { bootstrapCI, leadRates, mean, meanCurve, pairedEffect, wilson } from "../lib/arena-stats.mjs";
import { arenaReport, compactGame, parseSeeds, runArena } from "../lib/arena.mjs";
import { recordControl } from "../lib/sim-store.mjs";
import { ROWS, fakeBench, fakeDeps, fakeLab, fakeRegistry, tmpPaths } from "./sim-fakes.mjs";

test("bootstrap intervals are seeded, contain the estimate and narrow with more data", () => {
  const xs = [9, 10, 11, 10, 12, 8, 10, 9, 11, 10];
  const a = bootstrapCI(xs, { seed: 3 });
  assert.deepEqual(a, bootstrapCI(xs, { seed: 3 }), "the same seed gives the same interval");
  assert.equal(a.est, 10);
  assert.ok(a.lo < 10 && a.hi > 10 && a.lo > 8 && a.hi < 12);
  const wide = bootstrapCI(xs.slice(0, 3), { seed: 3 });
  assert.ok(wide.hi - wide.lo >= a.hi - a.lo);
  assert.equal(bootstrapCI([]).n, 0);
  assert.ok(Number.isNaN(mean([NaN])));
});

test("a clear paired effect is significant; noise around zero is not", () => {
  const off = new Map([[1, 10], [2, 12], [3, 9], [4, 11], [5, 10]]);
  const up = new Map([[1, 15], [2, 16], [3, 14], [4, 17], [5, 15]]);
  const e = pairedEffect(off, up);
  assert.equal(e.pairs, 5);
  assert.equal(e.est, 5);
  assert.ok(e.significant && e.lo > 0);
  const noise = pairedEffect(off, new Map([[1, 11], [2, 11], [3, 10], [4, 10], [5, 10]]));
  assert.equal(noise.significant, false);
  assert.equal(pairedEffect(off, new Map([[9, 1]])).pairs, 0, "only seeds played in both arms pair");
});

test("mean curves bootstrap each turn over games and skip missing turns", () => {
  const c = meanCurve([[1, 2, 3], [3, 4, null], [2, 3]], [10, 11, 12]);
  assert.deepEqual(c.map((p) => p.turn), [10, 11, 12]);
  assert.deepEqual(c.map((p) => p.est), [2, 3, 3]);
  assert.deepEqual(c.map((p) => p.n), [3, 3, 1]);
});

test("lead rates count each civ once per game, with Wilson intervals", () => {
  const r = leadRates([{ entrants: ["A", "B"], leader: "A" }, { entrants: ["A", "C"], leader: "C" },
    { entrants: ["A", "B", "A"], leader: "A" }]);
  const a = r.find((x) => x.key === "A");
  assert.deepEqual([a?.games, a?.leads], [3, 2]);
  assert.equal(r[0].key, "C", "1 of 1 sorts first");
  const w = wilson(0, 10);
  assert.equal(w.lo, 0);
  assert.ok(w.hi > 0.2 && w.hi < 0.35);
  assert.ok(Number.isNaN(wilson(0, 0).rate));
});

test("seeds parse as a range or a list", () => {
  assert.deepEqual(parseSeeds("5..8"), [5, 6, 7, 8]);
  assert.deepEqual(parseSeeds("1, 9,3"), [1, 9, 3]);
  assert.throws(() => parseSeeds("9..1"), /a <= b/);
  assert.throws(() => parseSeeds("x"), /bad seeds/);
});

const P = (id, o = {}) => ({ id, major: true, human: false, civ: `CIV_${id}`, leader: `LEADER_${id}`, score: 0, techs: 1,
  civics: 1, cities: 1, pop: 2, units: 3, gold: 10,
  yields: { gold: 2, science: 3, culture: 1, production: 4, food: 5 }, ...o });

test("a game reduces to AI-major means per turn and its leader; the passive local player is left out", () => {
  const s = (turn, scores) => ({ turn, numbers: { local: 0, players: [P(0, { human: true, score: 99 }),
    P(1, { score: scores[0] }),
    P(2, { score: scores[1] }), { id: 30, major: false, cities: 1 }] } });
  const g = compactGame([s(1, [0, 0]), s(2, [2, 4]), s(3, [6, 4])], { seed: 4, arm: "on" });
  assert.deepEqual(g.aggregate.score, [0, 3, 5]);
  assert.equal(g.leader, "LEADER_1", "the human's 99 does not count");
  assert.deepEqual(g.entrants.map((e) => e.id), [1, 2]);
  assert.equal(g.winner, null);
  const won = compactGame([{ turn: 1, numbers: { local: 0, players: [P(1), P(2)], victories: [{ playerID: 2 }] } }],
    { seed: 4, arm: "on" });
  assert.equal(won.winnerKey, "LEADER_2");
});

// Per seed: the AI's science per turn is 3 off and 3 + bonus on, with a little seed-dependent spread.
function arenaSample(reg, lab, seedNow, bonus) {
  return async () => {
    const on = reg.enabled("target");
    const spread = (seedNow.seed % 3) * 0.1;
    const players = [P(0, { human: true }),
      P(1, { score: lab.turn * (on ? 2 : 1), yields: { science: 3 + spread + (on ? bonus : 0) } }),
      P(2, { score: lab.turn * 1.5, yields: { science: 3 + spread } })];
    return { turn: lab.turn, numbers: { turn: lab.turn, local: 0, players }, world: null };
  };
}

test("the arena plays every seed off and on, alternating order, and reports the mod's effect with an interval", async () => {
  const paths = tmpPaths();
  const reg = fakeRegistry(ROWS);
  const seedNow = { seed: 0 };
  const lab = fakeLab(paths, { onStart: (seed) => { seedNow.seed = seed; } });
  const bench = fakeBench(paths);
  recordControl(paths, { seed: 1, age: null, mods: ["other"], version: "9.9.9", turns: 5, lastTurn: 6, verdict: "DETERMINISTIC",
    divergedAt: null });
  const d = fakeDeps(paths, reg, lab, bench, { sample: arenaSample(reg, lab, seedNow, 2) });
  const arms = [];
  const sample = d.sample;
  d.sample = async (b, o) => { const s = await sample(b, o); arms.push(reg.enabled("target") ? "on" : "off"); return s; };
  const r = await runArena(d, { modId: "target", seeds: [1, 2, 3, 4], turns: 5 });
  assert.deepEqual(lab.calls.filter((c) => c.startsWith("start")), ["start 1", "start 1", "start 2", "start 2", "start 3",
    "start 3", "start 4", "start 4"]);
  assert.deepEqual(arms.filter((_, i) => i % 6 === 0), ["off", "on", "on", "off", "off", "on", "on", "off"]);
  assert.equal(r.effects.science.pairs, 4);
  assert.ok(Math.abs(r.effects.science.est - 1) < 1e-9, "the AI mean of +2 for one of two AIs is +1");
  assert.ok(r.effects.science.significant);
  assert.equal(r.effects.cities.significant, false);
  assert.equal(r.arms.on.leadByLeader[0].key, "LEADER_1");
  assert.equal(r.arms.off.leadByLeader[0].key, "LEADER_2");
  assert.equal(r.arms.on.curves.score.length, 6);
  assert.equal(r.observer, false);
  assert.match(r.caveat, /passively/);
  assert.deepEqual(r.determinism, { seeds: 4, controlled: 1, deterministic: 1 });
  assert.equal(bench.logged.filter((e) => e.kind === "sim-game").length, 8);
  assert.ok(bench.logged.some((e) => e.kind === "arena"));
  assert.deepEqual(arenaReport([]).failed, []);
});
