import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BenchError } from "../bench.mjs";
import { runNightly } from "../nightly.mjs";
import { realDeps } from "../nightly-deps.mjs";
import { listReports, readReport, reportMarkdown } from "../nightly-report.mjs";
import { schedule, scheduleStatus, unschedule } from "../nightly-schedule.mjs";
import { defaultSuiteFile, initSuite, loadSuite } from "../nightly-suite.mjs";
import { out } from "./common.mjs";

/** @typedef {import("./common.mjs").Ctx} Ctx */

export const NIGHTLY_HELP = `  nightly init [dir] [--yes]           write a starter suite (suite.json) from the enabled local mods,
                                       one recipe each that loads a game; --yes replaces a suite
  nightly run [--suite F] [--only-if-updated] [--notify]
                                       regression run: on a new game version snapshot, diff and impact;
                                       then check and l10n each mod, and run its recipes in seeded lab
                                       games (restored after each); report PASS, FAIL or BROKE-BY-UPDATE
                                       with what newly fails or was fixed since the last night
  nightly report [file] [--md]         the newest nightly report, or the one named
  nightly schedule --at 03:00 [--suite F] [--notify] --yes
                                       run "nightly run --only-if-updated" daily (a launchd agent on
                                       macOS; prints the schtasks or cron line elsewhere)
  nightly unschedule --yes             remove the schedule
  nightly status                       the suite, the last reports and the schedule`;

const BENCH_SCRIPT = fileURLToPath(new URL("../../tower-bench.mjs", import.meta.url));

/** @param {Ctx["opt"]} opt */
const opts = (opt) => /** @type {Record<string, any>} */ (opt);
const suiteFile = (ctx) => path.resolve(opts(ctx.opt)["suite"] ?? defaultSuiteFile(ctx.paths));

function printReport(r) {
  out(`nightly ${r.startedAt}: ${r.summary.pass} PASS, ${r.summary.fail} FAIL, ${r.summary.broke} BROKE-BY-UPDATE`);
  if (r.stopped) out(`stopped early: ${r.stopped}`);
  if (r.compare.previous) {
    out(`newly failing: ${r.compare.newlyFailing.join(", ") || "none"}`);
    out(`fixed: ${r.compare.fixed.join(", ") || "none"}`);
  }
  for (const m of r.mods) {
    out(`  ${m.verdict.padEnd(15)} ${m.id ?? m.folder}`);
    for (const why of m.reasons) out(`                  ${why}`);
  }
  if (r.files) out(`report: ${r.files.json}\n        ${r.files.md}\n        ${r.files.html}`);
}

function scheduleLine(s) {
  if (!s.installed) return `schedule: ${s.note ?? "none"}`;
  return `schedule: daily at ${s.at}, ${s.loaded ? "loaded" : "NOT loaded"} (${s.file})`;
}

function reportLine(x) {
  const counts = x.summary ? `${x.summary.pass} pass, ${x.summary.fail} fail, ${x.summary.broke} broke` : "?";
  const newly = x.compare?.newlyFailing ?? [];
  return `  ${x.startedAt}  ${counts}${newly.length ? `; newly failing ${newly.join(", ")}` : ""}`;
}

function printStatus(r) {
  const recipes = r.suite.mods.reduce((n, m) => n + m.recipes, 0);
  out(r.suite.error ? `suite: ${r.suite.error}` : `suite ${r.suite.file}: ${r.suite.mods.length} mod(s), ${recipes} recipe(s)`);
  out(scheduleLine(r.schedule));
  for (const x of r.reports.slice(0, 5)) out(reportLine(x));
  if (!r.reports.length) out("no nightly reports yet");
}

/** @type {Record<string, (ctx: Ctx, rest: string[]) => unknown>} */
const SUBS = {
  init: (ctx, [dir]) => {
    const r = initSuite(ctx.paths, { dir, yes: !!ctx.opt.yes });
    if (ctx.opt.json) return out(r);
    out(`wrote ${r.file} with ${r.mods} mod(s)`);
    for (const f of r.recipes) out(`  recipe ${f}`);
    return out(`edit it to add recipes and options, then: tower-bench nightly run --suite ${r.file}`);
  },
  run: async (ctx) => {
    const o = opts(ctx.opt);
    const suite = loadSuite(suiteFile(ctx));
    const say = (m) => (ctx.opt.json ? undefined : out(`[nightly] ${m}`));
    const d = realDeps(ctx.bench, { log: say });
    try {
      const r = await runNightly(d, { suite, onlyIfUpdated: !!o["only-if-updated"], notify: !!o["notify"] });
      if ("skipped" in r) return ctx.opt.json ? out(r) : out(`[nightly] ${r.why}; nothing to do`);
      if (r.summary.fail || r.summary.broke || r.stopped) process.exitCode = 1;
      return ctx.opt.json ? out(r) : printReport(r);
    } finally {
      d.lab.cdp.close();
    }
  },
  report: (ctx, [file]) => {
    const target = file ?? listReports(ctx.paths)[0]?.file;
    if (!target) throw new BenchError("no nightly reports yet; run: tower-bench nightly run");
    const r = readReport(target);
    if (ctx.opt.json) return out(r);
    return ctx.opt.md ? out(reportMarkdown(r)) : printReport(r);
  },
  schedule: (ctx) => {
    const o = opts(ctx.opt);
    const suite = suiteFile(ctx);
    if (!fs.existsSync(suite)) throw new BenchError(`no suite at ${suite}; "nightly init" writes one`);
    const r = schedule(ctx.paths, { at: o["at"] ?? "03:00", suite, bench: BENCH_SCRIPT, yes: !!ctx.opt.yes,
      notify: !!o["notify"] });
    if (ctx.opt.json) return out(r);
    if (r.line) return out(`not installed on ${r.platform}; add this line yourself:\n${r.line}`);
    if (!r.installed) return out(`${r.xml}\n${r.note}: it would be written to ${r.file}`);
    return out(`scheduled daily at ${r.at}${r.replaced ? " (replaced the previous schedule)" : ""}: ${r.file}\nlog: ${r.log}`);
  },
  unschedule: (ctx) => {
    const r = unschedule({ yes: !!ctx.opt.yes });
    if (ctx.opt.json) return out(r);
    return out(r.removed ? `removed ${r.file}` : r.note);
  },
  status: (ctx) => {
    const r = nightlyStatus(ctx.paths, opts(ctx.opt)["suite"] ? suiteFile(ctx) : undefined);
    return ctx.opt.json ? out(r) : printStatus(r);
  },
};

function suiteSummary(file) {
  try {
    const s = loadSuite(file);
    return { file: s.file, quietMinutes: s.quietMinutes,
      mods: s.mods.map((m) => ({ folder: m.folder, recipes: m.recipes.length, checks: m.checks })) };
  } catch (e) {
    return { file, error: e instanceof Error ? e.message : String(e), mods: [] };
  }
}

/** Suite, last reports and schedule, for status and the UI. Read-only. */
export function nightlyStatus(paths, file) {
  /** @type {any} */
  let sched;
  try { sched = scheduleStatus(paths); } catch (e) {
    sched = { installed: false, note: e instanceof Error ? e.message : String(e) };
  }
  const suite = suiteSummary(file ?? sched.suite ?? defaultSuiteFile(paths));
  return { suite, reports: listReports(paths).slice(0, 14), schedule: sched };
}

/** @type {Record<string, import("./common.mjs").Handler>} */
export const NIGHTLY_COMMANDS = {
  nightly: (ctx, [sub, ...rest]) => {
    if (!sub) return SUBS.status(ctx, rest);
    if (!Object.hasOwn(SUBS, sub)) throw new BenchError(`unknown nightly command "${sub}"; try init, run, report, schedule, unschedule or status`);
    return SUBS[sub](ctx, rest);
  },
};

export const NIGHTLY_ROUTES = {
  "GET /api/nightly": (bench) => nightlyStatus(bench.paths),
  "GET /api/nightly/report": (bench, _req, q) => {
    // Only a report the bench wrote can be read, never an arbitrary path.
    const known = listReports(bench.paths);
    const want = q.get("file");
    const hit = want ? known.find((r) => r.file === want) : known[0];
    if (!hit) throw new BenchError(want ? "not a nightly report" : "no nightly reports yet", 404);
    return readReport(hit.file);
  },
};
