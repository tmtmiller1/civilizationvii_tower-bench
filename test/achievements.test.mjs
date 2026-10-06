import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { achievementsRefusal, appOption, processStart } from "../lib/achievements.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-achievements-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A user folder whose AppOptions.txt holds `text`, last written `ageMs` before now. */
function userDir(name, text, ageMs = 0) {
  const user = path.join(tmp, name);
  fs.mkdirSync(user, { recursive: true });
  const file = path.join(user, "AppOptions.txt");
  fs.writeFileSync(file, text);
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
  return { user };
}

const TUNER_ON = "[Debug]\n;Enable FireTuner. 1 : Enable, 2: Disable, -1 : Default\nEnableTuner 1\n";
const launchedHourAgo = { pid: 1, startedAt: () => Date.now() - 3_600_000 };

test("appOption reads the last uncommented setting and ignores comments", () => {
  const text = ";EnableTuner 1\nEnableTuner 2\r\n  EnableTuner   1 ; trailing\n;AchievementsRestrictedByTuner 0\n";
  assert.equal(appOption(text, "EnableTuner"), "1");
  assert.equal(appOption(text, "AchievementsRestrictedByTuner"), null);
  assert.equal(appOption("EnableTunerX 1", "EnableTuner"), null);
});

test("a game launched with the tuner on, after AppOptions was written, may be changed", () => {
  assert.equal(achievementsRefusal(userDir("ok", TUNER_ON, 7_200_000), launchedHourAgo), null);
  // The game rewrites the file as it starts: a write a few seconds after launch is still the launch.
  const startup = { pid: 1, startedAt: () => Date.now() - 5_000 };
  assert.equal(achievementsRefusal(userDir("startup", TUNER_ON), startup), null);
});

test("the tuner off, at its default, commented out or missing is refused", () => {
  for (const [name, text] of [["off", "EnableTuner 2\n"], ["default", "EnableTuner -1\n"], ["commented", ";EnableTuner 1\n"],
    ["missing", "[Debug]\n"]]) {
    assert.match(achievementsRefusal(userDir(name, text, 7_200_000), launchedHourAgo) ?? "", /Set "EnableTuner 1"/, name);
  }
});

test("lifting the tuner's achievement restriction is refused", () => {
  const dir = userDir("lifted", `${TUNER_ON}AchievementsRestrictedByTuner 0\n`, 7_200_000);
  assert.match(achievementsRefusal(dir, launchedHourAgo) ?? "", /AchievementsRestrictedByTuner 0/);
});

test("an AppOptions edit after launch, an unknown launch time and an unreadable file are refused", () => {
  assert.match(achievementsRefusal(userDir("edited", TUNER_ON), launchedHourAgo) ?? "", /changed after the game launched/);
  const dir = userDir("unknown", TUNER_ON, 7_200_000);
  assert.match(achievementsRefusal(dir, { pid: null }) ?? "", /cannot tell when the game was launched/);
  assert.match(achievementsRefusal(dir, { pid: 1, startedAt: () => null }) ?? "", /cannot tell when the game was launched/);
  assert.match(achievementsRefusal({ user: path.join(tmp, "nowhere") }, launchedHourAgo) ?? "", /cannot read/);
});

test("processStart reads this process's start time, before now", () => {
  const t = processStart(process.pid);
  if (t === null) return; // no ps on this platform
  assert.ok(t <= Date.now() && t > Date.now() - 86_400_000);
});
