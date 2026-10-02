// The real machine behind a nightly run: the lab for games, the patch module for indexes, the static checks,
// the logs and crash triage. runNightly takes these as `d`; tests pass fakes instead.
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { analyseMod } from "./analysis.mjs";
import { BenchError } from "./bench.mjs";
import { crashTriage } from "./crash.mjs";
import { readModinfo } from "./deploy.mjs";
import { modLines } from "./doctor.mjs";
import { l10nCheck } from "./l10n.mjs";
import { Lab, gamePid, otherHarnesses, preflight } from "./lab.mjs";
import { DEFAULT_LOGS, readRecent } from "./logs.mjs";
import { latestReport, writeReportFiles } from "./nightly-report.mjs";
import { readRecipeFile } from "./nightly-suite.mjs";
import { diffGame, impactGame, snapshotGame, versionChanged } from "./patch.mjs";
import { runRecipe } from "./recipes.mjs";
import { Schema, Vanilla } from "./static/game.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const messageOf = (e) => (e instanceof Error ? e.message : String(e));
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

/**
 * Whether the user's Debug copy of the gameplay database was written by this install. The same rule
 * snapshotGame applies before it reads a schema: a copy older than the install's Info.plist describes the
 * previous version.
 */
export function debugFresh(paths) {
  const db = mtime(path.join(paths.user, "Debug", Schema.DBS.gameplay));
  const plist = mtime(path.join(paths.install ?? "", "Contents", "Info.plist"));
  return db > 0 && db >= plist;
}

/** The newest save or autosave file under Saves/, by modification time (ms), or 0. Two levels deep. */
export function newestSave(paths) {
  const root = path.join(paths.user, "Saves");
  let newest = 0;
  const visit = (dir, depth) => {
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 2) visit(p, depth + 1);
      else if (e.isFile()) newest = Math.max(newest, mtime(p));
    }
  };
  visit(root, 0);
  return newest;
}

const NIGHTLY = "tower-bench(\\.mjs)?\\s+nightly\\s+run\\b";

/**
 * The lab's preflight plus what only a nightly needs: no lab run on file, no other nightly, and no save
 * written in the last `quietMinutes` (someone is playing).
 * @param {any} paths @param {{ current: any }} lab
 * @param {{ quietMinutes?: number, now?: number, ps?: string }} [opts]
 */
export function nightlySafety(paths, lab, { quietMinutes = 30, now = Date.now(), ps } = {}) {
  const pf = preflight(paths);
  const problems = [...pf.problems];
  if (lab.current) problems.push(`a lab run is in progress (${lab.current.dir}); "lab stop" first`);
  const psOut = ps ?? spawnSync("ps", ["-Ao", "pid=,ppid=,args="], { encoding: "utf8" }).stdout;
  const others = otherHarnesses(psOut, process.pid, NIGHTLY);
  if (others.length) problems.push(`another nightly run is active: ${others[0].slice(0, 120)}`);
  const last = newestSave(paths);
  if (quietMinutes > 0 && last && now - last < quietMinutes * 60000) {
    const ago = Math.max(0, Math.round((now - last) / 60000));
    problems.push(`a save was written ${ago} minute(s) ago; someone may be playing (quiet period ${quietMinutes} min)`);
  }
  return { problems, warnings: pf.warnings };
}

/** Error and warning lines the logs of the last game attribute to the mod in `folder`. */
export function modLogLines(paths, folder, bytes = 2 * 1024 * 1024) {
  const info = readModinfo(folder);
  let groups = [];
  try {
    const xml = fs.readFileSync(path.join(folder, info.file), "utf8");
    groups = [...xml.matchAll(/<ActionGroup\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  } catch { /* the id is enough */ }
  const who = { modId: info.id, items: [info.file, ...info.items], groups };
  const hits = modLines(readRecent(paths.logs, DEFAULT_LOGS, bytes), who);
  const line = (h) => ({ file: h.file, text: h.text.trim().slice(0, 400), why: h.why });
  return { modId: info.id, errors: hits.filter((h) => h.severity === "error").slice(0, 10).map(line),
    warnings: hits.filter((h) => h.severity === "warn").length };
}

/** Escapes text for an AppleScript string literal. */
export const appleString = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ")}"`;

export function notifyMac(title, text, exec = execFile) {
  if (process.platform !== "darwin") return Promise.resolve(false);
  const script = `display notification ${appleString(text)} with title ${appleString(title)}`;
  return new Promise((resolve) => { exec("osascript", ["-e", script], (err) => resolve(!err)); });
}

/** Quits the lab's game and restores; a game the lab did not start is refused, never killed. */
async function endLabGame(bench, lab, dir, log) {
  const q = await lab.quit({ log, onlyPid: lab.current?.pid ?? null }).catch((e) => {
    throw new BenchError(`${messageOf(e)}; your files and mods are not restored yet: run "tower-bench lab stop"`);
  });
  if (!q.wasRunning) {
    log("the game had already exited; waiting 50 s for a crash report to land");
    await wait(50000);
  }
  const rep = lab.restore(dir);
  lab.setCurrent(null);
  return { rep, exited: !q.wasRunning };
}

/** Refuses while the game runs or a run is on file, then backs up and records the run. Returns its folder. */
function beginLabRun(paths, lab, { seed, age }) {
  if (lab.current) throw new BenchError(`a test run is already in progress (${lab.current.dir})`);
  const pf = preflight(paths);
  if (pf.problems.length) throw new BenchError(pf.problems.join("; "));
  const dir = path.join(lab.root, `nightly-${stamp()}`);
  lab.backup(dir);
  lab.setCurrent({ dir, startedAt: new Date().toISOString(), seed: seed ?? null, age: age ?? null, nightly: true });
  return dir;
}

/** `lab run` semantics: back up, start a seeded game, run the recipe and extra turns, quit, restore. */
async function labGame(bench, lab, { recipe, seed, age, turns, label }, log) {
  const dir = beginLabRun(bench.paths, lab, { seed, age });
  /** @type {any} */
  let out = { passed: !recipe, results: [], error: null };
  try {
    const g = await lab.startNewGame({ seed, age, log });
    lab.setCurrent({ ...lab.current, pid: g.pid });
    bench.armed = true;
    const endTurns = (n) => lab.endTurns(n, { log });
    if (recipe) out = { ...out, ...(await runRecipe(bench, recipe, { endTurns, log })) };
    if (turns) await lab.endTurns(turns, { log });
  } catch (e) {
    out.error = messageOf(e);
  } finally {
    bench.armed = false;
    bench.cdp.close();
  }
  const { rep, exited } = await endLabGame(bench, lab, dir, log);
  if (exited && !out.error) out.error = "the game exited before the run ended";
  const result = { passed: out.passed, error: out.error, exited, crashReports: rep.crashReports,
    restored: rep.restored };
  bench.log({ kind: "nightly-game", request: { label, seed: seed ?? null, age: age ?? null, turns }, result });
  return { ...out, crashReports: rep.crashReports, exited, restore: rep };
}

/**
 * @param {import("./bench.mjs").Bench} bench
 * @param {{ log?: (line: string) => void, lab?: Lab }} [opts]
 */
export function realDeps(bench, { log = () => {}, lab = new Lab(bench.paths) } = {}) {
  const paths = bench.paths;
  let vanilla;
  const game = () => {
    if (vanilla !== undefined) return vanilla;
    vanilla = paths.install && fs.existsSync(paths.install) ? Vanilla.load(paths.install) : null;
    return vanilla;
  };
  return {
    paths, log, lab,
    now: () => new Date(),
    versionChanged: () => versionChanged(paths),
    debugFresh: () => debugFresh(paths),
    safety: ({ quietMinutes }) => nightlySafety(paths, lab, { quietMinutes }),
    gameRunning: () => !!gamePid(),
    labGame: (o) => labGame(bench, lab, o, log),
    snapshot: (version) => snapshotGame(bench, { version }),
    diff: (from, to) => diffGame(paths, { from, to }),
    // A missing folder would fail the whole impact; the pre-flight check reports it for that mod instead.
    impact: (from, to, folders) => impactGame(paths, { mods: folders.filter((f) => fs.existsSync(f)), from, to }),
    check: (folder) => analyseMod(paths, folder),
    l10n: (folder) => l10nCheck(bench, { dir: folder, vanilla: game() }),
    modLogs: (folder) => modLogLines(paths, folder),
    crashTriage: (file) => crashTriage(paths, { file }),
    readRecipe: readRecipeFile,
    identify: (folder) => { try { return readModinfo(folder).id; } catch { return null; } },
    previousReport: () => latestReport(paths),
    writeReport: (report) => writeReportFiles(paths, report),
    notify: (title, text) => notifyMac(title, text),
    benchLog: (entry) => bench.log(entry),
  };
}
