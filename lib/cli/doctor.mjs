import path from "node:path";
import { BenchError } from "../bench.mjs";
import { crashDirs, crashSupported, crashTriage, listCrashes, UNSUPPORTED } from "../crash.mjs";
import { runDoctor } from "../doctor.mjs";
import { num, out } from "./common.mjs";

/** @typedef {import("./common.mjs").Ctx} Ctx */

const messageOf = (e) => (e instanceof Error ? e.message : String(e));
const INDENT = "           ";

/** An ISO time as local "YYYY-MM-DD HH:MM:SS", the form the game's own logs use. */
export function localTime(iso) {
  if (!iso) return "?";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---- doctor ----

/** @param {any} r */
export function printDoctor(r) {
  out(`doctor: ${r.modId} (${r.folder}); game ${r.connected ? "connected" : "not connected"}`);
  for (const s of r.steps) {
    out(`  ${s.verdict.padEnd(8)} ${s.title}: ${s.summary}`);
    for (const n of s.notes ?? []) out(`${INDENT}${n}`);
    if (s.next && s.verdict === "PROBLEM") out(`${INDENT}next: ${s.next}`);
    if (s.techniques?.length) out(`${INDENT}techniques: ${s.techniques.join(", ")} (techniques show <id>)`);
  }
  const cause = r.steps.find((s) => s.id === r.cause);
  out(cause ? `\nfirst cause: ${cause.title}. Next: ${r.next}` : "\nno cause found by these checks");
}

/** @type {import("./common.mjs").Handler} */
async function doctorCommand({ bench, opt }, [dir]) {
  if (!dir) throw new BenchError("which mod folder? doctor <mod-folder>");
  let r;
  try {
    r = await runDoctor(bench, { dir, all: !!opt.all, offline: !!opt["offline"] });
  } catch (e) {
    throw e instanceof BenchError ? e : new BenchError(messageOf(e));
  }
  if (r.cause) process.exitCode = 1;
  return opt.json ? out(r) : printDoctor(r);
}

// ---- crash ----

function printFrames(frames) {
  frames.forEach((f, i) => out(`    ${String(i).padStart(2)}  ${f.image.padEnd(28)} ${f.offset}${f.symbol ? `  ${f.symbol}` : ""}`));
}

function printHeader(r) {
  const c = r.crash;
  const ex = [c.exception.type, c.exception.signal].filter(Boolean).join(" ");
  out(`crash at ${localTime(c.time)}: ${ex}${c.exception.subtype ? ` (${c.exception.subtype})` : ""}`);
  const up = c.launched && c.time ? `, ${Math.round((Date.parse(c.time) - Date.parse(c.launched)) / 1000)} s after launch` : "";
  out(`  game ${c.version ?? "?"} (${c.build ?? "?"}); thread ${c.thread.index} "${c.thread.name}"${up}`);
  out(`  signature ${c.signature ?? "none"}`);
  const others = r.repeats.others;
  out(r.repeats.count > 1
    ? `  seen ${r.repeats.count} times: also ${others.slice(0, 5).map((o) => localTime(o.time)).join(", ")}`
      + `${others.length > 5 ? ", ..." : ""}`
    : "  first time this signature is seen");
  out(`  report ${c.file ?? "?"}`);
  out("  faulting thread, top frames (image-relative):");
  printFrames(c.frames);
}

function section(title, lines, empty) {
  out(`\n${title}`);
  if (!lines.length) return out(`  ${empty}`);
  for (const l of lines) out(`  ${l}`);
  return undefined;
}

function printContext(x) {
  if (x.logs.run === "later") {
    out(`\nlog sections left out: the logs are from a later run. --json has them; enabled now: ${x.enabled.join(", ") || "none"}`);
    return;
  }
  const from = x.logs.run === "crash" ? "" : ` (from ${x.logs.run === "unknown" ? "an undated" : `a ${x.logs.run}`} run)`;
  section(`UI.log, last ${x.uiTail.length} lines${from}`, x.uiTail, "empty or missing");
  section("bench breadcrumbs ([TB-*] lines in UI.log)", x.breadcrumbs, "none");
  section(`mods the run applied (Modding.log)${from}`, x.applied ? [x.applied.map((m) => m.id).join(", ") || "no user mods"]
    : [], "no Target Mods block in Modding.log");
  if (x.moddingErrors.length) section("Modding.log errors", x.moddingErrors, "none");
  const ai = x.ai.flatMap((a) => [`${a.file}: ${a.header}`, ...a.last.map((l) => `  ${l}`)]);
  section(`AI logs, last rows${from}`, ai, "no AI_*.csv rows (AI verbose logging off, or no AI turn ran)");
  section(`Renderer.log errors${from}`, x.renderer, "none");
  section("enabled mods (Mods.sqlite, the next launch)", x.enabled.length ? [x.enabled.join(", ")] : [],
    x.modsError ? `unreadable: ${x.modsError}` : "none");
}

/** @param {any} r */
export function printCrash(r) {
  if (!r.supported) return out(r.note);
  if (!r.crash) return out(r.note);
  printHeader(r);
  for (const w of r.warnings) out(`\nwarning: ${w}`);
  printContext(r.context);
  out(r.next
    ? `\nnext: a crash isolates by mod on and off:\n  ${r.next}`
    : "\nnext: no user mods are enabled, so there is nothing to bisect: the crash reproduces on the base game");
  return undefined;
}

/** @param {any[]} reports */
export function printCrashList(reports) {
  if (!reports.length) return out("no Civilization VII crash reports found");
  for (const c of reports) {
    out(`${localTime(c.time)}  ${String(c.repeats).padStart(3)}x  ${(c.thread.name ?? "").padEnd(26)} ${c.signature ?? "?"}`);
    out(`${" ".repeat(21)}${path.basename(c.file)}`);
  }
  return undefined;
}

/** @type {import("./common.mjs").Handler} */
function crashCommand({ paths, opt }, [sub]) {
  if (!crashSupported()) return out(UNSUPPORTED);
  if (sub === "list") {
    const { reports } = listCrashes(crashDirs(paths));
    const shown = reports.slice(0, num(opt.limit) ?? 20);
    return opt.json ? out(shown) : printCrashList(shown);
  }
  let r;
  try {
    r = crashTriage(paths, { file: sub && sub !== "last" ? sub : undefined });
  } catch (e) {
    throw new BenchError(messageOf(e));
  }
  return opt.json ? out(r) : printCrash(r);
}

/** @type {Record<string, import("./common.mjs").Handler>} */
export const DOCTOR_COMMANDS = { doctor: doctorCommand, crash: crashCommand };

export const DOCTOR_HELP = `  doctor <mod-folder> [--all] [--offline]
                                       "my mod does not work": which copy is live, pre-flight, is the
                                       edit live, its log lines, the running game, conflicts; stops at
                                       the first cause with the next action (--all runs every step)
  crash [--last | <file.ips>]          triage the newest (or given) crash report: signature, repeats,
                                       the logs the run left, and the bisect command that isolates it
  crash list [--limit 20]              recent crash reports with their signatures and repeat counts`;

const wrap = (fn) => {
  try { return fn(); } catch (e) { throw e instanceof BenchError ? e : new BenchError(messageOf(e)); }
};

export const DOCTOR_ROUTES = {
  "GET /api/doctor": (bench, _req, q) => {
    const dir = q.get("dir");
    if (!dir) throw new BenchError("which mod folder?");
    return runDoctor(bench, { dir, all: q.get("all") === "1", offline: q.get("offline") === "1" })
      .catch((e) => { throw e instanceof BenchError ? e : new BenchError(messageOf(e)); });
  },
  // A report is chosen by incident id from the listed ones, so the page never names a file to read.
  "GET /api/crash": (bench, _req, q) => wrap(() => crashTriage(bench.paths, { incident: q.get("incident") || undefined })),
  "GET /api/crash/list": (bench, _req, q) => wrap(() => {
    if (!crashSupported()) return { supported: false, note: UNSUPPORTED, reports: [] };
    const { reports } = listCrashes(crashDirs(bench.paths));
    return { supported: true, reports: reports.slice(0, Number(q.get("limit")) || 30) };
  }),
};
