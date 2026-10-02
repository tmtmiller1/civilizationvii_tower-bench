import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runNightly, updateWanted } from "../lib/nightly.mjs";
import { appleString, newestSave, notifyMac } from "../lib/nightly-deps.mjs";
import { compareReports, finishMod, listReports, reportHtml, reportMarkdown, writeReportFiles } from "../lib/nightly-report.mjs";
import { initSuite, loadSuite, resolveSuite, sampleRecipe, starterSuite, validateSuite } from "../lib/nightly-suite.mjs";
import { validateRecipe } from "../lib/recipes.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tb-nightly-"));

function modDir(root, id) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.modinfo`), `<Mod id="${id}" version="1"><ActionGroup id="g-${id}"/></Mod>`);
  return dir;
}

const suiteOf = (folders, over = {}) => ({ file: "/suite.json", name: null, quietMinutes: 30,
  mods: folders.map((folder) => ({ folder, recipes: [`${folder}/r.json`], seed: 1, age: null, turns: 0,
    checks: ["check", "l10n", "impact", "recipes", "logs"], ...over })) });

/** A machine where everything passes; tests override one piece at a time. */
function fakeDeps(over = {}) {
  const calls = [];
  const d = {
    calls, written: null, notified: null,
    log: () => {}, now: () => new Date("2026-10-02T03:00:00Z"),
    versionChanged: () => ({ changed: true, installed: "1.6.0", newest: "1.5.0" }),
    debugFresh: () => true,
    safety: () => ({ problems: [], warnings: [] }),
    gameRunning: () => false,
    labGame: async (o) => { calls.push(["lab", o.label]); return { passed: true, results: [{ step: 1, ok: true }], error: null, crashReports: [] }; },
    snapshot: (v) => { calls.push(["snapshot", v]); return { version: v, file: `/idx/${v}`, schemaNote: null }; },
    diff: (a, b) => { calls.push(["diff", a, b]); return { from: a, to: b, files: { moved: [], removed: ["x.js"], added: [], changed: [] },
      exports: [], components: { legacy: { removed: [] }, registry: { removed: [] } }, schema: { available: false, note: "n" } }; },
    impact: (a, b, folders) => { calls.push(["impact", a, b, folders.length]); return { checked: folders.length, affected: 0, failed: [], schemaNote: null, mods: [] }; },
    check: (folder) => ({ id: path.basename(folder), verdict: "CLEAN", defects: [], conflicts: [] }),
    l10n: async () => ({ findings: [] }),
    modLogs: () => ({ errors: [], warnings: 0 }),
    crashTriage: (file) => ({ crash: { signature: "sig-1", file }, next: "bisect" }),
    readRecipe: () => ({ recipe: { name: "loads", steps: [{ turns: 1 }] } }),
    identify: (folder) => path.basename(folder),
    previousReport: () => null,
    writeReport: (r) => { d.written = r; return { json: "/n/2026-10-02.json", md: "/n/x.md", html: "/n/x.html" }; },
    notify: async (title, text) => { d.notified = { title, text }; },
    benchLog: () => {},
    ...over,
  };
  return d;
}

test("--only-if-updated stops quietly when the version is unchanged, before any safety check", async () => {
  const d = fakeDeps({ versionChanged: () => ({ changed: false, installed: "1.5.0", newest: "1.5.0" }),
    safety: () => { throw new Error("must not run"); } });
  const r = await runNightly(d, { suite: suiteOf(["/m/a"]), onlyIfUpdated: true });
  assert.equal(/** @type {any} */ (r).skipped, true);
  assert.match(/** @type {any} */ (r).why, /unchanged/);
  assert.equal(d.written, null);
});

test("no index yet counts as an update (the baseline), an unreadable version does not", () => {
  assert.equal(updateWanted({ changed: false, installed: "1.5.0", newest: null }).run, true);
  assert.equal(updateWanted(null).run, false);
});

test("the night refuses to start when safety finds a problem", async () => {
  const d = fakeDeps({ safety: () => ({ problems: ["the game is running"], warnings: [] }) });
  await assert.rejects(runNightly(d, { suite: suiteOf(["/m/a"]) }), /nightly not started: the game is running/);
  assert.deepEqual(d.calls, []);
});

test("a new version is snapshotted, diffed and checked for impact against the previous index", async () => {
  const d = fakeDeps();
  const r = /** @type {any} */ (await runNightly(d, { suite: suiteOf(["/m/a", "/m/b"]) }));
  assert.deepEqual(d.calls.slice(0, 3), [["snapshot", "1.6.0"], ["diff", "1.5.0", "1.6.0"], ["impact", "1.5.0", "1.6.0", 2]]);
  assert.equal(r.game.diff.files.removed, 1);
  assert.equal(r.summary.pass, 2);
  assert.equal(d.calls.filter((c) => c[0] === "lab").length, 2);
});

test("a stale Debug copy is refreshed with one lab game before the snapshot", async () => {
  let fresh = false;
  const d = fakeDeps({ debugFresh: () => fresh });
  const lab = d.labGame;
  d.labGame = async (o) => { if (o.label === "refresh-debug") fresh = true; return lab(o); };
  const r = /** @type {any} */ (await runNightly(d, { suite: suiteOf(["/m/a"]) }));
  assert.deepEqual(d.calls[0], ["lab", "refresh-debug"]);
  assert.deepEqual(d.calls[1], ["snapshot", "1.6.0"]);
  assert.equal(r.game.debugNote, null);
});

test("a crash attaches the triage and fails the mod; a previous PASS makes it BROKE-BY-UPDATE and newly failing", async () => {
  const d = fakeDeps({
    labGame: async () => ({ passed: false, results: [], error: "the game exited during turn 3", crashReports: ["/r/CivilizationVII-1.ips"] }),
    previousReport: () => ({ game: { installed: "1.5.0" }, files: { json: "/n/old.json" }, mods: [{ id: "a", verdict: "PASS" }] }),
  });
  const r = /** @type {any} */ (await runNightly(d, { suite: suiteOf(["/m/a"]), notify: true }));
  const m = r.mods[0];
  assert.equal(m.verdict, "BROKE-BY-UPDATE");
  assert.equal(m.runs[0].crash.crash.signature, "sig-1");
  assert.match(m.reasons.join("\n"), /crashed \(CivilizationVII-1\.ips\)/);
  assert.deepEqual(r.compare.newlyFailing, ["a"]);
  assert.match(d.notified.text, /1 mod\(s\) newly failing: a/);
});

test("without an update a failure is a plain FAIL and nothing is snapshotted", async () => {
  const d = fakeDeps({ versionChanged: () => ({ changed: false, installed: "1.5.0", newest: "1.5.0" }),
    modLogs: () => ({ errors: [{ file: "UI.log", text: "TypeError in a.js" }], warnings: 0 }),
    previousReport: () => ({ game: { installed: "1.5.0" }, mods: [{ id: "a", verdict: "PASS" }] }) });
  const r = /** @type {any} */ (await runNightly(d, { suite: suiteOf(["/m/a"]) }));
  assert.equal(r.mods[0].verdict, "FAIL");
  assert.ok(!d.calls.some((c) => c[0] === "snapshot"));
  assert.equal(d.notified, null, "no notification unless asked");
});

test("the remaining lab games are skipped when the game turns up running", async () => {
  let n = 0;
  const d = fakeDeps({ gameRunning: () => n++ > 0 });
  const r = /** @type {any} */ (await runNightly(d, { suite: suiteOf(["/m/a", "/m/b"]) }));
  assert.match(r.stopped, /game was started/);
  assert.equal(r.mods[0].runs.length, 1);
  assert.equal(r.mods[1].runs.length, 0);
  assert.deepEqual(r.mods[1].notRun, ["/m/b/r.json"]);
});

test("a mod whose recipes were not reached is not counted as fixed", () => {
  const c = compareReports({ mods: [{ id: "a", verdict: "FAIL" }] }, [{ id: "a", verdict: "PASS", notRun: ["r.json"] }]);
  assert.deepEqual(c.fixed, []);
});

test("a lab game that cannot restore stops the night", async () => {
  const d = fakeDeps({ labGame: async () => { throw new Error("not restored yet"); } });
  const r = /** @type {any} */ (await runNightly(d, { suite: suiteOf(["/m/a", "/m/b"]) }));
  assert.match(r.stopped, /could not finish cleanly/);
  assert.equal(r.mods[0].verdict, "FAIL", "no previous PASS and no impact finding: not blamed on the update");
  assert.equal(r.mods[1].runs.length, 0);
});

test("static checks: BLOCKS GAME and l10n errors fail; skipped checks are not run", async () => {
  const d = fakeDeps({ versionChanged: () => ({ changed: false, installed: "1", newest: "1" }),
    check: () => ({ id: "a", verdict: "BLOCKS GAME", defects: [{ verdict: "BLOCKS GAME", rule: "r", text: "missing table" }], conflicts: [] }),
    l10n: async () => { throw new Error("must not run"); } });
  const r = /** @type {any} */ (await runNightly(d, { suite: suiteOf(["/m/a"], { checks: ["check"] }) }));
  assert.equal(r.mods[0].verdict, "FAIL");
  assert.equal(r.mods[0].l10n, null);
  assert.deepEqual(r.mods[0].runs, []);
  assert.match(r.mods[0].reasons[0], /missing table/);
});

test("a check that cannot run (the folder is gone) fails the mod", async () => {
  const d = fakeDeps({ versionChanged: () => ({ changed: false, installed: "1", newest: "1" }),
    check: () => { throw new Error("no such folder: /m/a"); } });
  const r = /** @type {any} */ (await runNightly(d, { suite: suiteOf(["/m/a"], { checks: ["check"] }) }));
  assert.equal(r.mods[0].verdict, "FAIL");
  assert.match(r.mods[0].reasons[0], /could not run: no such folder/);
  const prev = { game: { installed: "0.9" }, mods: [{ id: "a", folder: "/m/a", verdict: "PASS" }] };
  const e = { id: null, folder: "/m/a", impact: [], runs: [], check: { error: "no such folder" }, l10n: null };
  assert.equal(finishMod(e, prev, true).verdict, "FAIL", "a vanished folder is not blamed on the update");
  assert.deepEqual(compareReports(prev, [e]).newlyFailing, ["/m/a"], "matched by folder when the id is unreadable");
});

test("impact High findings make a failure BROKE-BY-UPDATE even with no previous report", () => {
  const e = { id: "a", impact: [{ severity: "High", text: "export gone" }], runs: [], check: null, l10n: null };
  assert.equal(finishMod(e, null, true).verdict, "BROKE-BY-UPDATE");
  assert.equal(finishMod({ ...e, impact: [{ severity: "Low", text: "x" }] }, null, true).verdict, "PASS");
});

test("compare lists newly failing, fixed and still failing", () => {
  const prev = { mods: [{ id: "a", verdict: "PASS" }, { id: "b", verdict: "FAIL" }, { id: "c", verdict: "FAIL" }] };
  const now = [{ id: "a", verdict: "FAIL" }, { id: "b", verdict: "PASS" }, { id: "c", verdict: "BROKE-BY-UPDATE" }, { id: "d", verdict: "FAIL" }];
  const c = compareReports(prev, now);
  assert.deepEqual([c.newlyFailing, c.fixed, c.stillFailing], [["a"], ["b"], ["c"]]);
  assert.deepEqual(compareReports(null, now).newlyFailing, []);
});

test("suite validation and resolution", () => {
  assert.match(validateSuite({ mods: [] }) ?? "", /non-empty/);
  assert.match(validateSuite({ mods: [{ folder: "a", seed: "x" }] }) ?? "", /seed/);
  assert.match(validateSuite({ mods: [{ folder: "a", checks: ["nope"] }] }) ?? "", /checks/);
  assert.equal(validateSuite({ mods: [{ folder: "a", recipes: ["r.json"] }] }), null);
  const s = resolveSuite({ defaults: { seed: 9, turns: 2 }, mods: [{ folder: "a", recipes: ["r.json"], seed: 3 }] }, "/base");
  assert.deepEqual(s.mods[0], { folder: "/base/a", recipes: ["/base/r.json"], seed: 3, age: null, turns: 2,
    checks: ["check", "l10n", "impact", "recipes", "logs"] });
});

test("the sample recipe is a valid recipe", () => {
  assert.equal(validateRecipe(sampleRecipe("x")), null);
});

test("init writes a suite of enabled local mods only, with one recipe each, and keeps edited recipes", () => {
  const root = tmp();
  const user = path.join(root, "user");
  const local = modDir(path.join(user, "Mods"), "alpha");
  const off = modDir(path.join(user, "Mods"), "beta");
  const ws = modDir(path.join(root, "steamapps", "workshop", "content", "1295660", "123"), "gamma");
  const rows = [
    { id: "alpha", path: path.join(local, "alpha.modinfo"), disabled: 0 },
    { id: "beta", path: path.join(off, "beta.modinfo"), disabled: 1 },
    { id: "gamma", path: path.join(ws, "gamma.modinfo"), disabled: 0 },
  ];
  const paths = { userMods: path.join(user, "Mods"), evidence: path.join(root, "tb", "evidence") };
  const r = initSuite(paths, { rows });
  assert.equal(r.mods, 1);
  const suite = loadSuite(r.file);
  assert.equal(suite.mods[0].folder, local);
  assert.equal(path.basename(suite.mods[0].recipes[0]), "alpha-loads.json");
  fs.writeFileSync(suite.mods[0].recipes[0], JSON.stringify({ name: "edited", steps: [{ turns: 3 }] }));
  assert.throws(() => initSuite(paths, { rows }), /exists; add --yes/);
  initSuite(paths, { rows, yes: true });
  assert.equal(JSON.parse(fs.readFileSync(suite.mods[0].recipes[0], "utf8")).name, "edited");
  assert.equal(starterSuite([]).suite.mods.length, 0);
});

test("report files: JSON, Markdown and HTML, one per night, listed newest first", () => {
  const root = tmp();
  const paths = { evidence: path.join(root, "evidence") };
  const report = { startedAt: "2026-10-02T03:00:00.000Z", summary: { mods: 1, pass: 0, fail: 1, broke: 0 },
    game: { installed: "1.6.0", previous: "1.5.0", updated: false, why: "unchanged" }, stopped: null,
    compare: { previous: "x", newlyFailing: ["<a>"], fixed: [] },
    mods: [{ id: "<a>", folder: "/m/a", verdict: "FAIL", reasons: ["step 1 failed: \"x\" & y"], runs: [] }] };
  const f1 = writeReportFiles(paths, report, new Date(2026, 9, 2));
  const f2 = writeReportFiles(paths, { ...report, startedAt: "2026-10-02T04:00:00.000Z" }, new Date(2026, 9, 2));
  assert.equal(path.basename(f1.json), "2026-10-02.json");
  assert.equal(path.basename(f2.json), "2026-10-02-2.json");
  assert.equal(listReports(paths)[0].file, f2.json);
  const html = fs.readFileSync(f1.html, "utf8");
  assert.ok(html.includes("&lt;a&gt;") && !html.includes("<a>"), "names are escaped in HTML");
  assert.match(reportMarkdown(report), /Newly failing: <a>/);
  assert.match(reportHtml(report), /&quot;x&quot; &amp; y/);
});

test("newestSave reads mtimes two levels under Saves", () => {
  const root = tmp();
  const auto = path.join(root, "Saves", "Single", "auto");
  fs.mkdirSync(auto, { recursive: true });
  const f = path.join(auto, "AutoSave_0001.Civ7Save");
  fs.writeFileSync(f, "x");
  const t = new Date("2026-10-01T12:00:00Z");
  fs.utimesSync(f, t, t);
  assert.equal(newestSave({ user: root }), t.getTime());
  assert.equal(newestSave({ user: path.join(root, "none") }), 0);
});

test("notifications escape AppleScript strings and only run on macOS", async () => {
  assert.equal(appleString('a "b" \\ c\nd'), '"a \\"b\\" \\\\ c d"');
  let seen = null;
  const ok = await notifyMac("T", "x", /** @type {any} */ ((cmd, args, cb) => { seen = [cmd, args]; cb(null); }));
  if (process.platform === "darwin") {
    assert.equal(ok, true);
    assert.deepEqual(seen, ["osascript", ["-e", 'display notification "x" with title "T"']]);
  } else assert.equal(ok, false);
});
