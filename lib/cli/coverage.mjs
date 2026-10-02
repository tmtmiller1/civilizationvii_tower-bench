import { BenchError } from "../bench.mjs";
import { formatReport, summarize } from "../coverage-map.mjs";
import { cdpRun, cdpStart, cdpStop, cdpTake, probeProfiler } from "../coverage-cdp.mjs";
import {
  dumpCounts, instrumentMod, listReads, loadRead, modIdOf, planInstrument, readInstrumented, resetCounts, restoreMod,
} from "../coverage.mjs";
import { num, out } from "./common.mjs";

export const COVERAGE_HELP = `  coverage probe                       does the game's debugger answer the Profiler domain? each CDP
                                       answer or error as given (the cheap test for the CDP route)
  coverage cdp <mod-folder> [--for 60] [--reload]
                                       V8 precise coverage: start, wait while you play, take, map onto
                                       the mod's files (changes no file)
  coverage instrument <mod-folder> [--yes]
                                       write counting copies of the mod's JS into the copy the game
                                       loads (never the source or a Workshop copy), reload, prove served
  coverage restore <mod-folder> --yes  put the plain source back over the counting copies
  coverage read [mod] [--log]          read the counters from the page (--log: the newest dump in UI.log)
  coverage dump | reset                write the counters to UI.log / zero them
  coverage report [mod] [--md]         per file: functions and blocks hit, and what never ran`;

const frac = (h) => `${h.hit}/${h.total}`;

function printPlan(r) {
  const verb = r.applied ? "instrumented" : "would instrument";
  out(`${r.modId}: ${verb} ${r.files.filter((f) => !f.skipped).length} of ${r.files.length} file(s) in ${r.liveDir}`);
  for (const f of r.files) {
    out(`  ${f.rel.padEnd(48)} ${f.skipped ?? `${f.functions} functions, ${f.blocks} blocks`}`);
  }
  if (!r.applied) return out("nothing written; add --yes to write the counting copies");
  for (const f of r.files) if (f.live) out(`  live: ${f.rel} ${f.live}`);
  if (r.connected === false) out("not connected: the files are written; the game picks them up when it loads the mod");
  else if (r.reloaded === false) out("the page did not reload; the counting copies are on disk but not running yet");
  return out("next: play the screens under test, then \"coverage read\" and \"coverage report\"");
}

function printProbe(r) {
  out(`${r.verdict} (debugger on the ${r.scope} page)`);
  for (const s of r.steps) {
    out(`  ${s.method}: ${s.ok ? "answered" : `ERROR ${s.error}`}`);
    if (s.ok && s.answer) out(`    ${JSON.stringify(s.answer).slice(0, 600)}`);
  }
  out(`  /json/protocol Profiler: ${r.protocol.commands ? r.protocol.commands.join(", ") : r.protocol.error}`);
}

function printSummaries(list) {
  for (const s of list) {
    out(`${s.modId} (${s.route}): functions ${frac(s.total.functions)}, blocks ${frac(s.total.blocks)}; `
      + `${s.neverRan.length} function(s) never ran; saved ${s.saved}`);
    for (const n of s.notes) out(`  note: ${n}`);
  }
}

/** @type {Record<string, (ctx: import("./common.mjs").Ctx, args: string[]) => unknown>} */
const SUBS = {
  probe: async ({ bench, opt }) => {
    const r = await probeProfiler(bench);
    return opt.json ? out(r) : printProbe(r);
  },
  cdp: async ({ bench, opt }, [dir]) => {
    if (!dir) throw new BenchError("coverage cdp <mod-folder> [--for 60]");
    const seconds = num(opt.for) ?? 60;
    if (!opt.json) out(`counting for ${seconds}s: play the screens under test now`);
    const reload = !!(/** @type {Record<string, unknown>} */ (opt)).reload;
    const r = await cdpRun(bench, dir, { seconds, reload });
    return opt.json ? out(r) : printSummaries([r]);
  },
  instrument: async ({ bench, opt }, [dir]) => {
    if (!dir) throw new BenchError("coverage instrument <mod-folder> [--yes]");
    const r = await instrumentMod(bench, dir, { yes: !!opt.yes, reload: !opt["no-reload"] });
    return opt.json ? out(r) : printPlan(r);
  },
  restore: async ({ bench, opt }, [dir]) => {
    if (!dir) throw new BenchError("coverage restore <mod-folder> --yes");
    const r = await restoreMod(bench, dir, { yes: !!opt.yes, reload: !opt["no-reload"] });
    if (opt.json) return out(r);
    if (!r.applied) return out(r.files.length ? `would restore: ${r.files.join(", ")}; add --yes` : "nothing to restore");
    return out(`restored ${r.files.length} file(s): ${r.files.map((f) => `${f.rel} ${f.live}`).join(", ")}`);
  },
  read: async ({ bench, opt }, [mod]) => {
    const r = await readInstrumented(bench, { mod, fromLog: !!opt.log });
    return opt.json ? out(r) : printSummaries(r);
  },
  dump: async ({ bench, opt }) => {
    const r = await dumpCounts(bench);
    return opt.json ? out(r) : out(r.installed ? `wrote ${r.lines} [TB-COVERAGE] line(s) to UI.log` : "no counting copy on this page");
  },
  reset: async ({ bench, opt }) => {
    const r = await resetCounts(bench);
    return opt.json ? out(r) : out(r.installed ? "counts zeroed" : "no counting copy on this page");
  },
  report: ({ paths, opt }, [mod]) => {
    const name = listReads(paths, modIdOf(mod))[0];
    const cov = loadRead(paths, name);
    if (!cov) throw new BenchError(`no coverage read saved${mod ? ` for ${mod}` : ""}; run coverage read or coverage cdp`, 404);
    if (opt.json) return out(summarize(cov));
    return out(formatReport(cov, { md: !!opt.md }));
  },
};

/** @type {Record<string, import("./common.mjs").Handler>} */
export const COVERAGE_COMMANDS = {
  coverage(ctx, [sub = "report", ...rest]) {
    if (!Object.hasOwn(SUBS, sub)) throw new BenchError(`coverage ${Object.keys(SUBS).join(" | ")}`);
    return SUBS[sub](ctx, rest);
  },
};

const wrap = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    throw e instanceof BenchError ? e : new BenchError(e instanceof Error ? e.message : String(e));
  }
};

export const COVERAGE_ROUTES = {
  "POST /api/coverage/probe": (bench) => wrap(() => probeProfiler(bench)),
  "GET /api/coverage/plan": (bench, _req, q) => wrap(() => {
    const { plan, files } = planInstrument(bench, q.get("dir"));
    return { modId: plan.modId, liveDir: plan.liveDir, files: files.map((f) => ({ rel: f.rel, skipped: f.skipped,
      functions: f.table.filter((s) => s.k === "f").length, blocks: f.table.filter((s) => s.k === "b").length })) };
  }),
  "POST /api/coverage/instrument": async (bench, _req, _q, readBody) => {
    const b = await readBody();
    return wrap(() => instrumentMod(bench, b.dir, { yes: true }));
  },
  "POST /api/coverage/restore": async (bench, _req, _q, readBody) => {
    const b = await readBody();
    return wrap(() => restoreMod(bench, b.dir, { yes: true }));
  },
  "POST /api/coverage/read": async (bench, _req, _q, readBody) => {
    const b = await readBody();
    return wrap(() => readInstrumented(bench, { mod: b.mod || undefined, fromLog: !!b.log }));
  },
  "POST /api/coverage/dump": (bench) => wrap(() => dumpCounts(bench)),
  "POST /api/coverage/reset": (bench) => wrap(() => resetCounts(bench)),
  "POST /api/coverage/cdp/start": async (bench, _req, _q, readBody) => {
    const b = await readBody();
    return wrap(() => cdpStart(bench, { reload: !!b.reload }));
  },
  "POST /api/coverage/cdp/take": async (bench, _req, _q, readBody) => {
    const b = await readBody();
    return wrap(() => cdpTake(bench, b.dir, { stop: !!b.stop }));
  },
  "POST /api/coverage/cdp/stop": (bench) => wrap(() => cdpStop(bench)),
  "GET /api/coverage/reads": (bench, _req, q) => listReads(bench.paths, modIdOf(q.get("mod") || undefined)).slice(0, 50),
  "GET /api/coverage/report": (bench, _req, q) => wrap(() => {
    const name = q.get("name") || listReads(bench.paths, modIdOf(q.get("mod") || undefined))[0];
    const cov = loadRead(bench.paths, name);
    if (!cov) throw new BenchError("no coverage read saved; read the counters or take CDP coverage first", 404);
    return { name, ...summarize(cov), markdown: formatReport(cov, { md: true }) };
  }),
};
