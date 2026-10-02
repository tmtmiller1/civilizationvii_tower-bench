import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMods, sourceOf } from "./mods.mjs";
import { classify } from "./signatures.mjs";

// Crash triage: read the evidence before theorising. A native crash in this game is unsymbolicated, so the
// currency is a stable signature (the game binary's own frames) to recognise repeats, the logs the dying run
// left behind, and isolation by mod on and off. macOS only for now: Windows keeps its dumps elsewhere.

export const CRASH_FILE = /^CivilizationVII.*\.ips$/;
const SIGNATURE_FRAMES = 3;
const SHOWN_FRAMES = 12;

/** @param {string} [platform] */
export const crashSupported = (platform = process.platform) => platform === "darwin";
export const UNSUPPORTED = "crash reports not supported on this platform yet";

const messageOf = (e) => (e instanceof Error ? e.message : String(e));

/**
 * Where reports are: macOS's DiagnosticReports (and Retired, where it moves old ones), and the copies a lab
 * run keeps of the reports it caused, since macOS deletes the originals after a while.
 * @param {{ evidence: string }} paths @param {string} [home]
 */
export function crashDirs(paths, home = os.homedir()) {
  const diag = path.join(home, "Library", "Logs", "DiagnosticReports");
  const runs = path.join(path.dirname(paths.evidence), "runs");
  let labRuns = [];
  try {
    labRuns = fs.readdirSync(runs, { withFileTypes: true }).filter((d) => d.isDirectory())
      .map((d) => path.join(runs, d.name));
  } catch { /* no lab runs yet */ }
  return [diag, path.join(diag, "Retired"), ...labRuns];
}

/** An .ips report is one JSON header line, then the JSON body. */
export function parseIps(text) {
  const nl = text.indexOf("\n");
  if (nl < 0) throw new Error("not an .ips crash report: no header line");
  try {
    return { header: JSON.parse(text.slice(0, nl)), body: JSON.parse(text.slice(nl + 1)) };
  } catch (e) {
    throw new Error(`not an .ips crash report: ${messageOf(e)}`);
  }
}

/** "2026-09-30 22:34:04.0103 -0400" as a Date, or null. */
export function ipsDate(s) {
  const m = String(s ?? "").match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(\.\d+)? ([+-]\d\d)(\d\d)$/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}${(m[3] ?? "").slice(0, 4)}${m[4]}:${m[5]}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const hex = (n) => `0x${Number(n).toString(16)}`;

function mainImageIndex(body) {
  const images = body.usedImages ?? [];
  const i = images.findIndex((im) => im.name === body.procName
    || (im.CFBundleIdentifier && im.CFBundleIdentifier === body.bundleInfo?.CFBundleIdentifier));
  return i >= 0 ? i : 0;
}

function frameOf(f, images, main) {
  const im = images[f.imageIndex];
  const image = im ? im.name || path.basename(im.path ?? "") || "?" : "?";
  return {
    image, offset: hex(f.imageOffset ?? 0), main: f.imageIndex === main,
    ...(f.symbol ? { symbol: `${f.symbol}${f.symbolLocation ? ` + ${f.symbolLocation}` : ""}` } : {}),
  };
}

function threadName(body, index) {
  const t = body.threads?.[index] ?? {};
  return t.name ?? t.queue ?? body.legacyInfo?.threadTriggered?.name ?? `thread ${index}`;
}

/**
 * The game binary's own top frames, image-relative, prefixed by the build: offsets move with every build, so
 * a signature only matches reports from the same one. Falls back to the top frames of any image.
 */
export function signatureOf(frames, build) {
  const own = frames.filter((f) => f.main).slice(0, SIGNATURE_FRAMES);
  const picked = own.length ? own : frames.slice(0, SIGNATURE_FRAMES);
  if (!picked.length) return null;
  return `${build ?? "?"}:${picked.map((f) => `${f.image}+${f.symbol ?? f.offset}`).join(",")}`;
}

const first = (...values) => values.find((v) => v !== undefined && v !== null) ?? null;

function identity(header, body) {
  const time = first(ipsDate(body.captureTime), ipsDate(header.timestamp));
  const info = body.bundleInfo ?? {};
  return {
    incident: first(header.incident_id, body.incident),
    time: time?.toISOString() ?? null, launched: ipsDate(body.procLaunch)?.toISOString() ?? null,
    version: first(header.app_version, info.CFBundleShortVersionString),
    build: first(header.build_version, info.CFBundleVersion),
  };
}

function exceptionOf(body) {
  const ex = body.exception ?? {};
  return { type: ex.type ?? null, signal: ex.signal ?? null, subtype: ex.subtype ?? null };
}

function faultingIndex(body) {
  if (typeof body.faultingThread === "number") return body.faultingThread;
  const i = (body.threads ?? []).findIndex((t) => t.triggered);
  return i >= 0 ? i : 0;
}

/** The parts of a report that triage needs. */
export function summariseIps({ header, body }, file = null) {
  const main = mainImageIndex(body);
  const index = faultingIndex(body);
  const all = (body.threads?.[index]?.frames ?? []).map((f) => frameOf(f, body.usedImages ?? [], main));
  const id = identity(header, body);
  return {
    file, ...id, exception: exceptionOf(body), termination: body.termination?.indicator ?? null,
    thread: { index, name: threadName(body, index) },
    frames: all.slice(0, SHOWN_FRAMES), signature: signatureOf(all, id.build),
  };
}

export function readCrash(file) {
  return summariseIps(parseIps(fs.readFileSync(file, "utf8")), file);
}

function reportFiles(dirs) {
  const files = [];
  for (const dir of dirs) {
    try {
      for (const f of fs.readdirSync(dir)) if (CRASH_FILE.test(f)) files.push(path.join(dir, f));
    } catch { /* missing folder */ }
  }
  return files;
}

/**
 * Every crash report found, newest first, one per incident (a lab copy and the original are one crash),
 * each with how many reports share its signature.
 * @param {string[]} dirs
 */
export function listCrashes(dirs) {
  const byIncident = new Map();
  const unreadable = [];
  for (const file of reportFiles(dirs)) {
    let r;
    try { r = readCrash(file); } catch (e) { unreadable.push({ file, error: messageOf(e) }); continue; }
    const key = r.incident ?? file;
    if (!byIncident.has(key)) byIncident.set(key, r);
  }
  const reports = [...byIncident.values()].sort((a, b) => String(b.time).localeCompare(String(a.time)));
  const counts = new Map();
  for (const r of reports) counts.set(r.signature, (counts.get(r.signature) ?? 0) + 1);
  for (const r of reports) r.repeats = counts.get(r.signature);
  return { reports, unreadable };
}

// ---- the logs around the crash -------------------------------------------------------------------

const TAIL_BYTES = 4 * 1024 * 1024;

function readTail(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split(/\r?\n/);
    if (start > 0) lines.shift();
    return lines.filter((l) => l.trim());
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const LOG_STAMP = /^\[(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)\]/;

/** The game's log stamps are local time without a zone. */
export function logDate(line) {
  const m = String(line ?? "").match(LOG_STAMP);
  return m ? new Date(`${m[1]}T${m[2]}`) : null;
}

function readHead(file, bytes = 4096) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8").split(/\r?\n/);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function firstStamp(file) {
  for (const l of readHead(file)) {
    const d = logDate(l);
    if (d) return d;
  }
  return null;
}

/**
 * The game truncates its logs at launch, so logs started after the crash belong to a later run and say
 * nothing about it. Modding.log is written from the first second of a launch, so its first stamp dates the run.
 */
/** When the run that wrote the logs folder started, or null. */
export function logsStarted(logsDir) {
  return firstStamp(path.join(logsDir, "Modding.log")) ?? firstStamp(path.join(logsDir, "UI.log"));
}

export function logsRun(logsDir, crash) {
  const started = logsStarted(logsDir);
  const at = crash.time ? new Date(crash.time) : null;
  if (!started || !at) return { run: "unknown", started: started?.toISOString() ?? null };
  // A launch's first stamp lands within seconds of procLaunch; the margins allow for a slow start.
  const launched = crash.launched ? new Date(crash.launched).getTime() : -Infinity;
  let run = "crash";
  if (started.getTime() > at.getTime() + 5000) run = "later";
  else if (started.getTime() < launched - 120000) run = "earlier";
  return { run, started: started.toISOString() };
}

/** The last "Target Mods" block of Modding.log: every mod the last configuration applied, official included. */
export function appliedMods(lines) {
  let start = -1;
  lines.forEach((l, i) => { if (/\tTarget Mods\b/.test(l)) start = i; });
  if (start < 0) return null;
  const out = [];
  for (const l of lines.slice(start + 1)) {
    const m = l.match(/^\[[^\]]+\]\t(\S+) \((.*)\)\s*$/);
    if (!m) break;
    out.push({ id: m[1], name: m[2] });
  }
  return out;
}

function aiTails(logsDir) {
  let files = [];
  try { files = fs.readdirSync(logsDir).filter((f) => /^AI_.*\.csv$/.test(f)); } catch { return []; }
  const out = [];
  for (const f of files) {
    const file = path.join(logsDir, f);
    const header = readHead(file).find((l) => l.trim()) ?? "";
    const rows = (readTail(file, 64 * 1024) ?? []).filter((l) => l !== header);
    if (!rows.length) continue;
    out.push({ file: f, header, last: rows.slice(-3), mtime: fs.statSync(file).mtimeMs });
  }
  // The constructible broker's last row is the last item the AI evaluated: first, then most recent.
  return out.sort((a, b) => Number(b.file === "AI_ConstructibleBroker.csv") - Number(a.file === "AI_ConstructibleBroker.csv")
    || b.mtime - a.mtime).slice(0, 8).map(({ mtime: _m, ...rest }) => rest);
}

function userModIds(paths) {
  if (!fs.existsSync(paths.modsDb)) return { official: new Set(), enabled: [], error: `no registry at ${paths.modsDb}` };
  try {
    const rows = readMods(paths.modsDb);
    const official = (r) => sourceOf(r.path, paths).kind === "official";
    return {
      official: new Set(rows.filter(official).map((r) => r.id)),
      enabled: [...new Set(rows.filter((r) => !official(r) && !r.disabled).map((r) => r.id))].sort(),
    };
  } catch (e) {
    return { official: new Set(), enabled: [], error: messageOf(e) };
  }
}

/**
 * Everything the logs folder says about the run that crashed.
 * @param {any} paths @param {{ time: string | null, launched: string | null }} crash
 */
export function crashContext(paths, crash) {
  const dir = paths.logs;
  const ui = readTail(path.join(dir, "UI.log")) ?? [];
  const modding = readTail(path.join(dir, "Modding.log")) ?? [];
  const renderer = readTail(path.join(dir, "Renderer.log")) ?? [];
  const mods = userModIds(paths);
  const applied = appliedMods(modding);
  return {
    logs: logsRun(dir, crash),
    uiTail: ui.slice(-30),
    breadcrumbs: ui.filter((l) => l.includes("[TB-")).slice(-10),
    moddingErrors: modding.filter((l) => classify(l).severity === "error").slice(-5),
    // Official ids come from the registry; an id it does not list is a mod, not the base game.
    applied: applied ? applied.filter((m) => !mods.official.has(m.id)) : null,
    ai: aiTails(dir),
    renderer: renderer.filter((l) => /ERROR|AddStaticResource/.test(l)).slice(-10),
    enabled: mods.enabled,
    ...(mods.error ? { modsError: mods.error } : {}),
  };
}

/** The isolation step: bisect over the user mods the crashed run applied, if the logs are its, else the enabled set. */
export function bisectCommand(ctx) {
  const fromRun = ctx.logs.run === "crash" && ctx.applied?.length
    ? ctx.applied.map((m) => m.id).filter((id) => ctx.enabled.includes(id)) : null;
  const set = fromRun?.length ? fromRun : ctx.enabled;
  if (!set.length) return null;
  return `tower-bench bisect --mods ${set.join(",")} --turns <N that reaches the crash>`;
}

function pickCrash(reports, { file, incident }) {
  if (file) return readCrash(file);
  if (incident) {
    const hit = reports.find((r) => r.incident === incident);
    if (!hit) throw new Error(`no crash report with incident ${incident}`);
    return hit;
  }
  return reports[0] ?? null;
}

/**
 * Triage of one crash: the newest report, or `file`, or the listed report with `incident`.
 * @param {any} paths @param {{ file?: string, incident?: string, dirs?: string[], platform?: string }} [opts]
 */
export function crashTriage(paths, { file, incident, dirs, platform } = {}) {
  if (!crashSupported(platform)) return { supported: false, note: UNSUPPORTED };
  const { reports, unreadable } = listCrashes(dirs ?? crashDirs(paths));
  const crash = pickCrash(reports, { file, incident });
  if (!crash) return { supported: true, crash: null, note: "no Civilization VII crash reports found", unreadable };
  const same = reports.filter((r) => r.signature === crash.signature && r.incident !== crash.incident);
  const context = crashContext(paths, crash);
  const warnings = [];
  if (context.logs.run === "later") {
    warnings.push(`the logs started ${context.logs.started}, after this crash: they belong to a later run `
      + "and say nothing about it");
  } else if (context.logs.run === "earlier") warnings.push("the logs are from a run before this crash");
  const others = same.map((r) => ({ time: r.time, file: r.file }));
  return { supported: true, crash, repeats: { count: same.length + 1, others }, context, warnings,
    next: bisectCommand(context) };
}
