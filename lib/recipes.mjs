// A recipe is a repeatable test as data: an optional seed and start age for a Play Now game, then
// steps. Seeded Play Now games are deterministic, so a recipe that reproduces once reproduces again.
//
// { "name": "strand-check", "seed": 4242, "age": "AGE_ANTIQUITY",
//   "steps": [ { "snapshot": "start" },
//              { "write": { "op": "unit.place", "args": { "at": "unit", "dx": 1, "type": "UNIT_SPEARMAN", "owner": 1 } } },
//              { "turns": 2 },
//              { "diff": "start" },
//              { "expect": "Players.get(1).Units.getUnitIds().length > 0" } ] }

const STEP_KINDS = ["snapshot", "write", "turns", "diff", "expect", "eval", "lint", "sample", "events", "await"];

export function validateRecipe(r) {
  if (!r || !Array.isArray(r.steps) || !r.steps.length) return "a recipe needs a non-empty steps array";
  for (const [i, s] of r.steps.entries()) {
    const kinds = Object.keys(s).filter((k) => STEP_KINDS.includes(k));
    if (kinds.length !== 1) return `step ${i + 1} must have exactly one of ${STEP_KINDS.join(", ")}`;
    if (s.write && !s.write.op) return `step ${i + 1}: write needs an op`;
    if (s.turns != null && !(Number.isInteger(s.turns) && s.turns > 0)) return `step ${i + 1}: turns must be a positive integer`;
    if (s.events && !(Array.isArray(s.events) && s.events.length && s.events.every((n) => typeof n === "string"))) return `step ${i + 1}: events must be a list of event names`;
    if (s.await && !s.await.event) return `step ${i + 1}: await needs an event name`;
  }
  return null;
}

// Positions can be absolute or anchored to the local player's first unit / the selected unit, with
// an offset, so one recipe works across seeds.
export function resolveAt(args, snapshot) {
  const { at, dx = 0, dy = 0, ...rest } = args;
  if (at === undefined) return args;
  let base;
  if (Array.isArray(at)) base = { x: at[0], y: at[1] };
  else if (at === "unit") base = snapshot?.firstUnit;
  else if (at === "selected") base = snapshot?.selectedUnit;
  else if (typeof at === "object") base = at;
  if (!base) throw new Error(`cannot resolve position "${JSON.stringify(at)}"`);
  return { ...rest, x: base.x + dx, y: base.y + dy };
}

export async function runRecipe(bench, recipe, { endTurns, log = () => {} } = {}) {
  const problem = validateRecipe(recipe);
  if (problem) throw new Error(problem);
  const results = [];
  let snapshot = (await bench.status()).snapshot;
  let cursor = bench.events?.history.length ?? 0; // awaits only see events from the recipe's own listening
  for (const [i, step] of recipe.steps.entries()) {
    const n = i + 1;
    let r;
    try {
      if (step.snapshot) {
        const s = await bench.snapshot(`${recipe.name ?? "recipe"}-${step.snapshot}`);
        r = { ok: true, detail: `snapshot ${s.label}${s.turn != null ? ` at turn ${s.turn}` : ""}` };
      }
      else if (step.write) {
        const w = await bench.write({ op: step.write.op, args: resolveAt(step.write.args ?? {}, snapshot) }, { waitMs: step.write.waitMs ?? 3000 });
        r = { ok: ["LANDED", "ALREADY"].includes(w.verdict), detail: `${w.description}: ${w.verdict}${w.landedMs != null ? ` in ${w.landedMs} ms` : ""}` };
      } else if (step.turns) {
        if (!endTurns) throw new Error("turn steps only run in a lab test game");
        const rolled = await endTurns(step.turns);
        r = { ok: true, detail: `ended ${rolled.length} turn(s)` };
      } else if (step.diff) {
        const d = await bench.diff(`${recipe.name ?? "recipe"}-${step.diff}`, "now");
        r = { ok: true, detail: d.text };
      } else if (step.expect) {
        const v = await bench.eval(step.expect, { depth: 1 });
        r = { ok: v === true, detail: `${step.expect} -> ${JSON.stringify(v)}` };
      } else if (step.eval) {
        r = { ok: true, detail: JSON.stringify(await bench.eval(step.eval, { depth: 2 })) };
      } else if (step.lint) {
        const l = await bench.lint(step.lint === true ? null : step.lint);
        r = { ok: !l.issues?.length, detail: `${l.issues?.length ?? 0} UI issue(s)` };
      } else if (step.events) {
        if (!bench.events) throw new Error("no event bridge available");
        await bench.events.set([...new Set([...bench.events.subscriptions, ...step.events])]);
        cursor = bench.events.history.length;
        r = { ok: true, detail: `listening for ${step.events.join(", ")}` };
      } else if (step.await) {
        const a = step.await;
        if (!bench.events?.subscriptions.includes(a.event)) throw new Error(`not listening for ${a.event}; add an "events" step first`);
        await bench.events.poll();
        const w = await bench.events.waitFor({ event: a.event, match: a.match, timeoutMs: a.timeoutMs ?? 60000, none: !!a.none, from: cursor });
        if (w.event && w.ok) cursor = w.index + 1;
        const what = `${a.event}${a.match ? ` where ${a.match}` : ""}`;
        r = a.none
          ? { ok: w.ok, detail: w.ok ? `no ${what} within ${a.timeoutMs ?? 60000} ms` : `unexpected ${what} at turn ${w.event.turn}` }
          : { ok: w.ok, detail: w.ok ? `${what} at turn ${w.event.turn}` : `no ${what} within ${a.timeoutMs ?? 60000} ms` };
      } else if (step.sample) {
        const s = await bench.sampleWatches();
        const bad = s ? Object.entries(s.invariants).filter(([, v]) => !v.ok).map(([k]) => k) : [];
        r = { ok: !bad.length, detail: bad.length ? `violated: ${bad.join(", ")}` : "invariants hold" };
      }
    } catch (e) {
      r = { ok: false, detail: `error: ${e.message}` };
    }
    snapshot = (await bench.status().catch(() => ({}))).snapshot ?? snapshot;
    results.push({ step: n, kind: Object.keys(step).find((k) => STEP_KINDS.includes(k)), ...r });
    log(`${r.ok ? "ok  " : "FAIL"} step ${n}: ${r.detail.split("\n")[0]}`);
    if (!r.ok && recipe.stopOnFail !== false) break;
  }
  return { name: recipe.name ?? null, passed: results.length === recipe.steps.length && results.every((x) => x.ok), results };
}

// Turns today's landed writes into a recipe, in order, skipping writes that were undone.
export function recipeFromEvidence(entries, { since } = {}) {
  const undone = new Set(entries.filter((e) => e.kind === "undo" && ["LANDED", "ALREADY"].includes(e.result?.verdict)).map((e) => e.undoOf));
  const steps = entries
    .filter((e) => e.kind === "write" && e.result?.verdict === "LANDED" && !undone.has(e.id ?? e.ts))
    .filter((e) => !since || new Date(e.ts).toTimeString().slice(0, 5) >= since) // since is local HH:MM
    .map((e) => ({ write: { op: e.request.op, args: e.request.args } }));
  return { name: "recorded", steps: [{ snapshot: "start" }, ...steps, { diff: "start" }] };
}
