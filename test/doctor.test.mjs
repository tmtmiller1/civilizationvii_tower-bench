import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Bench } from "../lib/bench.mjs";
import { DOCTOR_STEPS, attribution, modLines, runDoctor } from "../lib/doctor.mjs";
import { parseLine } from "../lib/logs.mjs";
import { DOCTOR_COMMANDS, printDoctor } from "../lib/cli/doctor.mjs";

const WS = "/S/steamapps/workshop/content/1295660";
const MODINFO = `<?xml version="1.0" encoding="utf-8"?>
<Mod id="sample-mod" version="1">
  <ActionCriteria><Criteria id="always"><AlwaysMet/></Criteria></ActionCriteria>
  <ActionGroups>
    <ActionGroup id="sample-game" scope="game" criteria="always">
      <Actions>
        <UpdateDatabase><Item>data/sample-units.xml</Item></UpdateDatabase>
        <UIScripts><Item>ui/sample-panel.js</Item></UIScripts>
      </Actions>
    </ActionGroup>
  </ActionGroups>
</Mod>`;

const sql = (s) => `'${s.replaceAll("'", "''")}'`;

/**
 * A user folder with a registry, a logs folder and the mod's source. `copies` are [path, disabled] rows for the
 * id sample-mod; the game is never connected unless the test fakes it.
 */
function sandbox(copies) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-doctor-"));
  const user = path.join(dir, "user");
  const local = path.join(user, "Mods", "sample-mod");
  for (const d of [path.join(local, "data"), path.join(local, "ui"), path.join(user, "Logs")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(local, "sample-mod.modinfo"), MODINFO);
  fs.writeFileSync(path.join(local, "data", "sample-units.xml"), "<Database/>");
  fs.writeFileSync(path.join(local, "ui", "sample-panel.js"), "export {};\n");
  const db = path.join(user, "Mods.sqlite");
  const rows = copies.map(([p, disabled], i) => ({ p: p.replace("$LOCAL", local), disabled, i: i + 1 }));
  execFileSync("sqlite3", [db, `
    CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT, LastWriteTime INTEGER);
    CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ScannedFileRowId INTEGER, ModId TEXT, Version INTEGER, Disabled BOOLEAN);
    CREATE TABLE ModProperties(ModRowId INTEGER, Name TEXT, Value TEXT);
    CREATE TABLE LocalizedText(ModRowId INTEGER, Locale TEXT, Tag TEXT, Text TEXT);
    ${rows.map((r) => `INSERT INTO ScannedFiles VALUES (${r.i}, ${sql(r.p)}, 0);
      INSERT INTO Mods VALUES (${r.i}, ${r.i}, 'sample-mod', 1, ${r.disabled === null ? "NULL" : r.disabled});`).join("\n")}`]);
  const paths = { user, modsDb: db, userMods: path.join(user, "Mods"), logs: path.join(user, "Logs"),
    evidence: path.join(dir, "tb", "evidence"), cdpPort: 1, install: null };
  const bench = new Bench(paths);
  bench.status = async () => ({ connected: false });
  return { bench, paths, local, dir };
}

const ONE_LOCAL = [["$LOCAL/sample-mod.modinfo", 0]];
const verdicts = (r) => Object.fromEntries(r.steps.map((s) => [s.id, s.verdict]));
const stepOf = (r, id) => r.steps.find((x) => x.id === id) ?? { summary: "", notes: [] };
const REGISTRY = DOCTOR_STEPS.find((x) => x.id === "registry");

test("two enabled copies is the first cause, with the command that keeps one; later steps are not run", async () => {
  const s = sandbox([["$LOCAL/sample-mod.modinfo", 0], [`${WS}/111/sample-mod.modinfo`, 0]]);
  const r = await runDoctor(s.bench, { dir: s.local });
  assert.equal(r.cause, "registry");
  assert.match(r.next ?? "", /^tower-bench mods live sample-mod Mods\/sample-mod --yes/);
  assert.equal(r.steps.length, DOCTOR_STEPS.length);
  const after = r.steps.slice(r.steps.findIndex((x) => x.id === "registry") + 1);
  assert.ok(after.every((x) => x.verdict === "SKIPPED" && /found a cause first/.test(x.summary)));
});

test("a Workshop copy shadowing the local one, a disabled mod and an unregistered id are each the cause", async () => {
  const ws = sandbox([["$LOCAL/sample-mod.modinfo", 1], [`${WS}/111/sample-mod.modinfo`, 0]]);
  const r1 = await runDoctor(ws.bench, { dir: ws.local });
  assert.match(stepOf(r1, "registry").summary, /Workshop 111: Steam owns it/);
  assert.match(r1.next ?? "", /mods live sample-mod Mods\/sample-mod/);
  const off = sandbox([["$LOCAL/sample-mod.modinfo", 1]]);
  assert.match((await runDoctor(off.bench, { dir: off.local })).next ?? "", /mods on sample-mod --yes/);
  const none = sandbox([]);
  assert.match(stepOf(await runDoctor(none.bench, { dir: none.local }), "registry").summary, /never registered/);
});

test("a nested build copy that is live is the cause", async () => {
  const s = sandbox([["$LOCAL/sample-mod.modinfo", 1], ["$LOCAL/dist/sample-mod/sample-mod.modinfo", 0]]);
  const r = await runDoctor(s.bench, { dir: s.local });
  assert.match(stepOf(r, "registry").summary, /build output/);
});

test("offline, a clean in-place mod skips the live checks and reads its own log lines", async () => {
  const s = sandbox(ONE_LOCAL);
  const r = await runDoctor(s.bench, { dir: s.local, all: true });
  const v = verdicts(r);
  assert.equal(v.registry, "OK");
  assert.equal(v.preflight, "SKIPPED", "no game install in the sandbox");
  assert.equal(v.live, "SKIPPED");
  assert.match(stepOf(r, "live").summary, /not connected/);
  assert.equal(v.logs, "OK");
  assert.equal(v.running, "SKIPPED");
  assert.equal(r.cause, null);
});

test("a source folder ahead of the live copy is a PROBLEM with the deploy command", async () => {
  const s = sandbox(ONE_LOCAL);
  const src = path.join(s.dir, "src");
  fs.cpSync(s.local, src, { recursive: true });
  fs.writeFileSync(path.join(src, "ui", "sample-panel.js"), "export const edited = 1;\n");
  const r = await runDoctor(s.bench, { dir: src, all: true });
  const live = r.steps.find((x) => x.id === "live");
  assert.equal(live?.verdict, "PROBLEM");
  assert.match(live?.summary ?? "", /1 file\(s\) in Mods\/sample-mod differ from your source: ui\/sample-panel\.js/);
  assert.match(live?.next ?? "", /tower-bench deploy .* --yes/);
  assert.match(stepOf(r, "registry").notes?.[0] ?? "", /you edit a source folder/);
});

test("a database rollback naming the mod's file is the cause, read as one incident", async () => {
  const s = sandbox(ONE_LOCAL);
  fs.writeFileSync(path.join(s.paths.logs, "Modding.log"), [
    "[2026-01-10 12:00:00]\tApplying mod components.",
    "[2026-01-10 12:00:01]\tThere were errors loading 'data/sample-units.xml' that require a rollback.",
    "[2026-01-10 12:00:01]\tErrors when applying action 'sample-game (UpdateDatabase)'. Rollback Required.",
    "[2026-01-10 12:00:01]\tFailed to apply enabled components.",
    "[2026-01-10 12:00:01]\tThere were errors loading 'data/other.xml' that require a rollback.",
  ].join("\n") + "\n");
  const r = await runDoctor(s.bench, { dir: s.local });
  assert.equal(r.cause, "logs");
  const logs = r.steps.find((x) => x.id === "logs");
  assert.match(logs?.summary ?? "", /sample-units\.xml/);
  assert.equal(logs?.notes?.length, 2, "the action and the outcome lines ride with the file line");
  assert.equal(logs?.data.lines.length, 1, "the other mod's rollback is not attributed");
});

test("connected: stale files and a mod the running game did not apply are causes", async () => {
  const s = sandbox(ONE_LOCAL);
  s.bench.status = async () => ({ connected: true });
  s.bench.prove = async () => ({ files: [{ rel: "ui/sample-panel.js", live: "STALE" }] });
  s.bench.registry = async () => ({ active: { onlyNext: ["sample-mod"], onlyNow: [] }, controls: [] });
  const r = await runDoctor(s.bench, { dir: s.local, all: true });
  const v = verdicts(r);
  assert.equal(v.live, "PROBLEM");
  assert.equal(v.running, "PROBLEM");
  assert.equal(r.cause, "live");
  assert.match(r.steps.find((x) => x.id === "running")?.summary ?? "", /not applied/);
  const off = await runDoctor(s.bench, { dir: s.local, offline: true, all: true });
  assert.equal(verdicts(off).running, "SKIPPED", "--offline never asks the game");
});

test("the step list is extensible and a step that throws is SKIPPED, not fatal", async () => {
  const s = sandbox(ONE_LOCAL);
  const steps = [/** @type {any} */ (REGISTRY),
    { id: "custom", title: "Custom", run: () => ({ verdict: "PROBLEM", summary: "custom cause", next: "fix it" }) },
    { id: "boom", title: "Boom", run: () => { throw new Error("broken"); } }];
  const r = await runDoctor(s.bench, { dir: s.local, steps, all: true });
  assert.deepEqual(r.steps.map((x) => x.verdict), ["OK", "PROBLEM", "SKIPPED"]);
  assert.equal(r.next, "fix it");
  assert.match(r.steps[2].summary, /could not run: broken/);
});

test("log attribution: the mod's URL root, its files, its action groups, its id", () => {
  const who = { modId: "sample-mod", items: ["sample-mod.modinfo", "data/sample-units.xml"], groups: ["sample-game"] };
  const line = (text) => parseLine("UI.log", text);
  assert.equal(attribution(line("TypeError: x at fs://game/sample-mod/ui/a.js:1"), who), "fs://game/sample-mod/");
  assert.equal(attribution(line("issues loading 'data/sample-units.xml'"), who), "data/sample-units.xml");
  assert.equal(attribution(line("from 'sample-game (UpdateText)'"), who), "action group sample-game");
  assert.equal(attribution(line("Error: sample-mod failed"), who), "sample-mod");
  assert.equal(attribution(line("Error: sample-mod-extra failed"), who), null, "a longer id is another mod");
  const hits = modLines([line("Warning: sample-mod: x"), line("TypeError at fs://game/sample-mod/ui/a.js")], who);
  assert.equal(hits[0].severity, "error", "errors first");
});

test("the CLI prints one line per step and exits 1 when a cause is found", async (t) => {
  const s = sandbox([]);
  const lines = [];
  t.mock.method(console, "log", (x) => lines.push(x));
  await DOCTOR_COMMANDS.doctor({ bench: s.bench, paths: s.paths, opt: { offline: true } }, [s.local], "doctor");
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
  const text = lines.join("\n");
  assert.match(text, /PROBLEM {2}Which copy the game loads: the game has never registered/);
  assert.match(text, /first cause: Which copy the game loads/);
  await assert.rejects(Promise.resolve(DOCTOR_COMMANDS.doctor({ bench: s.bench, paths: s.paths, opt: {} }, [], "doctor")), /which mod folder/);
  lines.length = 0;
  printDoctor({ modId: "x", folder: "/x", connected: false, cause: null, next: null, steps: [] });
  assert.match(lines.join("\n"), /no cause found/);
});
