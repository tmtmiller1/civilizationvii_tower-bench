// MCP tools that read files only: the game's logs, its mod registry, crash reports, mod folders, the
// techniques library and the bench's own evidence. They work with the game closed.
import { analyseConflicts, analyseMod } from "./analysis.mjs";
import { crashDirs, crashSupported, crashTriage, listCrashes, UNSUPPORTED } from "./crash.mjs";
import { describeDbDiff, diffDatabases } from "./dbdiff.mjs";
import { runDoctor } from "./doctor.mjs";
import { localDate } from "./evidence.mjs";
import { readRecent } from "./logs.mjs";
import { filterMods, modHealth, readMods } from "./mods.mjs";
import { impactGame } from "./patch.mjs";
import { libraryWithRuns, loadTechniques, searchTechniques } from "./techniques.mjs";
import { printCrash, printCrashList, printDoctor } from "./cli/doctor.mjs";
import { printCheck } from "./cli/inspect.mjs";
import { withProofs } from "./cli/labtools.mjs";
import { S, STATIC_NOTE, captureOut } from "./mcp-common.mjs";

/** @typedef {import("./mcp-common.mjs").ToolDef} ToolDef */

const LOG_RANK = { noise: 0, info: 1, warn: 2, error: 3 };
const LEVELS = { high: ["High"], medium: ["High", "Medium"], low: ["High", "Medium", "Low"] };

/** The CLI's own printer output as the tool text. */
const printed = async (fn) => (await captureOut(fn)).text;

function logLine(l) {
  const t = l.techniques?.length ? `  [techniques: ${l.techniques.join(", ")}]` : "";
  return `[${l.severity}] ${l.file}: ${l.text.trim()}${l.hint ? `\n    ${l.hint}` : ""}${t}`;
}

function conflictLine(c) {
  const proof = c.proof ? `  [${c.proof.label}]` : "";
  return `${c.severity} ${c.a} / ${c.b}: ${c.text}${proof}${c.prove ? `\n    prove: tower-bench ${c.prove}` : ""}`
    + `${c.techniques?.length ? `\n    fix: techniques ${c.techniques.join(", ")}` : ""}`;
}

function impactText(r, level) {
  const keep = LEVELS[level] ?? LEVELS.medium;
  const lines = [`game ${r.from} -> ${r.to}: ${r.affected} of ${r.checked} mod(s) affected`];
  if (r.schemaNote) lines.push(`database not compared: ${r.schemaNote}`);
  for (const m of r.mods) {
    for (const f of m.findings.filter((x) => keep.includes(x.severity))) {
      lines.push(`${m.id}: ${f.severity} ${f.text}\n    was ${f.was}\n    now ${f.now}\n    fix: ${f.fix}`);
    }
  }
  return lines.join("\n");
}

function evidenceLine(e) {
  const verdict = e.result?.verdict ?? e.result?.outcome ?? e.result?.error ?? "";
  return `${e.ts.slice(11, 19)}  ${e.kind}  ${JSON.stringify(e.request ?? {}).slice(0, 120)}  ${verdict}`;
}

/** @type {ToolDef[]} */
export const FILE_TOOLS = [
  {
    name: "logs_recent", title: "Recent game log lines", gate: "read",
    description: "The tail of UI.log, Modding.log, Database.log and Scripting.log, each line classified (noise, info, "
      + "warn, error) with a hint and the techniques that fix known failures. Read this before theorising about a fault.",
    input: { level: { type: "string", enum: ["noise", "info", "warn", "error"], description: "minimum (default warn)" },
      mod: { type: "string", description: "only lines attributed to this mod id" },
      kb: { type: "integer", minimum: 1, maximum: 4096, description: "how far back to read per file (default 256)" },
      limit: S.limit(200, 2000) },
    run: ({ paths }, { level = "warn", mod, kb = 256, limit = 200 }) => {
      const lines = readRecent(paths.logs, undefined, kb * 1024)
        .filter((l) => LOG_RANK[l.severity] >= LOG_RANK[level] && (!mod || l.mod === mod)).slice(-limit);
      return { text: lines.length ? lines.map(logLine).join("\n") : `no ${level}-or-worse lines in the last ${kb} KB`, data: lines };
    },
  },
  {
    name: "mods_list", title: "Installed mods", gate: "read",
    description: "Every mod id in the game's registry (Mods.sqlite): enabled or not, its copies and which copy is live, "
      + "and notes such as duplicate copies shadowing each other. Without all or filter, only mods with notes.",
    input: { all: { type: "boolean" }, filter: { type: "string", description: "match id, name or author" } },
    run: ({ paths }, { all = false, filter }) => {
      const mods = modHealth(readMods(paths.modsDb), paths);
      const matched = filterMods(mods, filter);
      const shown = all || filter ? matched : matched.filter((m) => m.issues.length);
      return { text: `${mods.length} mod ids, ${mods.filter((m) => m.enabled).length} enabled, `
        + `${mods.filter((m) => m.issues.length).length} with notes; showing ${shown.length}`, data: shown };
    },
  },
  {
    name: "mods_conflicts", title: "Conflicts among enabled mods", gate: "read",
    description: `Static conflicts among the mods the game will load, each with the command that proves it and the `
      + `techniques that fix it. ${STATIC_NOTE}`,
    input: { all: { type: "boolean", description: "every installed copy, not just enabled ones" },
      level: { type: "string", enum: ["high", "medium", "low"], description: "lowest severity in the text (default medium)" },
      schema: { type: "string", description: "a folder holding a saved Debug database copy" } },
    run: ({ paths }, { all = false, level = "medium", schema }) => {
      const r = analyseConflicts(paths, { all, schemaDir: schema });
      r.conflicts = withProofs(paths, r.conflicts);
      const shown = r.conflicts.filter((c) => LEVELS[level].includes(c.severity));
      const head = `${r.mods} mod folder(s) against game ${r.gameVersion}: ${r.conflicts.length} conflict(s), `
        + `${shown.length} at ${level} or above. Read from files, not run.`;
      return { text: [head, r.schemaNote ? `database checks skipped: ${r.schemaNote}` : "", ...shown.map(conflictLine)]
        .filter(Boolean).join("\n"), data: r };
    },
  },
  {
    name: "check_mod", title: "Pre-flight one mod", gate: "read",
    description: `Will this mod start a game on the installed version? Its defects and its conflicts with the mods `
      + `the game will load alongside it. ${STATIC_NOTE}`,
    input: { folder: S.folder, schema: { type: "string", description: "a folder holding a saved Debug database copy" } },
    required: ["folder"],
    run: async ({ paths }, { folder, schema }) => {
      const r = analyseMod(paths, folder, { schemaDir: schema });
      return { text: await printed(() => printCheck(r)), data: r };
    },
  },
  {
    name: "doctor", title: "My mod does not work", gate: "read",
    description: "Runs the checks in order (which copy is live, pre-flight, is the edit live, its log lines, the running "
      + "game, conflicts) and stops at the first cause with the next action. Reads the game; changes nothing.",
    input: { folder: S.folder, all: { type: "boolean", description: "run every step" },
      offline: { type: "boolean", description: "skip the steps that need the game" } },
    required: ["folder"],
    run: async ({ bench }, { folder, all = false, offline = false }) => {
      const r = await runDoctor(bench, { dir: folder, all, offline });
      return { text: await printed(() => printDoctor(r)), data: r };
    },
  },
  {
    name: "crash_triage", title: "Triage a crash report", gate: "read",
    description: "The newest crash report (or one named): signature, repeats, the logs the run left, the mods it "
      + "applied, and the bisect command that isolates it. Isolation, not a plausible story, decides the cause.",
    input: { file: { type: "string", description: "an .ips path; default the newest" },
      incident: { type: "string", description: "an incident id from crash_list" } },
    run: async ({ paths }, { file, incident }) => {
      const r = crashTriage(paths, { file, incident });
      return { text: await printed(() => printCrash(r)), data: r };
    },
  },
  {
    name: "crash_list", title: "Recent crash reports", gate: "read",
    description: "Recent Civilization VII crash reports with their signatures and repeat counts.",
    input: { limit: S.limit(20, 200) },
    run: async ({ paths }, { limit = 20 }) => {
      if (!crashSupported()) return { text: UNSUPPORTED, data: [] };
      const reports = listCrashes(crashDirs(paths)).reports.slice(0, limit);
      return { text: await printed(() => printCrashList(reports)), data: reports };
    },
  },
  {
    name: "game_impact", title: "Which mods a game update breaks", gate: "read",
    description: `Compares two game indexes and reports, per mod, each fact the update changed under it, with a fix. `
      + `${STATIC_NOTE}`,
    input: { folders: { type: "array", items: { type: "string" }, description: "mod folders; default the enabled mods" },
      mods: { type: "string", enum: ["enabled", "all"] }, from: { type: "string" }, to: { type: "string" },
      level: { type: "string", enum: ["high", "medium", "low"] } },
    run: ({ paths }, { folders, mods = "enabled", from, to, level }) => {
      const r = impactGame(paths, { mods: folders?.length ? folders : [mods], from, to });
      return { text: impactText(r, level), data: r };
    },
  },
  {
    name: "dbdiff_files", title: "Diff two SQLite databases", gate: "read",
    description: "Rows added, removed and changed per table between two SQLite files, such as two saved copies of "
      + "Debug/gameplay-copy.sqlite (the compiled database a game actually loaded).",
    input: { a: { type: "string" }, b: { type: "string" }, limit: S.limit(5, 200),
      tables: { type: "array", items: { type: "string" } } },
    required: ["a", "b"],
    run: (_ctx, { a, b, limit = 5, tables }) => {
      const d = diffDatabases(a, b, { limit, tables });
      return { text: describeDbDiff(d, { limit }), data: d };
    },
  },
  {
    name: "techniques_search", title: "Search techniques", gate: "read",
    description: "Techniques that work in Civilization VII mods, and patterns to avoid, by purpose or engine object.",
    input: { query: { type: "string" } },
    run: (_ctx, { query: q = "" }) => {
      const hits = searchTechniques(q);
      return { text: hits.map((t) => `${t.id}: ${t.title}: ${t.purpose}`).join("\n") || "no technique matches", data: hits };
    },
  },
  {
    name: "techniques_show", title: "One technique", gate: "read",
    description: "One technique: why it works, when to use it and not, a snippet, pitfalls, and whether the bench has "
      + "watched it work on the current game.",
    input: { id: { type: "string" } }, required: ["id"],
    run: ({ paths }, { id }) => {
      const t = libraryWithRuns(paths, loadTechniques()).entries.find((x) => x.id === id);
      return t ? { text: `${t.title} (${t.id})`, data: t } : { text: `no technique "${id}"`, isError: true };
    },
  },
  {
    name: "evidence_today", title: "What the bench did today", gate: "read",
    description: "The evidence log: every change the bench made with its verdict, and every MCP call.",
    input: { date: { type: "string", description: "YYYY-MM-DD, default today" }, limit: S.limit(100, 2000) },
    run: ({ bench }, { date = localDate(), limit = 100 }) => {
      const entries = bench.evidence.read(date).slice(-limit);
      return { text: entries.map(evidenceLine).join("\n") || `no entries on ${date}`, data: entries };
    },
  },
  {
    name: "deploy_plan", title: "What deploy would copy", gate: "read",
    description: "Which copy of the mod the game loads and which files differ from the source folder. Copies nothing.",
    input: { folder: S.folder }, required: ["folder"],
    run: ({ bench }, { folder }) => {
      const p = bench.planFor(folder);
      const changes = p.changes ?? [];
      const head = p.refuse ? `refused: ${p.refuse}` : `${p.modId}: live copy ${p.liveLabel ?? "?"}`;
      return { text: [head, ...changes.map((c) => `would copy (${c.state}) ${c.rel}`)].join("\n"), data: p };
    },
  },
];
