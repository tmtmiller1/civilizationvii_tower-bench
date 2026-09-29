import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bisect } from "../lib/bisect.mjs";
import { planDeploy } from "../lib/deploy.mjs";
import { recipeFromEvidence, resolveAt, runRecipe, validateRecipe } from "../lib/recipes.mjs";
import { WatchStore, violations } from "../lib/watches.mjs";

// --- bisect: a fake trial decides failure from the enabled set ---
const MODS = ["a", "b", "c", "d", "e", "f", "g"];
const trialOf = (failsWith) => async (enabled) => ({ failed: failsWith(new Set(enabled)) });

test("bisect isolates one culprit among seven and confirms the rest are clean without it", async () => {
  let games = 0;
  const trial = async (enabled) => { games++; return { failed: enabled.includes("e") }; };
  const r = await bisect({ candidates: MODS, trial, replicates: 1 });
  assert.equal(r.verdict, "ISOLATED");
  assert.equal(r.culprit, "e");
  assert.ok(games <= 9, `${games} games`);
});

test("bisect reports a failure it cannot reproduce, and one that no candidate causes", async () => {
  assert.equal((await bisect({ candidates: MODS, trial: trialOf(() => false), replicates: 2 })).verdict, "NOT REPRODUCED");
  assert.equal((await bisect({ candidates: MODS, trial: trialOf(() => true), replicates: 2 })).verdict, "NOT A CANDIDATE");
});

test("bisect names an interaction when neither half fails alone", async () => {
  const r = await bisect({ candidates: MODS, trial: trialOf((on) => on.has("b") && on.has("f")), replicates: 1 });
  assert.equal(r.verdict, "INTERACTION");
  assert.ok(r.suspects.includes("b") && r.suspects.includes("f"));
});

test("a flaky failure is still caught because any failing replicate counts", async () => {
  let n = 0;
  const trial = async (enabled) => ({ failed: enabled.includes("c") && n++ % 2 === 1 });
  const r = await bisect({ candidates: ["a", "b", "c", "d"], trial, replicates: 3 });
  assert.equal(r.culprit, "c");
});

// --- recipes ---
test("recipes are validated and anchored positions resolve with offsets", () => {
  assert.match(validateRecipe({ steps: [] }), /non-empty/);
  assert.match(validateRecipe({ steps: [{ write: { op: "x" }, turns: 1 }] }), /exactly one/);
  assert.match(validateRecipe({ steps: [{ turns: 0 }] }), /positive integer/);
  assert.equal(validateRecipe({ steps: [{ snapshot: "s" }, { turns: 2 }] }), null);
  assert.deepEqual(resolveAt({ at: "unit", dx: 1, type: "T" }, { firstUnit: { x: 10, y: 4 } }), { type: "T", x: 11, y: 4 });
  assert.deepEqual(resolveAt({ at: [3, 5] }, null), { x: 3, y: 5 });
  assert.throws(() => resolveAt({ at: "selected" }, {}), /cannot resolve/);
});

function fakeBench() {
  const calls = [];
  return {
    calls,
    status: async () => ({ snapshot: { firstUnit: { x: 1, y: 1 } } }),
    snapshot: async (label) => { calls.push(["snapshot", label]); return { label }; },
    write: async (req) => { calls.push(["write", req]); return { verdict: "LANDED", landedMs: 20, description: req.op }; },
    diff: async (a) => { calls.push(["diff", a]); return { text: "territory: 1 tile(s)" }; },
    eval: async (code) => (code === "true" ? true : 5),
  };
}

test("a recipe runs in order, resolves anchors, and stops at the first failed expectation", async () => {
  const b = fakeBench();
  const r = await runRecipe(b, { name: "t", steps: [
    { snapshot: "start" },
    { write: { op: "unit.place", args: { at: "unit", dx: 2, owner: 1, type: "UNIT_SCOUT" } } },
    { expect: "true" },
    { diff: "start" },
    { expect: "5" },
    { eval: "never reached" },
  ] });
  assert.equal(r.passed, false);
  assert.deepEqual(r.results.map((x) => x.ok), [true, true, true, true, false]);
  assert.deepEqual(b.calls[1][1].args, { owner: 1, type: "UNIT_SCOUT", x: 3, y: 1 });
  assert.deepEqual(b.calls[0], ["snapshot", "t-start"]);
});

test("turn steps refuse to run outside a lab game", async () => {
  const r = await runRecipe(fakeBench(), { steps: [{ turns: 1 }] });
  assert.equal(r.passed, false);
  assert.match(r.results[0].detail, /only run in a lab test game/);
});

test("recording a recipe keeps landed writes in order and drops undone ones", () => {
  const e = [
    { ts: "2026-09-26T20:00:00.000Z", kind: "write", request: { op: "a", args: {} }, result: { verdict: "LANDED" } },
    { ts: "2026-09-26T20:01:00.000Z", kind: "write", request: { op: "b", args: {} }, result: { verdict: "NO EFFECT" } },
    { ts: "2026-09-26T20:02:00.000Z", kind: "write", request: { op: "c", args: {} }, result: { verdict: "LANDED" } },
    { ts: "2026-09-26T20:03:00.000Z", kind: "undo", undoOf: "2026-09-26T20:02:00.000Z", result: { verdict: "LANDED" } },
  ];
  const r = recipeFromEvidence(e);
  assert.deepEqual(r.steps.map((s) => s.write?.op ?? Object.keys(s)[0]), ["snapshot", "a", "diff"]);
  assert.equal(validateRecipe(r), null);
});

// --- deploy planning ---
function modFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-dep-"));
  const src = path.join(root, "src");
  const userMods = path.join(root, "Mods");
  const live = path.join(userMods, "my-mod");
  for (const d of [path.join(src, "ui"), path.join(live, "ui")]) fs.mkdirSync(d, { recursive: true });
  const modinfo = '<Mod id="my-mod"><ActionGroups><Item>ui/a.js</Item><Item>./ui/b.css</Item><Item>data/x.xml</Item><Item>ui/gone.js</Item></ActionGroups></Mod>';
  fs.writeFileSync(path.join(src, "my-mod.modinfo"), modinfo);
  fs.writeFileSync(path.join(live, "my-mod.modinfo"), modinfo);
  fs.writeFileSync(path.join(src, "ui", "a.js"), "new");
  fs.writeFileSync(path.join(live, "ui", "a.js"), "old");
  fs.writeFileSync(path.join(src, "ui", "b.css"), "same");
  fs.writeFileSync(path.join(live, "ui", "b.css"), "same");
  fs.mkdirSync(path.join(src, "data"));
  fs.writeFileSync(path.join(src, "data", "x.xml"), "<Database/>");
  return { src, live, paths: { userMods } };
}

test("deploy plans the changed and new declared files, and reports declared files that are missing", () => {
  const { src, live, paths } = modFixture();
  const p = planDeploy(src, paths, [{ id: "my-mod", disabled: 0, path: path.join(live, "my-mod.modinfo") }]);
  assert.equal(p.refuse, undefined);
  assert.deepEqual(p.changes.map((c) => [c.rel, c.state, c.ui]), [["ui/a.js", "changed", true], ["data/x.xml", "new", false]]);
  assert.deepEqual(p.missing, ["ui/gone.js"]);
});

test("deploy refuses a Workshop live copy, several enabled copies, and none enabled", () => {
  const { src, paths } = modFixture();
  const ws = "/S/steamapps/workshop/content/1295660/123/my-mod/my-mod.modinfo";
  assert.match(planDeploy(src, paths, [{ id: "my-mod", disabled: 0, path: ws }]).refuse, /Workshop 123/);
  assert.match(planDeploy(src, paths, [{ id: "my-mod", disabled: 0, path: ws }, { id: "my-mod", disabled: null, path: "/x/my-mod.modinfo" }]).refuse, /2 copies/);
  assert.match(planDeploy(src, paths, [{ id: "my-mod", disabled: 1, path: ws }]).refuse, /no copy/);
  assert.match(planDeploy(src, paths, []).refuse, /never registered/);
});

test("deploying from the live folder itself is recognised as in place", () => {
  const { live, paths } = modFixture();
  assert.equal(planDeploy(live, paths, [{ id: "my-mod", disabled: 0, path: path.join(live, "my-mod.modinfo") }]).inPlace, true);
});

// --- watches ---
test("watch definitions persist, series keep one value per turn, violations are listed", () => {
  const store = new WatchStore(fs.mkdtempSync(path.join(os.tmpdir(), "tb-w-")));
  store.add("watches", "gold", "Players.get(0).Treasury.goldBalance");
  store.add("invariants", "alive", "true");
  store.add("watches", "gold", "1 + 1");
  assert.deepEqual(store.defs().watches, [{ name: "gold", expr: "1 + 1" }]);
  store.record({ turn: 1, watches: { gold: { value: 10 } } });
  store.record({ turn: 1, watches: { gold: { value: 11 } } });
  store.record({ turn: 2, watches: { gold: { value: 15 } } });
  assert.deepEqual(store.series().gold, [{ turn: 1, value: 11 }, { turn: 2, value: 15 }]);
  assert.equal(store.latest().turn, 2, "a page opened later reads the last recorded sample, invariants included");
  assert.equal(new WatchStore(fs.mkdtempSync(path.join(os.tmpdir(), "tb-w-"))).latest(), null);
  assert.deepEqual(violations({ invariants: { a: { ok: true }, b: { ok: false, detail: "false" } } }), [{ name: "b", detail: "false" }]);
  store.remove("alive");
  assert.throws(() => store.remove("alive"), /no watch or invariant/);
});
