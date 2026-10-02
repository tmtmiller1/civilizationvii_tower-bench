// The overnight regression run: notice a game update, index it, list what it breaks, then check every mod in
// the suite from files and in seeded lab games, and leave one report for the morning. Everything that
// touches the machine comes in through `d` (see nightly-deps.mjs), so tests drive the whole night with fakes.
import { BenchError } from "./bench.mjs";
import { compareReports, finishMod, summarise } from "./nightly-report.mjs";

export const REPORT_FORMAT = "tower-bench/nightly-report";

const messageOf = (e) => (e instanceof Error ? e.message : String(e));

/**
 * @typedef {{ folder: string, recipes: string[], seed: number, age: string | null, turns: number,
 *   checks: string[] }} SuiteMod
 * @typedef {{ file: string, name: string | null, quietMinutes: number, mods: SuiteMod[] }} Suite
 */

/** Whether tonight has anything to do with --only-if-updated: a new version, or no index to compare with yet. */
export function updateWanted(v) {
  if (!v) return { run: false, why: "the installed game version cannot be read here" };
  if (v.changed) return { run: true, why: `the game updated (${v.newest} -> ${v.installed})` };
  if (!v.newest) return { run: true, why: `no game index yet; indexing ${v.installed} as the baseline` };
  return { run: false, why: `game ${v.installed} is unchanged since the last index` };
}

/** Refuses to start while someone may be playing or another runner owns the game. */
export function checkSafety(d, suite) {
  const s = d.safety({ quietMinutes: suite.quietMinutes });
  for (const w of s.warnings) d.log(`warning: ${w}`);
  if (s.problems.length) throw new BenchError(`nightly not started: ${s.problems.join("; ")}`);
  return s.warnings;
}

const diffSummary = (x) => ({
  from: x.from, to: x.to,
  files: { moved: x.files.moved.length, removed: x.files.removed.length, added: x.files.added.length,
    changed: x.files.changed.length },
  exportsLost: x.exports.filter((e) => e.removed.length).map((e) => `${e.file}: ${e.removed.join(", ")}`).slice(0, 20),
  componentsRemoved: [...x.components.legacy.removed, ...x.components.registry.removed].slice(0, 20),
  schema: x.schema.available
    ? { tablesRemoved: x.schema.tablesRemoved.length, columnsRemoved: x.schema.columnsRemoved.length,
      nowRequired: x.schema.nowRequired.length }
    : { note: x.schema.note },
});

/** Makes sure the Debug database describes this install, refreshing it with one lab game when it does not. */
async function freshDebug(d, game) {
  if (d.debugFresh()) return;
  d.log("the Debug database predates this install; running one lab game to refresh it");
  try {
    const r = await d.labGame({ recipe: null, seed: null, age: null, turns: 0, label: "refresh-debug" });
    game.debugRefreshed = { error: r.error ?? null, crashReports: r.crashReports };
  } catch (e) {
    game.debugRefreshed = { error: messageOf(e), crashReports: [] };
    throw e;
  }
  if (!d.debugFresh()) game.debugNote = "the Debug database is still older than the install; the index has no schema";
}

/** Snapshot, diff and impact for a new version. Each failure is recorded, not thrown, except a lab failure. */
async function updatePhase(d, suite, v, game) {
  await freshDebug(d, game);
  try {
    const s = d.snapshot(v.installed);
    game.snapshot = { version: s.version, file: s.file, schemaNote: s.schemaNote ?? null };
  } catch (e) { game.snapshot = { error: messageOf(e) }; }
  if (!v.newest || v.newest === v.installed) return null;
  try { game.diff = diffSummary(d.diff(v.newest, v.installed)); } catch (e) { game.diff = { error: messageOf(e) }; }
  try {
    const r = d.impact(v.newest, v.installed, suite.mods.map((m) => m.folder));
    game.impact = { checked: r.checked, affected: r.affected, failed: r.failed, schemaNote: r.schemaNote };
    return new Map(r.mods.map((m) => [m.folder, m.findings]));
  } catch (e) {
    game.impact = { error: messageOf(e) };
    return null;
  }
}

const brief = (f) => ({ severity: f.severity, verdict: f.verdict, rule: f.rule, text: f.text, fix: f.fix });

/** The file checks for one mod: pre-flight and localization. */
async function staticPhase(d, m, entry) {
  if (m.checks.includes("check")) {
    try {
      const r = await d.check(m.folder);
      entry.id = r.id ?? entry.id;
      entry.check = { verdict: r.verdict, defects: r.defects.slice(0, 10).map(brief),
        highConflicts: r.conflicts.filter((c) => c.severity === "High").length };
    } catch (e) { entry.check = { error: messageOf(e) }; }
  }
  if (m.checks.includes("l10n")) {
    try {
      const r = await d.l10n(m.folder);
      const errors = r.findings.filter((f) => f.severity === "error");
      entry.l10n = { errors: errors.length, warnings: r.findings.filter((f) => f.severity === "warn").length,
        top: errors.slice(0, 5).map(brief) };
    } catch (e) { entry.l10n = { error: messageOf(e) }; }
  }
}

const failedStep = (results) => results?.find((x) => !x.ok) ?? null;

/** Runs `fn`, turning a throw into { error } evidence. */
const attempt = (fn) => { try { return fn(); } catch (e) { return { error: messageOf(e) }; } };

function runRecord(file, recipe, r) {
  const step = failedStep(r.results);
  return { recipe: file, name: recipe.name ?? null, passed: !!r.passed && !r.error && !r.crashReports.length,
    error: r.error ?? null, failedStep: step ? { step: step.step, kind: step.kind, detail: step.detail } : null,
    crashReports: r.crashReports, crash: null, logs: null };
}

/** One recipe in one seeded lab game, then the logs that game wrote about the mod, and a crash triage if it died. */
async function recipeRun(d, m, file) {
  const read = d.readRecipe(file);
  if (read.error) return { recipe: file, passed: false, error: read.error };
  const { recipe } = read;
  const r = await d.labGame({ recipe, seed: recipe.seed ?? m.seed, age: recipe.age ?? m.age, turns: m.turns,
    label: recipe.name ?? file });
  /** @type {any} */
  const run = runRecord(file, recipe, r);
  if (r.crashReports.length) run.crash = attempt(() => d.crashTriage(r.crashReports[0]));
  if (m.checks.includes("logs")) run.logs = attempt(() => d.modLogs(m.folder));
  return run;
}

/** Every recipe of every mod; stops the remaining games when the game turns up running or a restore fails. */
async function dynamicPhase(d, suite, entries) {
  for (const [i, m] of suite.mods.entries()) {
    if (!m.checks.includes("recipes")) continue;
    for (const file of m.recipes) {
      if (d.gameRunning()) return "the game was started during the run; the remaining lab games were skipped";
      d.log(`${entries[i].id ?? m.folder}: ${file}`);
      try {
        entries[i].runs.push(await recipeRun(d, m, file));
      } catch (e) {
        entries[i].runs.push({ recipe: file, passed: false, error: messageOf(e) });
        return `a lab game could not finish cleanly (${messageOf(e)}); the remaining games were skipped`;
      }
    }
  }
  return null;
}

function newEntries(d, suite) {
  return suite.mods.map((m) => ({ id: d.identify(m.folder), folder: m.folder, verdict: "PASS", reasons: [],
    check: null, l10n: null, impact: [], runs: [], notRun: [] }));
}

/** Update phase (when wanted), file checks, then the lab games. Returns why the night stopped early, or null. */
async function checkAll(d, suite, v, game, entries) {
  let stopped = null;
  let impact = null;
  if (game.updated) {
    try { impact = await updatePhase(d, suite, v, game); } catch (e) {
      stopped = `refreshing the Debug database failed: ${messageOf(e)}`;
    }
  }
  for (const [i, m] of suite.mods.entries()) {
    if (m.checks.includes("impact")) entries[i].impact = impact?.get(m.folder) ?? [];
    await staticPhase(d, m, entries[i]);
  }
  stopped ??= await dynamicPhase(d, suite, entries);
  // A recipe the night never reached is not a pass: it is listed, and keeps the mod out of "fixed".
  suite.mods.forEach((m, i) => {
    if (m.checks.includes("recipes")) entries[i].notRun = m.recipes.filter((f) => !entries[i].runs.some((r) => r.recipe === f));
  });
  return stopped;
}

/** Verdicts, comparison with the previous night, the files, the evidence entry and the optional notification. */
async function finish(d, report, { onlyIfUpdated, notify }) {
  const previous = d.previousReport();
  const updated = report.game.updated || (!!previous && previous.game?.installed !== report.game.installed);
  for (const e of report.mods) finishMod(e, previous, updated);
  report.summary = summarise(report.mods);
  report.compare = compareReports(previous, report.mods);
  report.files = d.writeReport(report);
  const n = report.compare.newlyFailing;
  d.benchLog({ kind: "nightly", request: { suite: report.suite, onlyIfUpdated }, result: { summary: report.summary,
    newlyFailing: n, fixed: report.compare.fixed, stopped: report.stopped, file: report.files.json } });
  if (notify && n.length) {
    await d.notify("Tower Bench nightly", `${n.length} mod(s) newly failing: ${n.slice(0, 3).join(", ")}${n.length > 3 ? "..." : ""}`);
  }
  return report;
}

/**
 * One night. Returns { skipped, why } when --only-if-updated finds nothing new; otherwise the report, written.
 * @param {any} d @param {{ suite: Suite, onlyIfUpdated?: boolean, notify?: boolean }} o
 */
export async function runNightly(d, { suite, onlyIfUpdated = false, notify = false }) {
  const v = d.versionChanged();
  const want = updateWanted(v);
  if (onlyIfUpdated && !want.run) return { skipped: true, why: want.why };
  const warnings = checkSafety(d, suite);
  const started = d.now();
  const game = { installed: v?.installed ?? null, previous: v?.newest ?? null, updated: !!v && want.run,
    why: want.why, snapshot: null, debugRefreshed: null, debugNote: null, diff: null, impact: null };
  const entries = newEntries(d, suite);
  const stopped = await checkAll(d, suite, v, game, entries);
  /** @type {any} */
  const report = { format: REPORT_FORMAT, formatVersion: 1, startedAt: started.toISOString(),
    finishedAt: d.now().toISOString(), suite: suite.file, game, warnings, stopped, mods: entries };
  return finish(d, report, { onlyIfUpdated, notify });
}
