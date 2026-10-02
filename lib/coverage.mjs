// Code coverage for a mod, instrumentation route: counting copies of the mod's JS written into the copy the
// game loads (never the source, never a Workshop copy), proved served like a deploy, read back over CDP or
// from UI.log, and replaced by the plain source on restore. Reads from either route are saved here and
// reported by coverage-map.mjs.
import fs from "node:fs";
import path from "node:path";
import { BenchError } from "./bench.mjs";
import { fnv1a, readModinfo } from "./deploy.mjs";
import * as engine from "./engine.mjs";
import { coverageDump, coverageRead, coverageReset } from "./engine-coverage.mjs";
import { PROLOGUE_END, fileIdOf, instrumentChecked } from "./instrument.mjs";
import { importsOf, stripJsComments } from "./static/jsscan.mjs";
import { mapInstrumented, parseCoverageLog, summarize } from "./coverage-map.mjs";

/** @typedef {import("./coverage-map.mjs").Coverage} Coverage */

export const coverageDir = (paths) => path.join(path.dirname(paths.evidence), "coverage");
const tablesDir = (paths) => path.join(coverageDir(paths), "tables");
const readsDir = (paths) => path.join(coverageDir(paths), "reads");
const safe = (s) => String(s).replace(/[^\w.-]+/g, "_");
const readText = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };

function resolveImport(srcDir, from, spec, modId) {
  const s = spec.replace(/^fs:\/\/game/, "");
  let target = null;
  if (s.startsWith(".")) target = path.join(path.dirname(from), s);
  else if (s.toLowerCase().startsWith(`/${modId.toLowerCase()}/`)) target = path.join(srcDir, s.slice(modId.length + 2));
  if (!target) return null;
  const rel = path.relative(srcDir, target);
  return rel.startsWith("..") || path.isAbsolute(rel) ? null : rel.split(path.sep).join("/");
}

/**
 * The mod's JavaScript: every .js its modinfo declares, and every file inside the folder those import.
 * @param {string} srcDir
 */
export function modJsFiles(srcDir) {
  const info = readModinfo(srcDir);
  const todo = info.items.filter((rel) => /\.js$/i.test(rel));
  const seen = new Set();
  while (todo.length) {
    const rel = /** @type {string} */ (todo.pop());
    const text = readText(path.join(srcDir, rel));
    if (seen.has(rel) || text === null) continue;
    seen.add(rel);
    const full = path.join(srcDir, rel);
    for (const site of importsOf(stripJsComments(text), full)) {
      const r = resolveImport(srcDir, full, site.spec, info.id);
      if (r && !seen.has(r)) todo.push(r);
    }
  }
  return { modId: info.id, files: [...seen].sort() };
}

function planFor(bench, dir) {
  const plan = bench.planFor(dir);
  if (plan.refuse) throw new BenchError(plan.refuse, 409);
  if (plan.inPlace) {
    throw new BenchError("the game loads this folder itself, so a counting copy would overwrite your source. "
      + "Instrument from a separate source folder, or use the CDP route (coverage cdp), which changes no file.", 409);
  }
  return /** @type {typeof plan & { liveDir: string }} */ (plan);
}

/** What instrumenting would write: each file's counting copy and its site table. */
export function planInstrument(bench, dir) {
  const plan = planFor(bench, dir);
  const used = new Set();
  const files = modJsFiles(plan.srcDir).files.map((rel) => {
    const src = /** @type {string} */ (readText(path.join(plan.srcDir, rel)));
    if (src.includes(PROLOGUE_END)) {
      return { rel, fileId: 0, code: src, table: [], skipped: "the source already holds counting code" };
    }
    let fileId = fileIdOf(plan.modId, rel);
    while (used.has(fileId)) fileId++;
    used.add(fileId);
    const r = instrumentChecked(src, { fileId, modId: plan.modId, rel });
    return { rel, fileId, code: r.code, table: r.table, skipped: r.skipped };
  });
  return { plan, files };
}

const countOf = (table, k) => table.filter((s) => s.k === k).length;
const fileRow = (f) => ({
  rel: f.rel, functions: countOf(f.table, "f"), blocks: countOf(f.table, "b"), skipped: f.skipped ?? null,
});

function saveTable(paths, plan, files) {
  fs.mkdirSync(tablesDir(paths), { recursive: true });
  const file = path.join(tablesDir(paths), `${safe(plan.modId)}.json`);
  const saved = {
    modId: plan.modId, srcDir: plan.srcDir, liveDir: plan.liveDir, at: new Date().toISOString(), restored: null,
    files: files.map((f) => ({
      rel: f.rel, fileId: f.fileId, hash: fnv1a(f.code), table: f.table, skipped: f.skipped ?? null,
    })),
  };
  fs.writeFileSync(file, JSON.stringify(saved, null, 1));
  return file;
}

/** Saved site tables, one per instrumented mod; `modId` narrows to one. */
export function loadTables(paths, modId) {
  const dir = tablesDir(paths);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
    .filter((t) => !modId || t.modId.toLowerCase() === modId.toLowerCase());
}

// Writes files into the live copy, then proves the game serves them, as deploy does.
async function writeAndProve(bench, plan, writes, { reload = true, waitMs = 10000 } = {}) {
  const stamp = Math.random().toString(36).slice(2);
  const connected = await bench.cdp.ensure().then(() => bench.cdp.call(engine.stampPage, { stamp }))
    .then(() => true, () => false);
  for (const w of writes) {
    const to = path.join(plan.liveDir, w.rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, w.code);
  }
  const changes = writes.map((w) => ({ rel: w.rel, state: w.state, hash: fnv1a(w.code), ui: true }));
  const files = writes.map((w) => ({ rel: w.rel, state: w.state, live: "UNCHECKED" }));
  const reloaded = connected && changes.length
    ? await bench.confirmDeployed(plan.modId, changes, stamp, { reload, waitMs, files }) : null;
  return { connected, reloaded, files };
}

/**
 * Writes counting copies of the mod's JS into the copy the game loads, reloads the UI and proves the game
 * serves them. Without `yes`, only says what it would write.
 */
export async function instrumentMod(bench, dir, { yes = false, reload = true } = {}) {
  const { plan, files } = planInstrument(bench, dir);
  const rows = files.map(fileRow);
  if (!yes) return { applied: false, modId: plan.modId, liveDir: plan.liveDir, files: rows };
  const writes = files.filter((f) => readText(path.join(plan.liveDir, f.rel)) !== f.code)
    .map((f) => ({ rel: f.rel, code: f.code, state: f.skipped ? "plain" : "counting" }));
  const table = saveTable(bench.paths, plan, files);
  const proof = await writeAndProve(bench, plan, writes, { reload });
  const live = new Map(proof.files.map((f) => [f.rel, f.live]));
  const result = { applied: true, modId: plan.modId, liveDir: plan.liveDir, table, connected: proof.connected,
    reloaded: proof.reloaded, files: rows.map((r) => ({ ...r, live: live.get(r.rel) ?? "UNCHANGED" })) };
  bench.log({ kind: "coverage-instrument", request: { srcDir: plan.srcDir, modId: plan.modId },
    result: { files: proof.files, reloaded: proof.reloaded, skipped: rows.filter((r) => r.skipped).map((r) => r.rel) },
  });
  return result;
}

// Every live file that differs from its source, when a table says the mod was instrumented; without one,
// only live files that hold counting code.
function restoreWrites(plan, table) {
  const rels = new Set([...(table?.files ?? []).map((f) => f.rel), ...modJsFiles(plan.srcDir).files]);
  const writes = [];
  for (const rel of rels) {
    const live = readText(path.join(plan.liveDir, rel));
    const src = readText(path.join(plan.srcDir, rel));
    if (src === null || live === src) continue;
    if (table || live === null || live.includes(PROLOGUE_END)) writes.push({ rel, code: src, state: "restored" });
  }
  return writes;
}

/** Puts the plain source back over every counting copy (and every file the table names). */
export async function restoreMod(bench, dir, { yes = false, reload = true } = {}) {
  const plan = planFor(bench, dir);
  const table = loadTables(bench.paths, plan.modId)[0];
  const writes = restoreWrites(plan, table);
  if (!yes || !writes.length) return { applied: false, modId: plan.modId, files: writes.map((w) => w.rel) };
  const proof = await writeAndProve(bench, plan, writes, { reload });
  if (table) {
    table.restored = new Date().toISOString();
    fs.writeFileSync(path.join(tablesDir(bench.paths), `${safe(plan.modId)}.json`), JSON.stringify(table, null, 1));
  }
  bench.log({ kind: "coverage-restore", request: { srcDir: plan.srcDir, modId: plan.modId },
    result: { files: proof.files, reloaded: proof.reloaded } });
  return { applied: true, modId: plan.modId, ...proof };
}

/** @param {any} paths @param {Coverage} cov */
export function saveRead(paths, cov) {
  fs.mkdirSync(readsDir(paths), { recursive: true });
  const name = `${safe(cov.modId)}-${cov.at.replace(/[:.]/g, "-")}-${cov.route}.json`;
  fs.writeFileSync(path.join(readsDir(paths), name), JSON.stringify(cov));
  return name;
}

/** Saved reads, newest first; `modId` narrows to one mod. */
export function listReads(paths, modId) {
  const dir = readsDir(paths);
  if (!fs.existsSync(dir)) return [];
  const prefix = modId ? `${safe(modId)}-`.toLowerCase() : "";
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f.toLowerCase().startsWith(prefix))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime).map((f) => f.name);
}

/** @returns {Coverage | null} */
export function loadRead(paths, name) {
  if (!name || name !== path.basename(name)) return null;
  const text = readText(path.join(readsDir(paths), name));
  return text === null ? null : JSON.parse(text);
}

/** A mod id from an id or a mod folder. */
export function modIdOf(arg) {
  if (!arg) return undefined;
  try { return readModinfo(path.resolve(arg)).id; } catch { return arg; }
}

async function pageCounts(bench, fromLog) {
  if (fromLog) {
    const parsed = parseCoverageLog(readText(path.join(bench.paths.logs, "UI.log")) ?? "");
    if (!parsed.dump) throw new BenchError("UI.log has no [TB-COVERAGE] lines; run coverage dump first", 404);
    return { counts: parsed.counts, page: `UI.log dump ${parsed.dump}` };
  }
  await bench.requireConnection();
  const r = await bench.cdp.call(coverageRead, {}, { timeoutMs: 20000 });
  if (!r?.installed) {
    throw new BenchError("no counting copy has run on this page: instrument a mod (coverage instrument), then open "
      + "the screen that loads it", 409);
  }
  return { counts: r.files, page: r.href };
}

/**
 * Reads the counters (from the page, or with fromLog from the newest dump in UI.log), maps them onto each
 * instrumented mod's table and saves the result.
 * @param {any} bench @param {{ mod?: string, fromLog?: boolean }} [opts]
 */
export async function readInstrumented(bench, { mod, fromLog = false } = {}) {
  const modId = modIdOf(mod);
  const tables = loadTables(bench.paths, modId);
  if (!tables.length) throw new BenchError(`nothing instrumented${modId ? ` for ${modId}` : ""}; run coverage instrument first`, 404);
  const { counts, page } = await pageCounts(bench, fromLog);
  const out = tables.map((t) => {
    const cov = { ...mapInstrumented(t, counts), page };
    const saved = saveRead(bench.paths, cov);
    return { saved, ...summarize(cov) };
  });
  bench.log({ kind: "coverage-read", request: { mod: modId ?? null, fromLog }, result: out.map((s) => ({
    modId: s.modId, saved: s.saved, functions: s.total.functions, blocks: s.total.blocks })) });
  return out;
}

/** Writes the page's counts to UI.log, so they survive a reload or a crash. */
export async function dumpCounts(bench) {
  await bench.requireConnection();
  const r = await bench.cdp.call(coverageDump, {});
  bench.log({ kind: "coverage-dump", request: {}, result: r });
  return r;
}

/** Zeroes the page's counts. */
export async function resetCounts(bench) {
  await bench.requireConnection();
  const r = await bench.cdp.call(coverageReset, {});
  bench.log({ kind: "coverage-reset", request: {}, result: r });
  return r;
}
