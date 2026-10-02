// Turns either route's raw counts into one shape, per file: every function and branch block with how often
// it ran. The CDP route maps V8 precise coverage (byte ranges with counts) onto the sites the instrumenter's
// finder reads from the file the game served; the instrumentation route reads the counters it inserted.
import { findSites } from "./instrument.mjs";

/**
 * @typedef {{ startOffset: number, endOffset: number, count: number }} CoverageRange
 * @typedef {{ functionName: string, ranges: CoverageRange[], isBlockCoverage: boolean }} FunctionCoverage
 * @typedef {{ scriptId: string, url: string, functions: FunctionCoverage[] }} ScriptCoverage
 * @typedef {{ name: string, kind: string, line: number, col: number, count: number }} FnHit
 * @typedef {{ kind: string, line: number, col: number, count: number }} BlockHit
 * @typedef {{ rel: string, functions: FnHit[], blocks: BlockHit[], ran?: boolean | null, note?: string }} FileCoverage
 * @typedef {{ route: "cdp" | "instrument", modId: string, at: string, page?: string | null,
 *   files: FileCoverage[], notes: string[] }} Coverage
 */

const span = (r) => r.endOffset - r.startOffset;
const contains = (r, at) => r.startOffset <= at && at < r.endOffset;

/** The smallest of `ranges` that holds `at`, or null. */
function innermost(ranges, at) {
  let best = null;
  for (const r of ranges) if (contains(r, at) && (!best || span(r) < span(best))) best = r;
  return best;
}

/**
 * A function's own V8 entry starts between its first token (or, for a constructor, its class) and its
 * opening brace. A function V8 does not report was never compiled, so it never ran.
 * @param {import("./instrument.mjs").Site} site @param {CoverageRange[]} fnRanges
 */
function functionCount(site, fnRanges) {
  const low = site.outer ?? site.head;
  let best = null;
  for (const r of fnRanges) {
    if (r.startOffset < low || r.startOffset > site.body || !contains(r, site.body)) continue;
    if (!best || span(r) < span(best)) best = r;
  }
  return best ? best.count : 0;
}

/** The innermost function site around a block, by the ends the finder recorded. */
function enclosing(fns, block) {
  let best = null;
  for (const f of fns) {
    if (f.site.body < block.body && (f.site.end ?? Infinity) > block.body
      && (!best || f.site.body > best.site.body)) best = f;
  }
  return best;
}

/**
 * Maps one script's V8 coverage onto the sites of the text the game served.
 * @param {string} rel @param {string} text @param {ScriptCoverage | null} script
 * @returns {FileCoverage}
 */
export function mapScript(rel, text, script) {
  // V8's offsets count from after a byte-order mark.
  const found = findSites(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (found.error) return { rel, functions: [], blocks: [], ran: null, note: `could not read: ${found.error}` };
  const fnsV8 = script?.functions ?? [];
  const fnRanges = fnsV8.map((f) => f.ranges[0]).filter(Boolean);
  const all = fnsV8.flatMap((f) => f.ranges);
  const top = fnsV8.find((f) => f.ranges[0]?.startOffset === 0 && f.functionName === "");
  const fns = found.sites.filter((s) => s.k === "f").map((site) => ({ site, count: functionCount(site, fnRanges) }));
  const blocks = found.sites.filter((s) => s.k === "b").map((site) => {
    const owner = enclosing(fns, site);
    const r = owner && owner.count === 0 ? null : innermost(all, site.body + 1);
    return { kind: site.kind, line: site.line, col: site.col, count: r ? r.count : 0 };
  });
  return {
    rel,
    functions: fns.map(({ site, count }) => ({
      name: site.name, kind: site.kind, line: site.line, col: site.col, count,
    })),
    blocks,
    ran: script ? (top ? top.ranges[0].count > 0 : true) : false,
  };
}

/**
 * The mod-relative path of a script the game loaded from `fs://game/<mod>/<rel>`, when <mod> is one of
 * `roots` (the mod id or its folder name, compared case-insensitively).
 * @param {string} url @param {string[]} roots
 */
export function scriptRel(url, roots) {
  const m = /^fs:\/\/game\/([^/]+)\/([^?#]+)/i.exec(String(url ?? ""));
  if (!m) return null;
  const want = roots.map((r) => r.toLowerCase());
  return want.includes(decodeURIComponent(m[1]).toLowerCase()) ? decodeURIComponent(m[2]) : null;
}

/**
 * V8 coverage for a whole page, narrowed to one mod's files.
 * @param {ScriptCoverage[]} scripts
 * @param {{ modId: string, roots: string[], files: { rel: string, text: string | null }[] }} mod
 * @returns {Coverage}
 */
export function mapCdp(scripts, { modId, roots, files }) {
  /** @type {Map<string, ScriptCoverage>} */
  const byRel = new Map();
  for (const s of scripts) {
    const rel = scriptRel(s.url, roots);
    if (rel) byRel.set(rel.toLowerCase(), s);
  }
  const notes = [];
  const out = files.map((f) => {
    const script = byRel.get(f.rel.toLowerCase()) ?? null;
    if (f.text === null) return { rel: f.rel, functions: [], blocks: [], ran: null, note: "no live copy to read" };
    return mapScript(f.rel, f.text, script);
  });
  const known = new Set(files.map((f) => f.rel.toLowerCase()));
  const extra = [...byRel.keys()].filter((k) => !known.has(k));
  if (extra.length) notes.push(`the page also ran ${extra.length} script(s) of this mod not in its file list: ${extra.join(", ")}`);
  if (!byRel.size) notes.push("no script of this mod was in the coverage: it never loaded, or its URLs are not fs://game/<mod>/...");
  return { route: "cdp", modId, at: new Date().toISOString(), files: out, notes };
}

/**
 * The instrumentation route: the counters' values, against the table written at instrument time.
 * @param {{ modId: string, files: { rel: string, fileId: number, table: { k: string, kind: string, name: string,
 *   line: number, col: number }[], skipped?: string | null }[] }} saved
 * @param {Record<string, { c?: Record<string, number> }>} counts by file id, as the page holds them
 * @returns {Coverage}
 */
export function mapInstrumented(saved, counts) {
  const files = saved.files.map((f) => {
    const entry = counts[String(f.fileId)];
    const c = entry?.c ?? {};
    const sites = f.table.map((s, n) => ({ ...s, count: c[n] ?? 0 }));
    /** @type {FileCoverage} */
    const out = {
      rel: f.rel,
      functions: sites.filter((s) => s.k === "f")
        .map((s) => ({ name: s.name, kind: s.kind, line: s.line, col: s.col, count: s.count })),
      blocks: sites.filter((s) => s.k === "b").map((s) => ({ kind: s.kind, line: s.line, col: s.col, count: s.count })),
      ran: entry ? true : f.skipped ? null : false,
    };
    if (f.skipped) out.note = f.skipped;
    return out;
  });
  const notes = files.some((f) => f.ran === false)
    ? ["a file that never registered never loaded on this page, or its live copy is not the counting one"] : [];
  return { route: "instrument", modId: saved.modId, at: new Date().toISOString(), files, notes };
}

/**
 * Counter lines a __tbCovDump() wrote to UI.log; the newest dump wins.
 * @param {string} text
 * @returns {{ dump: string | null, counts: Record<string, { c: Record<string, number> }> }}
 */
export function parseCoverageLog(text) {
  const rows = [...String(text).matchAll(/\[TB-COVERAGE\] d=(\w+) f=(\d+) ?([\d:,]*)/g)];
  if (!rows.length) return { dump: null, counts: {} };
  const dump = rows.reduce((a, m) => (parseInt(m[1], 36) >= parseInt(a, 36) ? m[1] : a), rows[0][1]);
  /** @type {Record<string, { c: Record<string, number> }>} */
  const counts = {};
  for (const m of rows.filter((r) => r[1] === dump)) {
    const entry = (counts[m[2]] ??= { c: {} });
    for (const pair of m[3].split(",").filter(Boolean)) {
      const [s, n] = pair.split(":");
      entry.c[s] = Number(n);
    }
  }
  return { dump, counts };
}

/** @param {FileCoverage} f */
export function fileSummary(f) {
  const hit = (xs) => xs.filter((x) => x.count > 0).length;
  return {
    rel: f.rel, ran: f.ran ?? null, note: f.note ?? null,
    functions: { hit: hit(f.functions), total: f.functions.length },
    blocks: { hit: hit(f.blocks), total: f.blocks.length },
    uncovered: f.functions.filter((x) => x.count === 0).map((x) => ({ name: x.name, line: x.line })),
  };
}

/**
 * Per file and in total: functions and blocks hit of total, and every function that never ran.
 * @param {Coverage} cov
 */
export function summarize(cov) {
  const files = cov.files.map(fileSummary);
  const sum = (k, which) => files.reduce((n, f) => n + f[which][k], 0);
  return {
    route: cov.route, modId: cov.modId, at: cov.at, page: cov.page ?? null, notes: cov.notes, files,
    total: {
      functions: { hit: sum("hit", "functions"), total: sum("total", "functions") },
      blocks: { hit: sum("hit", "blocks"), total: sum("total", "blocks") },
    },
    neverRan: files.flatMap((f) => f.uncovered.map((u) => ({ rel: f.rel, ...u }))),
    filesNeverLoaded: files.filter((f) => f.ran === false).map((f) => f.rel),
  };
}

const pct = (h) => (h.total ? `${Math.round((100 * h.hit) / h.total)}%` : "-");
const frac = (h) => `${h.hit}/${h.total} (${pct(h)})`;

/** @param {ReturnType<typeof summarize>} s */
function textReport(s) {
  const lines = [`${s.modId}: coverage by ${s.route === "cdp" ? "V8 precise coverage (CDP)" : "counting copies"}, read ${s.at}`,
    `  functions ${frac(s.total.functions)}, blocks ${frac(s.total.blocks)}`];
  for (const n of s.notes) lines.push(`  note: ${n}`);
  for (const f of s.files) {
    const state = f.ran === false ? "  NEVER LOADED" : "";
    lines.push(`  ${f.rel.padEnd(48)} functions ${frac(f.functions).padEnd(14)} blocks ${frac(f.blocks)}${state}`);
    if (f.note) lines.push(`      ${f.note}`);
  }
  if (s.neverRan.length) lines.push(`\nnever ran (${s.neverRan.length}):`);
  for (const u of s.neverRan) lines.push(`  ${u.rel}:${u.line}  ${u.name}`);
  return lines.join("\n");
}

/** @param {ReturnType<typeof summarize>} s */
function mdReport(s) {
  const lines = [`# Coverage: ${s.modId}`, "",
    `Read ${s.at} by ${s.route === "cdp" ? "V8 precise coverage over CDP" : "counting copies of the mod's JS"}. `
    + `Functions ${frac(s.total.functions)}, blocks ${frac(s.total.blocks)}.`, ""];
  for (const n of s.notes) lines.push(`- ${n}`);
  lines.push("", "| File | Functions | Blocks | Loaded |", "| --- | --- | --- | --- |");
  for (const f of s.files) {
    lines.push(`| ${f.rel} | ${frac(f.functions)} | ${frac(f.blocks)} | ${f.ran === false ? "no" : f.ran ? "yes" : "?"} |`);
  }
  lines.push("", "## Never ran", "");
  if (!s.neverRan.length) lines.push("Every function ran at least once.");
  for (const u of s.neverRan) lines.push(`- \`${u.rel}:${u.line}\` ${u.name}`);
  return lines.join("\n") + "\n";
}

/** @param {Coverage} cov @param {{ md?: boolean }} [opts] */
export function formatReport(cov, { md = false } = {}) {
  const s = summarize(cov);
  return md ? mdReport(s) : textReport(s);
}
