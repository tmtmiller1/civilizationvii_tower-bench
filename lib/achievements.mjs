// Achievements: the game does not unlock them while the FireTuner is enabled ("EnableTuner 1" in AppOptions.txt; the
// file's own comment for AchievementsRestrictedByTuner, and the Options screen's "Tuner (Disables Achievements)"). The
// bench only changes a game that was launched that way, so nothing it does can count toward an achievement.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// The game rewrites AppOptions.txt as it starts, so the file's time sits at the launch; a later time is an edit the
// running game has not read.
const STARTUP_WRITE_GRACE_MS = 60_000;

/** The value of the last uncommented "<key> <value>" line, or null. */
export function appOption(text, key) {
  let value = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z]\w*)\s+(\S+)/);
    if (m && m[1] === key) value = m[2];
  }
  return value;
}

/** When the process started, in ms since the epoch, or null when it cannot be read (no `ps`, process gone). */
export function processStart(pid) {
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const t = Date.parse((r.stdout ?? "").trim());
  return Number.isFinite(t) ? t : null;
}

/**
 * Why the running game might be earning achievements, or null when it cannot be.
 * @param {{ user: string }} paths
 * @param {{ pid: number | null, startedAt?: (pid: number) => number | null }} game
 */
export function achievementsRefusal(paths, { pid, startedAt = processStart }) {
  const file = path.join(paths.user, "AppOptions.txt");
  let text;
  let mtime;
  try {
    text = fs.readFileSync(file, "utf8");
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return `cannot read ${file}, so cannot tell whether this game earns achievements`;
  }
  if (appOption(text, "EnableTuner") !== "1") {
    return `this game may be earning achievements. Set "EnableTuner 1" in ${file} and relaunch the game: the game `
      + "does not unlock achievements while the tuner is enabled";
  }
  if (appOption(text, "AchievementsRestrictedByTuner") === "0") {
    return `"AchievementsRestrictedByTuner 0" in ${file} lets this game earn achievements with the tuner on; remove it `
      + "and relaunch the game";
  }
  const started = pid ? startedAt(pid) : null;
  if (started === null) return "cannot tell when the game was launched, so cannot tell whether the tuner setting is in effect";
  if (mtime > started + STARTUP_WRITE_GRACE_MS) {
    return `${file} changed after the game launched; relaunch the game so its tuner setting is the one in effect`;
  }
  return null;
}
