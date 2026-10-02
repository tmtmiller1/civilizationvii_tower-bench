/* global UI */
import fs from "node:fs";
import path from "node:path";
import { canvasStress } from "./engine-canvas.mjs";

// The canvas pool test, Node side. A candidate counts the pool if it moves by roughly one per paint call
// (dense real workloads were reported at about 0.23 per call after merging) and does not move without
// painting. The crash itself is read from Renderer.log and the last breadcrumb in UI.log.

export const POOL_LIMIT = 49152;
export const CRASH_LINE = /PartitionedResourceList\.AddStaticResource\(\), attempting to add more than (\d+) items/;

/**
 * @param {Record<string, number>} before @param {Record<string, number>} control after a no-paint wait
 * @param {Record<string, number>} after after painting `k` calls
 */
export function judgeCandidates(before, control, after, k) {
  const rows = [];
  for (const key of Object.keys(after)) {
    if (!(key in before) || !(key in control)) continue;
    const drift = control[key] - before[key];
    const moved = after[key] - control[key];
    const perCall = k ? moved / k : 0;
    // Steady drift does not count, and the move has to be in the reported range per call.
    const tracks = Math.abs(drift) <= Math.max(1, Math.abs(moved) * 0.05) && perCall >= 0.15 && perCall <= 1.5;
    if (moved !== 0 || drift !== 0) rows.push({ key, drift, moved, perCall: Number(perCall.toFixed(3)), tracks });
  }
  rows.sort((a, b) => Number(b.tracks) - Number(a.tracks) || Math.abs(b.moved) - Math.abs(a.moved));
  return { verdict: rows.some((r) => r.tracks) ? "COUNTER FOUND" : "NO COUNTER", rows };
}

// Flattens CDP metric answers ({ metrics: [{ name, value }] }, or plain number fields) into one map.
export function flattenMetrics(prefix, result) {
  const out = {};
  if (Array.isArray(result?.metrics)) {
    for (const m of result.metrics) if (typeof m.value === "number") out[`${prefix}.${m.name}`] = m.value;
  }
  for (const [k, v] of Object.entries(result ?? {})) if (typeof v === "number") out[`${prefix}.${k}`] = v;
  return out;
}

/** The crash evidence after the game died: the renderer's line and the last breadcrumb before it. */
export function readCrashEvidence(logsDir) {
  const read = (f) => { try { return fs.readFileSync(path.join(logsDir, f), "utf8"); } catch { return ""; } };
  const renderer = read("Renderer.log").split(/\r?\n/).find((l) => CRASH_LINE.test(l)) ?? null;
  const crumbs = read("UI.log").split(/\r?\n/).filter((l) => l.includes("[TB-CANVAS-STRESS]"));
  const last = crumbs.at(-1) ?? null;
  return {
    rendererLine: renderer,
    limit: renderer ? Number(renderer.match(CRASH_LINE)?.[1]) : null,
    lastBreadcrumb: last,
    painted: last ? Number(last.match(/painted=(\d+)/)?.[1]) : null,
    pages: [...new Set(crumbs.map((l) => l.match(/page=(\w+)/)?.[1]).filter(Boolean))],
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reloads the page once the first run reaches reloadAt, then resumes painting on the new page from that count.
async function resumeAfterReload(bench, st, { batch, limit }) {
  await bench.cdp.call(() => { UI.reloadUI(); return true; }).catch(() => null);
  await sleep(8000);
  await bench.requireGame();
  await bench.cdp.call(canvasStress, { op: "start", batch, limit, start: st.painted });
}

const STRESS_DEFAULTS = { limit: 200000, batch: 1000, reloadAt: 0, timeoutMs: 15 * 60 * 1000 };

/**
 * Paints in the background until the game dies or `limit` calls are drawn, polling progress each second.
 * With reloadAt, the page is reloaded once at that count, which shows whether the pool lives as long as the
 * page or as long as the process.
 * @param {any} bench
 * @param {{ limit?: number, batch?: number, reloadAt?: number, timeoutMs?: number }} [opts]
 */
export async function runCanvasStress(bench, opts = {}) {
  const o = { ...STRESS_DEFAULTS, ...opts };
  const pid = bench.gamePid();
  const t0 = Date.now();
  const run = { reloaded: false, done: false };
  await bench.cdp.call(canvasStress, { op: "start", batch: o.batch, limit: o.reloadAt || o.limit });
  while (!run.done && Date.now() - t0 < o.timeoutMs && bench.gamePid() === pid) {
    await sleep(1000);
    await stressStep(bench, run, o);
  }
  await sleep(3000);
  return { crashed: bench.gamePid() !== pid, reloaded: run.reloaded, seconds: Math.round((Date.now() - t0) / 1000),
    ...readCrashEvidence(bench.paths.logs) };
}

async function stressStep(bench, run, o) {
  const st = await bench.cdp.call(canvasStress, { op: "read" }).catch(() => null);
  if (!st || st.running) return;
  if (o.reloadAt && !run.reloaded && st.painted >= o.reloadAt) {
    run.reloaded = true;
    await resumeAfterReload(bench, st, o);
  } else if (st.painted >= o.limit) run.done = true;
}
