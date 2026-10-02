// Scheduling the nightly: a per-user launchd agent on macOS, and the equivalent schtasks or cron line elsewhere
// (printed, not installed). Only the bench's own agent file is ever written, loaded or removed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BenchError } from "./bench.mjs";
import { nightlyDir } from "./nightly-suite.mjs";

export const LABEL = "local.tower-bench-nightly";

/** @param {string} home */
export const agentFile = (home = os.homedir()) => path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
export const schedulerLog = (paths) => path.join(nightlyDir(paths), "launchd.log");

/** "03:00" -> { hour: 3, minute: 0 } */
export function parseAt(at) {
  const m = String(at ?? "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new BenchError(`--at wants a 24-hour time such as 03:00, got "${at ?? ""}"`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

export const xmlEscape = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] ?? c);

/** The command the schedule runs: this node, this bench, the suite. */
export function nightlyCommand({ node = process.execPath, bench, suite, notify = false }) {
  return [node, bench, "nightly", "run", "--only-if-updated", "--suite", suite, ...(notify ? ["--notify"] : [])];
}

const str = (s) => `<string>${xmlEscape(s)}</string>`;

/**
 * The launchd agent. `env` carries the bench's own TOWER_BENCH_* settings and PATH, so the scheduled run
 * resolves the same folders and finds sqlite3 the way this shell does.
 * @param {{ args: string[], hour: number, minute: number, log: string, env?: Record<string, string> }} o
 */
export function plistXml({ args, hour, minute, log, env = {} }) {
  const envXml = Object.entries(env).map(([k, v]) => `      <key>${xmlEscape(k)}</key>\n      ${str(v)}`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    ${str(LABEL)}
    <key>ProgramArguments</key>
    <array>
${args.map((a) => `      ${str(a)}`).join("\n")}
    </array>
    <key>StartCalendarInterval</key>
    <dict>
      <key>Hour</key>
      <integer>${hour}</integer>
      <key>Minute</key>
      <integer>${minute}</integer>
    </dict>
    <key>StandardOutPath</key>
    ${str(log)}
    <key>StandardErrorPath</key>
    ${str(log)}
${envXml ? `    <key>EnvironmentVariables</key>\n    <dict>\n${envXml}\n    </dict>\n` : ""}    <key>RunAtLoad</key>
    <false/>
  </dict>
</plist>
`;
}

/** TOWER_BENCH_* variables and PATH from `env`, for the agent. */
export function agentEnv(env = process.env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && (k.startsWith("TOWER_BENCH_") || k === "PATH")) out[k] = v;
  return out;
}

const quoteWin = (s) => `"${s.replaceAll('"', '\\"')}"`;
const quoteSh = (s) => (/^[\w./:=@%+-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

/** The schtasks line for Windows: daily at the time, as the current user. */
export function schtasksLine(args, { hour, minute }) {
  const at = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return `schtasks /Create /SC DAILY /ST ${at} /TN "tower-bench-nightly" /TR ${quoteWin(args.map(quoteWin).join(" "))} /F`;
}

/** The crontab line for Linux and other Unix systems. */
export function cronLine(args, { hour, minute }, log) {
  return `${minute} ${hour} * * * ${args.map(quoteSh).join(" ")} >> ${quoteSh(log)} 2>&1`;
}

/** launchctl argument lists for the gui domain of `uid`. */
export function launchctlCommands(uid, file) {
  const domain = `gui/${uid}`;
  return {
    bootstrap: ["bootstrap", domain, file],
    bootout: ["bootout", `${domain}/${LABEL}`],
    print: ["print", `${domain}/${LABEL}`],
    legacyLoad: ["load", "-w", file],
    legacyUnload: ["unload", "-w", file],
  };
}

/**
 * @typedef {{ exec?: (cmd: string, args: string[]) => string, platform?: string, uid?: number, home?: string,
 *   fsx?: Pick<typeof fs, "existsSync" | "readFileSync" | "writeFileSync" | "mkdirSync" | "rmSync"> }} Sys
 */
const defaultExec = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function sys(/** @type {Sys} */ s = {}) {
  return { exec: s.exec ?? defaultExec, platform: s.platform ?? process.platform,
    uid: s.uid ?? (process.getuid ? process.getuid() : 0), home: s.home ?? os.homedir(), fsx: s.fsx ?? fs };
}

function tryExec(x, args) {
  try { return { ok: true, out: x.exec("launchctl", args) }; } catch (e) { return { ok: false, out: e instanceof Error ? e.message : String(e) }; }
}

/** Whether launchd has the agent loaded. */
function loaded(x, file) {
  return tryExec(x, launchctlCommands(x.uid, file).print).ok;
}

/** Unloads the agent if launchd has it; bootout first, the legacy unload when bootout is unavailable. */
function unload(x, file) {
  const c = launchctlCommands(x.uid, file);
  if (!loaded(x, file)) return false;
  if (tryExec(x, c.bootout).ok) return true;
  return tryExec(x, c.legacyUnload).ok;
}

/**
 * Installs (macOS) or prints (elsewhere) the nightly schedule.
 * @param {any} paths
 * @param {{ at: string, suite: string, bench: string, yes?: boolean, node?: string, notify?: boolean,
 *   env?: Record<string, string> }} o
 * @param {Sys} [s]
 */
export function schedule(paths, { at, suite, bench, yes = false, node, notify = false, env = agentEnv() }, s) {
  const x = sys(s);
  const when = parseAt(at);
  const args = nightlyCommand({ node, bench, suite: path.resolve(suite), notify });
  const log = schedulerLog(paths);
  if (x.platform === "win32") return { installed: false, platform: x.platform, line: schtasksLine(args, when) };
  if (x.platform !== "darwin") return { installed: false, platform: x.platform, line: cronLine(args, when, log) };
  const file = agentFile(x.home);
  const xml = plistXml({ args, ...when, log, env });
  if (!yes) return { installed: false, platform: x.platform, file, xml, note: "add --yes to install it" };
  x.fsx.mkdirSync(path.dirname(file), { recursive: true });
  x.fsx.mkdirSync(path.dirname(log), { recursive: true });
  const replaced = unload(x, file);
  x.fsx.writeFileSync(file, xml, { mode: 0o644 });
  const c = launchctlCommands(x.uid, file);
  const boot = tryExec(x, c.bootstrap);
  const ok = boot.ok || tryExec(x, c.legacyLoad).ok;
  if (!ok) throw new BenchError(`wrote ${file} but launchctl would not load it: ${boot.out}`);
  return { installed: true, platform: x.platform, file, replaced, at: at, args, log };
}

/** Removes the bench's agent: unload, then delete its file. Nothing else in LaunchAgents is touched. */
export function unschedule({ yes = false } = {}, s) {
  const x = sys(s);
  if (x.platform !== "darwin") {
    return { removed: false, platform: x.platform,
      note: x.platform === "win32" ? 'schtasks /Delete /TN "tower-bench-nightly" /F' : "crontab -e, and delete the tower-bench line" };
  }
  const file = agentFile(x.home);
  if (!x.fsx.existsSync(file) && !loaded(x, file)) return { removed: false, file, note: "no nightly schedule is installed" };
  if (!yes) return { removed: false, file, note: "add --yes to remove it" };
  const unloaded = unload(x, file);
  x.fsx.rmSync(file, { force: true });
  return { removed: true, file, unloaded };
}

const plistValue = (xml, key, tag) => xml.match(new RegExp(`<key>${key}</key>\\s*<${tag}>([^<]*)</${tag}>`))?.[1] ?? null;
const unescape = (s) => s.replace(/&(lt|gt|quot|apos|amp);/g, (_m, e) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[e]);

/** What is scheduled: the agent file's time, command and suite, and whether launchd has it loaded. */
export function scheduleStatus(paths, s) {
  const x = sys(s);
  if (x.platform !== "darwin") return { platform: x.platform, supported: false, note: "schedule status is read from launchd on macOS only" };
  const file = agentFile(x.home);
  if (!x.fsx.existsSync(file)) {
    return { platform: x.platform, supported: true, installed: false, file, loaded: loaded(x, file) };
  }
  const xml = String(x.fsx.readFileSync(file, "utf8"));
  const args = [...(xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? "").matchAll(/<string>([^<]*)<\/string>/g)]
    .map((m) => unescape(m[1]));
  const hour = Number(plistValue(xml, "Hour", "integer"));
  const minute = Number(plistValue(xml, "Minute", "integer"));
  const suiteAt = args.indexOf("--suite");
  return { platform: x.platform, supported: true, installed: true, file, loaded: loaded(x, file),
    at: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, args,
    suite: suiteAt >= 0 ? args[suiteAt + 1] ?? null : null, log: schedulerLog(paths) };
}
