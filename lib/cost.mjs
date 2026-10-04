// What a mod costs per turn: seeded test games with the mod off and on, turns ended without Autoplay (it
// spends the treasury, so its economy differs from run to run), and per turn the wall time from turn end
// to the next local turn start, the page's JS heap, the process's resident memory, CDP metrics where the
// debugger answers, and new error lines in the logs.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readMetrics } from "./canvas.mjs";
import { LogTail } from "./logs.mjs";

export const TURN_EVENTS = ["LocalPlayerTurnEnd", "LocalPlayerTurnBegin"];
/** @type {[string, string | null][]} */
const METRIC_DOMAINS = [["Performance.getMetrics", "Performance.enable"], ["Memory.getDOMCounters", null]];
const stampNow = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const isOfficial = (p) => /\/Resources\/(DLC|Base)\//.test(String(p).replaceAll("\\", "/"));

// ---------- statistics (pure) ----------

/** Linear-interpolated quantile of unsorted numbers; NaN for none. */
export function quantile(values, q) {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
}

export function describe(values) {
  const v = values.filter((x) => Number.isFinite(x));
  return { n: v.length, median: quantile(v, 0.5), p90: quantile(v, 0.9), iqr: quantile(v, 0.75) - quantile(v, 0.25),
    min: v.length ? Math.min(...v) : NaN, max: v.length ? Math.max(...v) : NaN };
}

/**
 * Off against on for one metric. `off` and `on` hold one array of per-turn values per replicate. The spread is
 * crude on purpose: the larger of the notch half-widths summed (1.58 IQR / sqrt n per arm, the box-plot test for
 * two medians) and the range of the replicate medians within an arm (run-to-run drift the notches cannot see).
 * @param {number[][]} off @param {number[][]} on
 */
export function compareMetric(off, on) {
  const a = describe(off.flat());
  const b = describe(on.flat());
  const repMedians = { off: off.map((r) => quantile(r, 0.5)), on: on.map((r) => quantile(r, 0.5)) };
  const range = (xs) => (xs.filter(Number.isFinite).length > 1 ? Math.max(...xs) - Math.min(...xs) : 0);
  const notch = (d) => (d.n ? (1.58 * d.iqr) / Math.sqrt(d.n) : NaN);
  const noise = Math.max(notch(a) + notch(b), range(repMedians.off), range(repMedians.on));
  const diff = b.median - a.median;
  return { off: a, on: b, diff, noise, significant: Number.isFinite(noise) && Math.abs(diff) > noise, repMedians };
}

/**
 * The headline from the wall-time comparison. A difference inside the noise is "no measurable cost" only when the
 * noise itself is small (under `floorMs` or `relative` of the off median); otherwise the run cannot tell.
 */
const ms = (x) => `${Math.round(x)} ms`;

function significantVerdict({ diff, noise, off, on }) {
  if (diff > 0) {
    return { verdict: `COSTS ~${ms(diff)} per turn`,
      detail: `median ${ms(off.median)} off, ${ms(on.median)} on; noise ±${ms(noise)}` };
  }
  return { verdict: "NOISY: more replicates", detail: `on was ${ms(-diff)} faster than off, beyond the ±${ms(noise)} `
    + "noise: that points at drift between runs, not at the mod" };
}

/** @param {any} wall @param {{ floorMs?: number, relative?: number, replicates?: number }} [opts] */
export function costVerdict(wall, opts = {}) {
  const { floorMs = 50, relative = 0.05, replicates = 2 } = opts;
  return judgeWall(wall, Math.max(floorMs, relative * wall.off.median), replicates);
}

function judgeWall(wall, tight, replicates) {
  const { diff, noise, off, on } = wall;
  if (!off.n || !on.n) return { verdict: "NO DATA", detail: "no turn was measured in one of the arms" };
  if (wall.significant) return significantVerdict(wall);
  if (noise <= tight && replicates > 1) {
    return { verdict: "NO MEASURABLE COST", detail: `difference ${ms(diff)} within ±${ms(noise)} noise (median `
      + `${ms(off.median)} off, ${ms(on.median)} on)` };
  }
  const single = replicates > 1 ? "" : " (one replicate per arm gives no run-to-run spread)";
  return { verdict: "NOISY: more replicates",
    detail: `difference ${ms(diff)}, noise ±${ms(noise)}; a cost under ${ms(noise)} cannot be told apart${single}` };
}

const metricNames = (trials) => [...new Set(trials.flatMap((t) => t.samples.flatMap((s) => Object.keys(s.metrics))))];

/**
 * Pure: the whole report from the trials. Each trial is { arm: "off" | "on", replicate, samples: [{ turn, metrics:
 * { name: number } }] }. The first `warmup` turns of each game are dropped (the first turn pays for loading).
 */
/** @param {any[]} trials @param {{ warmup?: number, floorMs?: number, relative?: number }} [opts] */
export function costReport(trials, { warmup = 1, floorMs, relative } = {}) {
  const arm = (a) => trials.filter((t) => t.arm === a && t.samples.length);
  const series = (a, name) => arm(a).map((t) => t.samples.slice(warmup).map((s) => s.metrics[name])
    .filter((v) => Number.isFinite(v)));
  /** @type {Record<string, ReturnType<typeof compareMetric>>} */
  const metrics = {};
  for (const name of metricNames(trials)) metrics[name] = compareMetric(series("off", name), series("on", name));
  const replicates = Math.min(arm("off").length, arm("on").length);
  const wall = metrics.wallMs ?? compareMetric([], []);
  return { ...costVerdict(wall, { floorMs, relative, replicates }), replicates, warmup, metrics,
    failures: trials.filter((t) => t.error || t.crashReports?.length).map((t) => ({
      arm: t.arm, replicate: t.replicate, error: t.error ?? null, crashReports: t.crashReports ?? [],
    })) };
}

// ---------- measurement (needs the game; built against fakes) ----------

export function rssMB(pid) {
  if (!pid) return NaN;
  const r = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  const kb = Number(r.stdout.trim());
  return r.status === 0 && kb > 0 ? kb / 1024 : NaN;
}

const ERROR_LINE = /\berror\b|exception|failed/i;

async function cdpMetrics(bench, enabled) {
  /** @type {Record<string, number>} */
  const out = {};
  const heap = await bench.cdp.send("Runtime.getHeapUsage", {}, 5000).catch(() => null);
  if (heap?.usedSize) out.heapUsedMB = heap.usedSize / 1048576;
  for (const [method] of METRIC_DOMAINS.filter(([m]) => enabled[m] === true)) {
    const r = await readMetrics(bench.cdp, method, 5000).catch(() => null);
    if (r) Object.assign(out, r.values);
  }
  return out;
}

async function enableDomains(bench) {
  /** @type {Record<string, true | string>} */
  const enabled = {};
  for (const [method, enable] of METRIC_DOMAINS) {
    try {
      if (enable) await bench.cdp.send(enable, {}, 3000);
      await readMetrics(bench.cdp, method, 3000);
      enabled[method] = true;
    } catch (e) {
      enabled[method] = e instanceof Error ? e.message : String(e);
    }
  }
  return enabled;
}

// Cumulative CDP counters (task time, layout counts) mean something per turn only as a change, so every CDP
// metric is reported as its change since the previous turn start.
function perTurn(raw, prev) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "heapUsedMB") out[k] = v;
    else if (prev && Number.isFinite(prev[k])) out[`${k} (per turn)`] = v - prev[k];
  }
  return out;
}

async function oneTurn(ctx, prev) {
  const { bench, lab, log, timeoutMs } = ctx;
  const from = bench.events.history.length;
  const [rolled] = await lab.endTurns(1, { timeoutMs, log });
  const begin = await bench.events.waitFor({ event: "LocalPlayerTurnBegin", from, timeoutMs: 15000 });
  const end = bench.events.history.slice(from).find((e) => e.name === "LocalPlayerTurnEnd");
  const fromEvents = begin.ok && end && begin.event ? begin.event.t - end.t : NaN;
  await bench.cdp.ensure();
  const raw = await cdpMetrics(bench, ctx.enabled);
  const errors = ctx.tail.poll().filter((l) => l.severity === "error" || ERROR_LINE.test(l.text)).length;
  const metrics = { wallMs: Number.isFinite(fromEvents) ? fromEvents : rolled.ms, rssMB: ctx.rssOf(ctx.pid()),
    errorLines: errors, ...perTurn(raw, prev) };
  return { sample: { turn: rolled.to, wallSource: Number.isFinite(fromEvents) ? "events" : "poll", metrics }, raw };
}

/**
 * Ends `turns` turns in the running lab game and samples each turn start.
 * @param {{ bench: any, lab: any, turns: number, pid: () => number | null, rssOf?: (pid: number | null) => number,
 *   tail?: { poll: () => any[] }, log?: (line: string) => void, timeoutMs?: number }} o
 */
export async function measureTurns(o) {
  const { bench, lab, turns, pid, rssOf = rssMB, tail, log = () => {}, timeoutMs = 180000 } = o;
  await bench.events.set([...new Set([...bench.events.subscriptions, ...TURN_EVENTS])]);
  const enabled = await enableDomains(bench);
  const ctx = { bench, lab, log, timeoutMs, pid, rssOf, enabled, tail: tail ?? { poll: () => [] } };
  let prev = await cdpMetrics(bench, enabled);
  const samples = [];
  for (let i = 0; i < turns; i++) {
    const r = await oneTurn(ctx, prev);
    samples.push(r.sample);
    prev = r.raw;
  }
  return { samples, domains: enabled };
}

// ---------- orchestration ----------

/** The registry rows a cost run switches: the target's one copy, plus every other enabled non-official mod. */
export function costPlan(rows, modId) {
  const copies = rows.filter((r) => r.id === modId && !isOfficial(r.path));
  const enabled = copies.filter((r) => !r.disabled);
  const target = enabled.length === 1 ? enabled[0] : copies.length === 1 ? copies[0] : null;
  if (!copies.length) throw new Error(`${modId} is not a registered user mod`);
  if (!target) throw new Error(`${modId} has ${copies.length} copies; pick one with "mods live" first`);
  const others = rows.filter((r) => !r.disabled && !isOfficial(r.path) && r.id !== modId && r.id !== "tower-bench-agent");
  const candidates = [...others, target].map((r) => ({ id: r.id, path: r.path }));
  const offIds = others.map((r) => r.id);
  return { target: { id: target.id, path: target.path }, candidates, off: offIds, on: [...offIds, modId] };
}

// Off then on in even replicates, on then off in odd ones, so slow drift over the session cancels.
export function trialOrder(replicates) {
  const order = [];
  for (let k = 0; k < replicates; k++) {
    for (const arm of k % 2 ? ["on", "off"] : ["off", "on"]) order.push({ arm, replicate: k + 1 });
  }
  return order;
}

const errorText = (e) => (e instanceof Error ? e.message : String(e));

async function playMeasured(d, o) {
  await d.lab.startNewGame({ seed: o.seed, age: o.age });
  d.lab.setCurrent({ ...d.lab.current, pid: d.gamePid() });
  d.bench.cdp.close();
  const tail = d.makeTail();
  return measureTurns({ bench: d.bench, lab: d.lab, turns: o.turns, pid: d.gamePid, rssOf: d.rssOf, tail, log: d.log });
}

async function runTrial(d, plan, o, { arm, replicate }) {
  const dir = path.join(d.lab.root, `cost-${stampNow()}-${arm}-${replicate}`);
  d.lab.backup(dir);
  d.lab.setCurrent({ dir, startedAt: new Date().toISOString(), seed: o.seed, age: o.age ?? null, cost: true });
  /** @type {any} */
  let trial = { arm, replicate, samples: [] };
  try {
    d.applyModSet(d.paths.modsDb, plan.candidates, plan[arm]);
    trial = { ...trial, ...(await playMeasured(d, o)) };
  } catch (e) {
    trial.error = errorText(e);
  } finally {
    await d.lab.quit({ log: d.log });
    const rep = d.lab.restore(dir);
    d.lab.setCurrent(null);
    trial.crashReports = rep.crashReports;
    const request = { mod: plan.target.id, arm, replicate, seed: o.seed, enabled: plan[arm] };
    const result = { turns: trial.samples.length, error: trial.error ?? null, restored: rep.restored,
      registry: rep.registry };
    d.bench.log({ kind: "cost-trial", request, result });
  }
  d.log(`${arm} replicate ${replicate}: ${trial.samples.length} turn(s) measured${trial.error ? `; ${trial.error}` : ""}`);
  return trial;
}

/**
 * Runs the whole off/on comparison. Everything that touches the machine comes in through `d`, so tests drive it
 * with fakes: { lab, bench, paths, registryRows, applyModSet, gamePid, rssOf, makeTail, log }.
 * @param {any} d
 * @param {{ modId: string, turns?: number, seed?: number, age?: string, replicates?: number, warmup?: number }} o
 */
export async function runCost(d, { modId, turns = 20, seed = 4242, age, replicates = 2, warmup = 1 }) {
  const plan = costPlan(d.registryRows(d.paths.modsDb), modId);
  const o = { turns, seed, age };
  d.log(`${modId}: ${replicates} replicate(s) of ${turns} turns off and on, seed ${seed}, `
    + `${plan.off.length} other mod(s) left as they are`);
  const trials = [];
  for (const step of trialOrder(replicates)) trials.push(await runTrial(d, plan, o, step));
  const report = costReport(trials, { warmup });
  const record = { mod: modId, at: new Date().toISOString(), seed, age: age ?? null, turns, requested: replicates,
    ...report,
    domains: trials.find((t) => t.domains)?.domains ?? null, trials };
  d.bench.log({ kind: "cost", request: { mod: modId, seed, turns, replicates }, result: { verdict: report.verdict,
    detail: report.detail } });
  return record;
}

export const costDir = (paths) => path.join(path.dirname(paths.evidence), "runs");

export function writeCostReport(paths, record) {
  const dir = costDir(paths);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `cost-${stampNow()}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}

/** Saved cost reports, newest first, without their per-turn samples. */
export function listCostReports(paths, limit = 20) {
  const dir = costDir(paths);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^cost-.*\.json$/.test(f)).sort().reverse().slice(0, limit); } catch { return []; }
  return files.flatMap((f) => {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      delete r.trials;
      return [{ file: f, ...r }];
    } catch {
      return [];
    }
  });
}

export const makeLogTail = (paths) => () => {
  const t = new LogTail(paths.logs);
  t.seekToEnd();
  return t;
};
