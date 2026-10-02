// A recipe is a repeatable test as data: an optional seed and start age for a Play Now game, then
// steps. Seeded Play Now games are deterministic, so a recipe that reproduces once reproduces again.
//
// { "name": "strand-check", "seed": 4242, "age": "AGE_ANTIQUITY",
//   "steps": [ { "snapshot": "start" },
//              { "write": { "op": "unit.place",
//                           "args": { "at": "unit", "dx": 1, "type": "UNIT_SPEARMAN", "owner": 1 } } },
//              { "turns": 2 },
//              { "diff": "start" },
//              { "expect": "Players.get(1).Units.getUnitIds().length > 0" } ] }
import { recordTechniqueRun, techniqueById } from "./techniques.mjs";

const STEP_KINDS = ["snapshot", "write", "turns", "diff", "expect", "eval", "lint", "sample", "events", "await"];
const LANDED = ["LANDED", "ALREADY"];
const AWAIT_TIMEOUT_MS = 60000;

const isNameList = (v) => Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === "string");

const STEP_CHECKS = [
  { bad: (s) => s.write && !s.write.op, why: "write needs an op" },
  { bad: (s) => s.turns != null && !(Number.isInteger(s.turns) && s.turns > 0), why: "turns must be a positive integer" },
  { bad: (s) => s.events && !isNameList(s.events), why: "events must be a list of event names" },
  { bad: (s) => s.await && !s.await.event, why: "await needs an event name" },
];

const kindsOf = (step) => Object.keys(step).filter((k) => STEP_KINDS.includes(k));

function techniquesProblem(r) {
  if (r.techniques === undefined) return null;
  if (!isNameList(r.techniques)) return "techniques must be a list of technique ids";
  const unknown = r.techniques.filter((id) => !techniqueById(id));
  return unknown.length ? `unknown technique id(s): ${unknown.join(", ")} (see "techniques")` : null;
}

export function validateRecipe(r) {
  if (!r || !Array.isArray(r.steps) || !r.steps.length) return "a recipe needs a non-empty steps array";
  const techniques = techniquesProblem(r);
  if (techniques) return techniques;
  for (const [i, s] of r.steps.entries()) {
    if (kindsOf(s).length !== 1) return `step ${i + 1} must have exactly one of ${STEP_KINDS.join(", ")}`;
    const failed = STEP_CHECKS.find((c) => c.bad(s));
    if (failed) return `step ${i + 1}: ${failed.why}`;
  }
  return null;
}

function anchorOf(at, snapshot) {
  if (Array.isArray(at)) return { x: at[0], y: at[1] };
  if (at === "unit") return snapshot?.firstUnit;
  if (at === "selected") return snapshot?.selectedUnit;
  if (typeof at === "object") return at;
  return undefined;
}

// Positions can be absolute or anchored to the local player's first unit / the selected unit, with
// an offset, so one recipe works across seeds.
export function resolveAt(args, snapshot) {
  const { at, dx = 0, dy = 0, ...rest } = args;
  if (at === undefined) return args;
  const base = anchorOf(at, snapshot);
  if (!base) throw new Error(`cannot resolve position "${JSON.stringify(at)}"`);
  return { ...rest, x: base.x + dx, y: base.y + dy };
}

const labelOf = (ctx, name) => `${ctx.recipe.name ?? "recipe"}-${name}`;

function awaitDetail(a, w) {
  const what = `${a.event}${a.match ? ` where ${a.match}` : ""}`;
  const missing = `no ${what} within ${a.timeoutMs ?? AWAIT_TIMEOUT_MS} ms`;
  if (a.none) return w.ok ? missing : `unexpected ${what} at turn ${w.event.turn}`;
  return w.ok ? `${what} at turn ${w.event.turn}` : missing;
}

const STEP_HANDLERS = {
  async snapshot(ctx, name) {
    const s = await ctx.bench.snapshot(labelOf(ctx, name));
    return { ok: true, detail: `snapshot ${s.label}${s.turn != null ? ` at turn ${s.turn}` : ""}` };
  },
  async write(ctx, spec) {
    const request = { op: spec.op, args: resolveAt(spec.args ?? {}, ctx.snapshot) };
    const w = await ctx.bench.write(request, { waitMs: spec.waitMs ?? 3000 });
    const took = w.landedMs != null ? ` in ${w.landedMs} ms` : "";
    return { ok: LANDED.includes(w.verdict), detail: `${w.description}: ${w.verdict}${took}` };
  },
  async turns(ctx, n) {
    if (!ctx.endTurns) throw new Error("turn steps only run in a lab test game");
    const rolled = await ctx.endTurns(n);
    return { ok: true, detail: `ended ${rolled.length} turn(s)` };
  },
  async diff(ctx, name) {
    const d = await ctx.bench.diff(labelOf(ctx, name), "now");
    return { ok: true, detail: d.text };
  },
  async expect(ctx, code) {
    const v = await ctx.bench.eval(code, { depth: 1 });
    return { ok: v === true, detail: `${code} -> ${JSON.stringify(v)}` };
  },
  async eval(ctx, code) {
    return { ok: true, detail: JSON.stringify(await ctx.bench.eval(code, { depth: 2 })) };
  },
  async lint(ctx, scope) {
    const l = await ctx.bench.lint(scope === true ? null : scope);
    return { ok: !l.issues?.length, detail: `${l.issues?.length ?? 0} UI issue(s)` };
  },
  async events(ctx, names) {
    const events = ctx.bench.events;
    if (!events) throw new Error("no event bridge available");
    await events.set([...new Set([...events.subscriptions, ...names])]);
    ctx.cursor = events.history.length;
    return { ok: true, detail: `listening for ${names.join(", ")}` };
  },
  async await(ctx, a) {
    const events = ctx.bench.events;
    if (!events?.subscriptions.includes(a.event)) {
      throw new Error(`not listening for ${a.event}; add an "events" step first`);
    }
    await events.poll();
    const timeoutMs = a.timeoutMs ?? AWAIT_TIMEOUT_MS;
    const w = await events.waitFor({ event: a.event, match: a.match, timeoutMs, none: !!a.none, from: ctx.cursor });
    if (w.event && w.ok) ctx.cursor = w.index + 1;
    return { ok: w.ok, detail: awaitDetail(a, w) };
  },
  async sample(ctx) {
    const s = await ctx.bench.sampleWatches();
    const bad = s ? Object.entries(s.invariants).filter(([, v]) => !v.ok).map(([k]) => k) : [];
    return { ok: !bad.length, detail: bad.length ? `violated: ${bad.join(", ")}` : "invariants hold" };
  },
};

const failure = (e) => ({ ok: false, detail: `error: ${e.message}` });

async function runStep(ctx, kind, value) {
  try {
    if (!value) return { ok: false, detail: `error: the ${kind} step has no value` };
    return await STEP_HANDLERS[kind](ctx, value);
  } catch (e) {
    return failure(e);
  }
}

const stepLine = (n, r) => `${r.ok ? "ok  " : "FAIL"} step ${n}: ${r.detail.split("\n")[0]}`;

async function recipeContext(bench, recipe, endTurns) {
  return {
    bench,
    recipe,
    endTurns,
    snapshot: (await bench.status()).snapshot,
    cursor: bench.events?.history.length ?? 0, // awaits only see events from the recipe's own listening
  };
}

/** @typedef {{ endTurns?: ((n: number) => Promise<unknown[]>) | null, log?: (line: string) => void }} RecipeOptions */

export async function runRecipe(bench, recipe, /** @type {RecipeOptions} */ { endTurns, log = () => {} } = {}) {
  const problem = validateRecipe(recipe);
  if (problem) throw new Error(problem);
  const ctx = await recipeContext(bench, recipe, endTurns);
  const results = [];
  for (const [i, step] of recipe.steps.entries()) {
    const kind = kindsOf(step)[0];
    const r = await runStep(ctx, kind, step[kind]);
    ctx.snapshot = (await bench.status().catch(() => ({}))).snapshot ?? ctx.snapshot;
    results.push({ step: i + 1, kind, ...r });
    log(stepLine(i + 1, r));
    if (!r.ok && recipe.stopOnFail !== false) break;
  }
  const passed = results.length === recipe.steps.length && results.every((x) => x.ok);
  noteTechniques(bench, recipe, passed, endTurns);
  return { name: recipe.name ?? null, passed, results };
}

// Only a lab game (the caller can end turns) is controlled enough to count as watching a technique.
function noteTechniques(bench, recipe, passed, inLab) {
  if (!inLab || !recipe.techniques?.length) return;
  const version = bench.version ?? null;
  recordTechniqueRun(bench.paths, { ids: recipe.techniques, recipe: recipe.name ?? null, passed, version });
}

const undoneIds = (entries) => new Set(entries
  .filter((e) => e.kind === "undo" && LANDED.includes(e.result?.verdict))
  .map((e) => e.undoOf));

// Turns today's landed writes into a recipe, in order, skipping writes that were undone.
export function recipeFromEvidence(entries, /** @type {{ since?: string }} */ { since } = {}) {
  const undone = undoneIds(entries);
  const steps = entries
    .filter((e) => e.kind === "write" && e.result?.verdict === "LANDED" && !undone.has(e.id ?? e.ts))
    .filter((e) => !since || new Date(e.ts).toTimeString().slice(0, 5) >= since) // since is local HH:MM
    .map((e) => ({ write: { op: e.request.op, args: e.request.args } }));
  return { name: "recorded", steps: [{ snapshot: "start" }, ...steps, { diff: "start" }] };
}
