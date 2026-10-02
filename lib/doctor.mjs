import fs from "node:fs";
import path from "node:path";
import { analyseMod } from "./analysis.mjs";
import { logsStarted } from "./crash.mjs";
import { readModinfo } from "./deploy.mjs";
import { DEFAULT_LOGS, readRecent } from "./logs.mjs";
import { modHealth, readMods } from "./mods.mjs";
import { techniqueIds } from "./techniques.mjs";
import { versionChanged } from "./patch.mjs";

// "My mod does not work": the bench's checks in the order a cause is cheapest to rule out, each with a
// verdict and the next action. The first PROBLEM is the cause to fix first; the steps after it are listed
// but not run unless asked, because each assumes the ones before it passed.

/**
 * @typedef {"OK" | "PROBLEM" | "SKIPPED"} Verdict
 * @typedef {{ verdict: Verdict, summary: string, next?: string, notes?: string[], data?: any }} StepResult
 * @typedef {{ bench: any, paths: any, dir: string, folder: string, modId: string, items: string[],
 *   groups: string[], connected: boolean, cache: Record<string, any> }} DoctorCtx
 * @typedef {{ id: string, title: string, run: (ctx: DoctorCtx) => StepResult | Promise<StepResult> }} DoctorStep
 */

const messageOf = (e) => (e instanceof Error ? e.message : String(e));
const quote = (s) => (/[\s"']/.test(s) ? `"${s.replaceAll('"', '\\"')}"` : s);
/** @returns {StepResult} */
const skipped = (summary, extra = {}) => ({ verdict: "SKIPPED", summary, ...extra });
/** @returns {StepResult} */
const problem = (summary, next, extra = {}) => ({ verdict: "PROBLEM", summary, next, ...extra });
/** @returns {StepResult} */
const ok = (summary, extra = {}) => ({ verdict: "OK", summary, ...extra });

const resolved = (p) => path.resolve(p).replaceAll("\\", "/").toLowerCase();

// ---- 1. registry ------------------------------------------------------------------------------

function registryEntry(ctx) {
  if (!("mod" in ctx.cache)) {
    const mods = modHealth(readMods(ctx.paths.modsDb), ctx.paths);
    ctx.cache.mod = mods.find((m) => m.id === ctx.modId) ?? null;
  }
  return ctx.cache.mod;
}

// The copy to make live: this folder's own copy if the game registered it, else a local one.
function preferredCopy(mod, folder) {
  const own = mod.copies.find((c) => resolved(path.dirname(c.path)) === resolved(folder));
  return own ?? mod.copies.find((c) => c.source.kind === "local") ?? null;
}

function liveCommand(mod, folder, why) {
  const pick = preferredCopy(mod, folder);
  if (!pick) return `${why} Install a local copy in Mods/, start the game once so it registers it, then run doctor again.`;
  return `tower-bench mods live ${mod.id} ${quote(pick.source.label)} --yes (game closed)`;
}

function copiesProblem(mod, folder) {
  const live = mod.copies.filter((c) => c.enabled);
  const labels = live.map((c) => c.source.label).join(", ");
  if (live.length > 1) {
    return problem(`${live.length} copies of ${mod.id} are enabled (${labels}); the game loads one and edits to the others do nothing`,
      liveCommand(mod, folder, ""));
  }
  if (!live.length) {
    const next = mod.copies.length > 1 ? liveCommand(mod, folder, "") : `tower-bench mods on ${mod.id} --yes (game closed)`;
    return problem(`${mod.id} is installed but switched off`, next);
  }
  const kind = live[0].source.kind;
  if (kind === "workshop") {
    return problem(`the copy the game loads is ${labels}: Steam owns it, so local edits do nothing`,
      liveCommand(mod, folder, "Only the Workshop copy is installed."));
  }
  if (kind === "nested") {
    return problem(`the copy the game loads is ${labels}, a build output inside another mod folder`,
      liveCommand(mod, folder, ""));
  }
  return null;
}

/** @type {DoctorStep} */
const registryStep = {
  id: "registry", title: "Which copy the game loads",
  run(ctx) {
    const mod = registryEntry(ctx);
    if (!mod) {
      return problem(`the game has never registered mod id ${ctx.modId}`,
        `copy the folder into ${ctx.paths.userMods} and start the game once so it scans it`);
    }
    const bad = copiesProblem(mod, ctx.folder);
    const copies = mod.copies.map((c) => ({ label: c.source.label, enabled: c.enabled }));
    if (bad) return { ...bad, data: { copies } };
    const live = mod.copies.find((c) => c.enabled);
    const own = resolved(path.dirname(live.path)) === resolved(ctx.folder);
    const notes = [
      ...(own ? [] : [`you edit a source folder; the game loads ${live.source.label}, so changes reach it only by deploy`]),
      ...mod.issues.map((i) => i.text),
    ];
    return ok(`live copy: ${live.source.label}`, { notes, data: { live: live.source.label, own } });
  },
};

// ---- 2. pre-flight ----------------------------------------------------------------------------

function analysis(ctx) {
  if (!("analysis" in ctx.cache)) ctx.cache.analysis = analyseMod(ctx.paths, ctx.folder);
  return ctx.cache.analysis;
}

/** @type {DoctorStep} */
const preflightStep = {
  id: "preflight", title: "Pre-flight check (read from files)",
  run(ctx) {
    let r;
    try { r = analysis(ctx); } catch (e) { return skipped(`could not read the mod against the game: ${messageOf(e)}`); }
    const serious = r.defects.filter((d) => d.verdict === "BLOCKS GAME" || d.verdict === "FEATURE DEAD");
    const notes = serious.slice(1, 6).map((d) => `${d.verdict} ${d.rule}: ${d.text}`);
    if (r.schemaNote) notes.push(`database checks skipped: ${r.schemaNote}`);
    if (!serious.length) {
      return ok(`no blocking defects on game ${r.gameVersion} (${r.defects.length} minor)`, { notes });
    }
    const d = serious[0];
    return problem(`${d.verdict} ${d.rule}: ${d.text}`, `tower-bench check ${quote(ctx.dir)} lists each defect and its fix`,
      { notes, data: { defects: serious } });
  },
};

// ---- 3. is the edit live ----------------------------------------------------------------------

function diskDrift(ctx) {
  const plan = ctx.bench.planFor(ctx.folder);
  if (plan.refuse || plan.inPlace) return { plan, changed: [] };
  return { plan, changed: (plan.changes ?? []).map((c) => c.rel) };
}

/** @type {DoctorStep} */
const liveStep = {
  id: "live", title: "Is the edit live",
  async run(ctx) {
    let drift;
    try { drift = diskDrift(ctx); } catch (e) { return skipped(`could not compare: ${messageOf(e)}`); }
    const { plan, changed } = drift;
    if (plan.refuse) return skipped("no single enabled local copy to compare against (see the first step)");
    const next = plan.ownDeploy
      ? `run the mod's own ${plan.ownDeploy}, then tower-bench deploy ${quote(ctx.dir)} --prove`
      : `tower-bench deploy ${quote(ctx.dir)} --yes (copies, reloads the UI and proves it)`;
    if (changed.length) {
      const shown = `${changed.slice(0, 4).join(", ")}${changed.length > 4 ? ", ..." : ""}`;
      return problem(`${changed.length} file(s) in ${plan.liveLabel} differ from your source: ${shown}`, next);
    }
    if (!ctx.connected) return skipped("game not connected; the copy on disk matches your source");
    const pr = await ctx.bench.prove(ctx.folder);
    const stale = pr.files.filter((f) => f.live !== "SERVED");
    if (!stale.length) return ok(`all ${pr.files.length} UI file(s) are what the game serves`);
    return problem(`${stale.length} of ${pr.files.length} UI file(s) are not what the game serves (${stale[0].rel}: ${stale[0].live})`,
      `tower-bench deploy ${quote(ctx.dir)} --yes reloads the UI; data and text files need a new game`, { data: { files: pr.files } });
  },
};

// ---- 4. logs ----------------------------------------------------------------------------------

const ROLLBACK = /^db-rollback|^config-rollback/;

/** Why a log line is about this mod, or null. */
export function attribution(line, { modId, items, groups }) {
  if (line.mod === modId) return `fs://game/${modId}/`;
  const text = line.text;
  const file = items.find((rel) => rel.length > 4 && text.includes(rel));
  if (file) return file;
  const group = groups.find((g) => text.includes(`'${g} (`));
  if (group) return `action group ${group}`;
  return new RegExp(`(^|[^\\w-])${modId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w-]|$)`).test(text) ? modId : null;
}

// The rollback lines that follow one naming a file, up to the next file named (another incident).
function incidentAfter(lines, i) {
  const out = [];
  for (const l of lines.slice(i + 1, i + 6)) {
    if (l.file !== lines[i].file || !ROLLBACK.test(l.signature ?? "") || l.signature === "db-rollback-file") break;
    out.push(l);
  }
  return out;
}

/**
 * Lines attributed to the mod, errors first. A database rollback is one incident: the lines after a
 * rollback that names one of its files are kept with it, since they carry the outcome.
 */
export function modLines(lines, who) {
  const hits = [];
  const taken = new Set();
  for (let i = 0; i < lines.length; i++) {
    const why = taken.has(lines[i]) ? null : attribution(lines[i], who);
    if (!why || lines[i].severity === "noise" || lines[i].severity === "info") continue;
    const incident = ROLLBACK.test(lines[i].signature ?? "") ? incidentAfter(lines, i) : [];
    for (const l of incident) taken.add(l);
    hits.push({ ...lines[i], why, incident });
  }
  const rank = { error: 0, warn: 1 };
  return hits.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** @type {DoctorStep} */
const logsStep = {
  id: "logs", title: "Recent log lines about this mod",
  run(ctx) {
    if (!fs.existsSync(ctx.paths.logs)) return skipped(`no logs folder at ${ctx.paths.logs}; start the game once`);
    const lines = readRecent(ctx.paths.logs, DEFAULT_LOGS, ctx.cache.logBytes ?? 512 * 1024);
    const hits = modLines(lines, ctx);
    const errors = hits.filter((h) => h.severity === "error");
    const started = logsStarted(ctx.paths.logs);
    // The game truncates its logs at launch: they describe the last run only, not necessarily your last edit.
    const data = { lines: hits.slice(0, 20), started: started?.toISOString() ?? null };
    const when = started ? ` (logs from the run started ${started.toLocaleString()})` : "";
    if (!errors.length) {
      return ok(`${hits.length ? `${hits.length} warning(s), no errors` : "nothing about this mod"}${when}`,
        { notes: hits.slice(0, 3).map((h) => `${h.file}: ${h.text.trim()}`), data });
    }
    const e = errors[0];
    return problem(`${e.file}: ${e.text.trim()}`, e.hint ?? "read the lines just before it in the same log",
      { notes: [...e.incident.map((l) => `then: ${l.text.trim()}`), ...errors.slice(1, 4).map((h) => `${h.file}: ${h.text.trim()}`)],
        data });
  },
};

// ---- 5. the running game's registry ------------------------------------------------------------

const COMPONENT = /`([^`]+)`/;

function lostComponents(ctx, r) {
  let conflicts = [];
  try { conflicts = analysis(ctx).conflicts; } catch { /* the pre-flight step reports it */ }
  const lost = [];
  for (const c of conflicts.filter((x) => x.rule === "define-collision")) {
    const name = c.text.match(COMPONENT)?.[1];
    const live = r.controls?.find((x) => x.name === name);
    if (live && !live.mods.includes(ctx.modId)) lost.push(`${name} (won by ${live.mods.join(", ") || "base game"})`);
  }
  return lost;
}

/** @type {DoctorStep} */
const runningStep = {
  id: "running", title: "What the running game applied",
  async run(ctx) {
    if (!ctx.connected) return skipped("game not connected");
    const r = await ctx.bench.registry();
    if (r.active?.onlyNext.includes(ctx.modId)) {
      return problem("enabled for the next launch but not applied to the game that is running",
        "start a new game (or quit and relaunch); a loaded save brings its own mod list");
    }
    const lost = lostComponents(ctx, r);
    if (lost.length) {
      return problem(`its component definition lost: ${lost.join("; ")}`, "tower-bench registry shows every winner");
    }
    const mine = (r.controls ?? []).filter((c) => c.mods.includes(ctx.modId)).map((c) => c.name);
    const applied = r.active ? "applied to this game" : "active mod list unavailable on this page";
    return ok(`${applied}; components it won: ${mine.length ? mine.join(", ") : "none"}`);
  },
};

// ---- 6. conflicts -----------------------------------------------------------------------------

/** @type {DoctorStep} */
const conflictsStep = {
  id: "conflicts", title: "Conflicts with the mods loaded alongside it",
  run(ctx) {
    let r;
    try { r = analysis(ctx); } catch (e) { return skipped(`could not read the mod against the game: ${messageOf(e)}`); }
    const high = r.conflicts.filter((c) => c.severity === "High");
    const others = r.conflicts.length - high.length;
    if (!high.length) return ok(`no High conflicts with ${r.against} enabled mod(s); ${others} lower`);
    const c = high[0];
    return problem(`${c.a} / ${c.b}: ${c.text}`, c.prove ? `tower-bench ${c.prove}` : "tower-bench mods conflicts",
      { notes: high.slice(1, 4).map((x) => `${x.a} / ${x.b}: ${x.text}`), data: { conflicts: high } });
  },
};

// An update is the commonest reason a mod that worked yesterday does not today, and the first launch after
// one loads no mods at all, so it is checked before anything about the mod itself.
const updateStep = {
  id: "game-updated", title: "Did the game update",
  run: (ctx) => {
    const v = versionChanged(ctx.paths);
    if (!v) return skipped("the installed version could not be read");
    if (v.changed) return problem(v.message, "tower-bench game impact");
    return ok(v.newest ? `game ${v.installed}, same as the newest index` : v.message ?? `game ${v.installed}`);
  },
};

/** The steps in order. Exported so more checks can be inserted. */
export const DOCTOR_STEPS = [updateStep, registryStep, preflightStep, liveStep, logsStep, runningStep, conflictsStep];

function modIdentity(dir) {
  const info = readModinfo(dir);
  let groups = [];
  try {
    const xml = fs.readFileSync(path.join(dir, info.file), "utf8");
    groups = [...xml.matchAll(/<ActionGroup\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  } catch { /* the id is enough */ }
  return { modId: info.id, items: [info.file, ...info.items], groups };
}

async function isConnected(bench, offline) {
  if (offline) return false;
  const st = await bench.status().catch(() => null);
  return !!st?.connected;
}

/** @returns {Promise<DoctorCtx>} */
async function doctorContext(bench, dir, offline, logBytes) {
  const folder = path.resolve(dir);
  return { bench, paths: bench.paths, dir, folder, ...modIdentity(folder),
    connected: await isConnected(bench, offline), cache: { logBytes } };
}

async function runStep(step, ctx, cause, all) {
  if (cause && !all) return skipped(`not run: "${cause.title}" found a cause first (--all runs every step)`);
  try {
    return await step.run(ctx);
  } catch (e) {
    return skipped(`could not run: ${messageOf(e)}`);
  }
}

/**
 * Runs the steps in order and stops at the first PROBLEM (listing the rest as SKIPPED), or runs them all.
 * @param {any} bench
 * @param {{ dir: string, all?: boolean, offline?: boolean, steps?: DoctorStep[], logBytes?: number }} opts
 */
export async function runDoctor(bench, { dir, all = false, offline = false, steps = DOCTOR_STEPS, logBytes }) {
  const ctx = await doctorContext(bench, dir, offline, logBytes);
  const results = [];
  for (const step of steps) {
    const cause = results.find((x) => x.verdict === "PROBLEM");
    const r = await runStep(step, ctx, cause, all);
    const techniques = r.verdict === "PROBLEM" ? techniqueIds(`doctor:${step.id}`) : [];
    results.push({ id: step.id, title: step.title, ...r, ...(techniques.length ? { techniques } : {}) });
  }
  const cause = results.find((x) => x.verdict === "PROBLEM");
  return { modId: ctx.modId, folder: ctx.folder, connected: ctx.connected, cause: cause ? cause.id : null,
    next: cause ? cause.next : null, steps: results };
}
