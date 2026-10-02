// Verdicts, the comparison with the previous night, and the report files (JSON, Markdown, HTML).
import fs from "node:fs";
import path from "node:path";
import { nightlyDir } from "./nightly-suite.mjs";

export const VERDICTS = ["BROKE-BY-UPDATE", "FAIL", "PASS"];

const keyOf = (m) => m.id ?? m.folder;

function staticReasons(e) {
  const out = [];
  if (e.check?.verdict === "BLOCKS GAME") out.push(`pre-flight: ${e.check.defects[0]?.text ?? "blocks the game"}`);
  if (e.l10n?.errors) out.push(`localization: ${e.l10n.errors} error(s), first: ${e.l10n.top[0]?.text ?? "?"}`);
  const high = e.impact.filter((f) => f.severity === "High");
  if (high.length) out.push(`update impact: ${high.length} High finding(s), first: ${high[0].text}`);
  return out;
}

function runOutcome(r) {
  if (r.crashReports?.length) return `the game crashed (${path.basename(r.crashReports[0])})`;
  if (r.error) return r.error;
  return r.failedStep ? `step ${r.failedStep.step} failed: ${r.failedStep.detail}` : null;
}

function runReasons(r) {
  const label = r.name ?? r.recipe;
  const out = [];
  const outcome = runOutcome(r);
  if (outcome) out.push(`${label}: ${outcome}`);
  const errors = r.logs?.errors ?? [];
  if (errors.length) out.push(`${label}: ${errors.length} error line(s) about the mod, first: ${errors[0].text}`);
  return out;
}

const COULD_NOT = "could not run";

function checkErrors(e) {
  return [e.check?.error && `pre-flight ${COULD_NOT}: ${e.check.error}`,
    e.l10n?.error && `localization check ${COULD_NOT}: ${e.l10n.error}`].filter((x) => !!x);
}

/** Why a mod failed tonight, one line per reason; empty when it passed. */
export function reasonsOf(e) {
  return [...checkErrors(e), ...staticReasons(e), ...e.runs.flatMap(runReasons)];
}

/** The previous night's entry for a mod: same id, else same folder. */
const previousEntry = (previous, e) => previous?.mods
  ?.find((m) => (e.id && m.id === e.id) || (e.folder && m.folder === e.folder)) ?? null;

/**
 * Sets the verdict. A failure counts as broken by the update when the game version changed since the previous
 * report and either the mod passed then or the update impact names a High finding in it.
 */
export function finishMod(e, previous, updated) {
  e.reasons = reasonsOf(e);
  if (!e.reasons.length) {
    e.verdict = "PASS";
    return e;
  }
  const before = previousEntry(previous, e)?.verdict ?? null;
  const highImpact = e.impact.some((f) => f.severity === "High");
  // A check that could not run (a folder gone, say) is a failure, but not evidence against the update.
  const real = e.reasons.some((r) => !r.includes(COULD_NOT));
  e.verdict = updated && real && (before === "PASS" || highImpact) ? "BROKE-BY-UPDATE" : "FAIL";
  return e;
}

export function summarise(entries) {
  const count = (v) => entries.filter((e) => e.verdict === v).length;
  return { mods: entries.length, pass: count("PASS"), fail: count("FAIL"), broke: count("BROKE-BY-UPDATE") };
}

/** Mods failing tonight that passed in the previous report, and the reverse. Matched by id, else folder. */
export function compareReports(previous, entries) {
  if (!previous) return { previous: null, newlyFailing: [], fixed: [], stillFailing: [] };
  const failing = (v) => !!v && v !== "PASS";
  const pairs = entries.map((e) => ({ e, was: previousEntry(previous, e)?.verdict ?? null })).filter((p) => p.was);
  const pick = (test) => pairs.filter((p) => test(p.was, p.e.verdict, p.e)).map((p) => keyOf(p.e));
  return {
    previous: previous.files?.json ?? previous.startedAt ?? null,
    newlyFailing: pick((a, b) => a === "PASS" && failing(b)),
    // A mod whose recipes the night never reached is not fixed, only unchecked.
    fixed: pick((a, b, e) => failing(a) && b === "PASS" && !e.notRun?.length),
    stillFailing: pick((a, b) => failing(a) && failing(b)),
  };
}

// ---- files ---------------------------------------------------------------------------------------------

const localDate = (d) => {
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
};

/** Reports on file, newest first: { file, startedAt }. */
export function listReports(paths) {
  const dir = nightlyDir(paths);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}(-\d+)?\.json$/.test(n)); } catch { return []; }
  return names.map((n) => {
    const file = path.join(dir, n);
    try {
      const r = JSON.parse(fs.readFileSync(file, "utf8"));
      return { file, startedAt: r.startedAt ?? "", summary: r.summary ?? null, compare: r.compare ?? null,
        game: r.game ? { installed: r.game.installed, previous: r.game.previous, updated: r.game.updated } : null,
        stopped: r.stopped ?? null };
    } catch { return { file, startedAt: "", summary: null, compare: null, game: null, stopped: "unreadable" }; }
  }).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function readReport(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** The newest readable report, or null. */
export function latestReport(paths) {
  for (const r of listReports(paths)) {
    try { return readReport(r.file); } catch { /* try the next */ }
  }
  return null;
}

/** <date>.json, or <date>-2.json and up when tonight already has one, so no night overwrites another. */
export function reportBase(paths, when) {
  const dir = nightlyDir(paths);
  const date = localDate(when);
  for (let n = 1; ; n++) {
    const base = path.join(dir, n === 1 ? date : `${date}-${n}`);
    if (!fs.existsSync(`${base}.json`)) return base;
  }
}

/** Writes the report as JSON, Markdown and HTML; returns the three paths. */
export function writeReportFiles(paths, report, when = new Date(report.startedAt)) {
  fs.mkdirSync(nightlyDir(paths), { recursive: true });
  const base = reportBase(paths, when);
  const files = { json: `${base}.json`, md: `${base}.md`, html: `${base}.html` };
  fs.writeFileSync(files.json, JSON.stringify({ ...report, files }, null, 2));
  fs.writeFileSync(files.md, reportMarkdown({ ...report, files }));
  fs.writeFileSync(files.html, reportHtml({ ...report, files }));
  return files;
}

// ---- text ----------------------------------------------------------------------------------------------

function snapshotLine(g) {
  if (g.snapshot?.error) return `Snapshot failed: ${g.snapshot.error}`;
  if (!g.snapshot) return null;
  return `Indexed ${g.snapshot.version}${g.snapshot.schemaNote ? ` without schema (${g.snapshot.schemaNote})` : ""}.`;
}

function diffLine(g) {
  if (g.diff?.error) return `Diff failed: ${g.diff.error}`;
  if (!g.diff?.files) return null;
  const f = g.diff.files;
  return `Diff: ${f.changed} files changed, ${f.added} added, ${f.removed} removed, ${f.moved} moved; `
    + `${g.diff.exportsLost.length} module(s) lost exports; ${g.diff.componentsRemoved.length} component(s) removed.`;
}

function impactLine(g) {
  if (g.impact?.error) return `Impact failed: ${g.impact.error}`;
  return g.impact ? `Impact: ${g.impact.affected} of ${g.impact.checked} mod(s) affected.` : null;
}

function refreshLine(g) {
  if (!g.debugRefreshed) return null;
  return `Debug database refreshed with one lab game${g.debugRefreshed.error ? ` (${g.debugRefreshed.error})` : ""}.`;
}

/** @returns {string[]} */
function gameLines(g) {
  const head = g.updated ? `Game ${g.previous ?? "(no index)"} -> ${g.installed}: ${g.why}.`
    : `Game ${g.installed ?? "unknown"}: ${g.why}.`;
  return [head, refreshLine(g), g.debugNote, snapshotLine(g), diffLine(g), impactLine(g)].filter((x) => !!x);
}

const listLine = (label, ids) => (ids.length ? `${label}: ${ids.join(", ")}` : `${label}: none`);

function compareLines(c) {
  if (!c.previous) return ["No previous report to compare with.", ""];
  return [listLine("Newly failing", c.newlyFailing), "", listLine("Fixed", c.fixed), ""];
}

function runSection(run) {
  const lines = [`- recipe ${run.name ?? run.recipe}: ${run.passed ? "passed" : "failed"}`];
  const sig = run.crash?.crash?.signature;
  if (sig) lines.push(`  - crash signature ${sig}; next: ${run.crash.next ?? "bisect"}`);
  return lines;
}

function modSection(m) {
  const lines = [`## ${m.verdict} ${m.id ?? m.folder}`, "", `Folder: ${m.folder}`, ""];
  for (const why of m.reasons) lines.push(`- ${why}`);
  if (m.notRun?.length) lines.push(`- ${m.notRun.length} recipe(s) not run tonight: ${m.notRun.join(", ")}`);
  return [...lines, ...m.runs.flatMap(runSection), ""];
}

/** The report as Markdown, for a terminal, a file viewer or a paste. */
export function reportMarkdown(r) {
  const s = r.summary;
  const lines = [`# Nightly ${r.startedAt.slice(0, 10)}`, "",
    `${s.mods} mod(s): ${s.pass} PASS, ${s.fail} FAIL, ${s.broke} BROKE-BY-UPDATE.`, "", ...gameLines(r.game), "",
    ...(r.stopped ? [`Stopped early: ${r.stopped}`, ""] : []), ...compareLines(r.compare), ...r.mods.flatMap(modSection),
    "Read from files and lab games; each lab game restored the saves, settings and mod registry it touched."];
  return `${lines.join("\n")}\n`;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** A self-contained HTML page of the same report. */
export function reportHtml(r) {
  const row = (m) => `<tr><td class="${m.verdict === "PASS" ? "ok" : "bad"}">${esc(m.verdict)}</td><td>${esc(m.id ?? "")}</td>`
    + `<td>${[...m.reasons, ...(m.notRun?.length ? [`${m.notRun.length} recipe(s) not run tonight`] : [])]
      .map((x) => `<div>${esc(x)}</div>`).join("") || "&nbsp;"}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Nightly ${esc(r.startedAt.slice(0, 10))}</title><style>
:root{--fg:#1d1d1f;--bg:#fff;--bad:#b3261e;--ok:#1e6b34;--line:#ddd}
@media (prefers-color-scheme:dark){:root{--fg:#e8e8e8;--bg:#161616;--bad:#ff8a80;--ok:#7bd88f;--line:#333}}
body{font:14px/1.45 system-ui,sans-serif;color:var(--fg);background:var(--bg);margin:0 auto;max-width:960px;padding:16px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px;text-align:left;vertical-align:top}
.bad{color:var(--bad);font-weight:600}.ok{color:var(--ok);font-weight:600}
</style></head><body><h1>Nightly ${esc(r.startedAt.slice(0, 10))}</h1>
<p>${esc(`${r.summary.pass} PASS, ${r.summary.fail} FAIL, ${r.summary.broke} BROKE-BY-UPDATE`)}</p>
${gameLines(r.game).map((l) => `<p>${esc(l)}</p>`).join("\n")}
${r.stopped ? `<p class="bad">Stopped early: ${esc(r.stopped)}</p>` : ""}
<p>${esc(listLine("Newly failing", r.compare.newlyFailing))}<br>${esc(listLine("Fixed", r.compare.fixed))}</p>
<table><thead><tr><th>Verdict</th><th>Mod</th><th>Evidence</th></tr></thead><tbody>
${r.mods.map(row).join("\n")}
</tbody></table></body></html>
`;
}
