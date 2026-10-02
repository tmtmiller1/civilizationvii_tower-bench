/* global UI */
// Code coverage for a mod, CDP route: V8 precise coverage through the debugger's Profiler domain, which
// changes no file. Whether the game's debugger implements it is the first question, so `probe` asks it and
// returns each answer or error as given. Coverage lives in one debugger session: the server keeps it between
// start and take; the CLI does both in one process (coverage cdp --for N).
import path from "node:path";
import { BenchError } from "./bench.mjs";
import { mapCdp, summarize } from "./coverage-map.mjs";
import { modJsFiles, saveRead } from "./coverage.mjs";
import fs from "node:fs";

const messageOf = (e) => (e instanceof Error ? e.message : String(e));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const START = { callCount: true, detailed: true };

/** @type {WeakMap<object, { ws: unknown, at: string, url: string | null }>} */
const sessions = new WeakMap();

/** A short account of a CDP answer, small enough to log. */
export function describeAnswer(method, r) {
  if (method === "Schema.getDomains") return (r?.domains ?? []).map((d) => `${d.name} ${d.version ?? ""}`.trim());
  if (method === "Profiler.takePreciseCoverage") {
    const scripts = Array.isArray(r?.result) ? r.result : [];
    return {
      scripts: scripts.length,
      functions: scripts.reduce((n, s) => n + (s.functions?.length ?? 0), 0),
      urls: [...new Set(scripts.map((s) => s.url).filter(Boolean))].slice(0, 12),
    };
  }
  return r ?? null;
}

async function protocolCommands(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/protocol`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const doc = await res.json();
    const profiler = (doc.domains ?? []).find((d) => d.domain === "Profiler");
    return profiler ? { commands: (profiler.commands ?? []).map((c) => c.name) } : { error: "no Profiler domain listed" };
  } catch (e) {
    return { error: messageOf(e) };
  }
}

const running = (bench) => {
  const s = sessions.get(bench);
  return s && s.ws === bench.cdp.ws ? s : null;
};

/**
 * The cheap test: does the debugger answer the Profiler domain, and does precise coverage return scripts?
 * Leaves the Profiler as it found it.
 */
export async function probeProfiler(bench) {
  await bench.requireConnection();
  const steps = [];
  const call = async (method, params = {}, timeoutMs = 10000) => {
    try {
      const r = await bench.cdp.send(method, params, timeoutMs);
      steps.push({ method, ok: true, answer: describeAnswer(method, r) });
      return r;
    } catch (e) {
      steps.push({ method, ok: false, error: messageOf(e) });
      return null;
    }
  };
  const live = running(bench);
  await call("Schema.getDomains");
  if (!live) await call("Profiler.enable");
  if (!live) await call("Profiler.startPreciseCoverage", START);
  const taken = await call("Profiler.takePreciseCoverage", {}, 60000);
  if (!live) await call("Profiler.stopPreciseCoverage");
  if (!live) await call("Profiler.disable");
  const protocol = await protocolCommands(bench.paths.cdpPort);
  const verdict = Array.isArray(taken?.result) ? "PROFILER ANSWERS" : "NO PRECISE COVERAGE";
  const result = { verdict, scope: bench.cdp.scope, steps, protocol };
  bench.log({ kind: "coverage-probe", request: {}, result: { verdict, steps: steps.map((s) => ({ method: s.method, ok: s.ok, error: s.error })) } });
  return result;
}

/** Starts V8 precise coverage in this debugger session; with reload, reloads the UI so load-time code counts. */
export async function cdpStart(bench, { reload = false } = {}) {
  await bench.requireConnection();
  await bench.cdp.send("Profiler.enable", {}, 10000);
  await bench.cdp.send("Profiler.startPreciseCoverage", START, 10000);
  const s = { ws: bench.cdp.ws, at: new Date().toISOString(), url: bench.cdp.target?.url ?? null };
  sessions.set(bench, s);
  if (reload) await bench.cdp.call(() => { UI.reloadUI(); return true; }).catch(() => null);
  bench.log({ kind: "coverage-cdp-start", request: { reload }, result: { url: s.url } });
  return { started: s.at, url: s.url, reloaded: reload };
}

export async function cdpStop(bench) {
  const s = running(bench);
  sessions.delete(bench);
  if (!s) return { stopped: false };
  await bench.cdp.send("Profiler.stopPreciseCoverage", {}, 10000).catch(() => null);
  await bench.cdp.send("Profiler.disable", {}, 10000).catch(() => null);
  return { stopped: true };
}

// The folder the game serves the mod from: the live copy when one is enabled, else the source.
function servedFiles(bench, dir) {
  const plan = bench.planFor(dir);
  const liveDir = plan.liveDir ?? plan.srcDir;
  const notes = plan.liveDir ? [] : [`no enabled copy found (${plan.refuse}); offsets read from the source folder`];
  const files = modJsFiles(plan.srcDir).files.map((rel) => {
    const p = path.join(liveDir, rel);
    return { rel, text: fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null };
  });
  return { modId: plan.modId, roots: [plan.modId, path.basename(liveDir)], files, notes };
}

/** Takes the coverage gathered since start, maps it to one mod's files and saves it. */
export async function cdpTake(bench, dir, { stop = false } = {}) {
  if (!sessions.get(bench)) {
    throw new BenchError("CDP coverage is not running in this process. \"coverage cdp <mod-folder> --for N\" starts, "
      + "waits and takes in one go; the server keeps it between start and take.", 409);
  }
  await bench.requireConnection();
  const s = running(bench);
  if (!s) throw new BenchError("the debugger reconnected since coverage started (the page changed); start again", 409);
  const mod = servedFiles(bench, dir);
  const r = await bench.cdp.send("Profiler.takePreciseCoverage", {}, 120000);
  const cov = mapCdp(r?.result ?? [], mod);
  cov.page = s.url;
  cov.notes.push(...mod.notes, `counts since ${s.at}; code that ran before the start is not counted`);
  const saved = saveRead(bench.paths, cov);
  if (stop) await cdpStop(bench);
  const summary = summarize(cov);
  bench.log({ kind: "coverage-cdp-take", request: { modId: mod.modId },
    result: { saved, functions: summary.total.functions, blocks: summary.total.blocks } });
  return { saved, ...summary };
}

/** Start, wait `seconds` while the game is played, take, stop. */
export async function cdpRun(bench, dir, { seconds = 60, reload = false } = {}) {
  bench.planFor(dir);
  await cdpStart(bench, { reload });
  await sleep(seconds * 1000);
  return cdpTake(bench, dir, { stop: true });
}
