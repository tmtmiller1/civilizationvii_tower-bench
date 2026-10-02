import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";
import { BenchError } from "../lib/bench.mjs";
import { formatReport, mapCdp, mapInstrumented, mapScript, parseCoverageLog, scriptRel, summarize }
  from "../lib/coverage-map.mjs";
import { cdpStart, cdpTake, describeAnswer, probeProfiler } from "../lib/coverage-cdp.mjs";
import { instrumentMod, listReads, loadRead, modJsFiles, readInstrumented, restoreMod } from "../lib/coverage.mjs";
import { coverageDump, coverageRead, coverageReset } from "../lib/engine-coverage.mjs";
import { PROLOGUE_END, instrumentSource } from "../lib/instrument.mjs";

const g = /** @type {any} */ (globalThis);
afterEach(() => { delete g.__tbCov; delete g.__tbCoverage; delete g.__tbCovDump; });

const FIXTURE = `export class Counter {
  constructor(n) { this.n = n; }
  static make() { return new Counter(1); }
  bump(x) { if (x) { this.n++; } else { this.n--; } return this.n; }
  get value() { return this.n; }
  never() { return 0; }
}
export function used(a) { switch (a) { case 1: { return "one"; } default: { return "other"; } } }
export function unused() { const inner = () => { return 1; }; return inner(); }
export const arrow = (x) => { try { return x(); } catch (e) { return null; } };
`;

// Profiler.takePreciseCoverage for FIXTURE after make(), bump(1) twice, value, used(1) and a throwing arrow:
// the documented ScriptCoverage shape, as V8 returns it.
const RECORDED = {
  scriptId: "115", url: "fs://game/test-mod/ui/fixture.js",
  functions: [
    { functionName: "", ranges: [{ startOffset: 0, endOffset: 485, count: 1 }], isBlockCoverage: true },
    { functionName: "Counter", ranges: [{ startOffset: 25, endOffset: 55, count: 1 }], isBlockCoverage: true },
    { functionName: "make", ranges: [{ startOffset: 65, endOffset: 98, count: 1 }], isBlockCoverage: true },
    { functionName: "bump", ranges: [{ startOffset: 101, endOffset: 167, count: 2 },
      { startOffset: 131, endOffset: 150, count: 0 }], isBlockCoverage: true },
    { functionName: "get value", ranges: [{ startOffset: 170, endOffset: 200, count: 1 }], isBlockCoverage: true },
    { functionName: "never", ranges: [{ startOffset: 203, endOffset: 224, count: 0 }], isBlockCoverage: false },
    { functionName: "used", ranges: [{ startOffset: 234, endOffset: 324, count: 1 },
      { startOffset: 292, endOffset: 320, count: 0 }], isBlockCoverage: true },
    { functionName: "unused", ranges: [{ startOffset: 332, endOffset: 404, count: 0 }], isBlockCoverage: false },
    { functionName: "arrow", ranges: [{ startOffset: 426, endOffset: 483, count: 1 }], isBlockCoverage: true },
  ],
};

const EXPECTED_FNS = {
  "Counter.constructor": 1, "Counter.make": 1, "Counter.bump": 2, "Counter.get value": 1, "Counter.never": 0,
  used: 1, unused: 0, inner: 0, arrow: 1,
};

function checkFixture(file) {
  const byName = Object.fromEntries(file.functions.map((f) => [f.name, f.count]));
  assert.deepEqual(byName, EXPECTED_FNS);
  assert.deepEqual(file.blocks.map((b) => `${b.kind}:${b.count > 0}`),
    ["if:true", "else:false", "case:true", "case:false", "catch:true"]);
}

test("V8 precise coverage maps onto functions and blocks (recorded shape)", () => {
  const f = mapScript("ui/fixture.js", FIXTURE, RECORDED);
  checkFixture(f);
  assert.equal(f.ran, true);
});

test("the same mapping holds on coverage this V8 records live", async () => {
  // V8 reports the resolved path, and the temp folder may sit behind a symlink.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tb-cov-v8-")));
  const file = path.join(dir, "fixture.mjs");
  fs.writeFileSync(file, FIXTURE);
  const s = new Session();
  s.connect();
  try {
    await s.post("Profiler.enable");
    await s.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
    const m = await import(pathToFileURL(file).href);
    const c = m.Counter.make();
    c.bump(1); c.bump(1);
    assert.equal(c.value, 3);
    m.used(1);
    m.arrow(() => { throw new Error("x"); });
    const r = await s.post("Profiler.takePreciseCoverage");
    const script = /** @type {any} */ (r.result.find((x) => x.url === pathToFileURL(file).href));
    assert.ok(script, "V8 reported the fixture");
    checkFixture(mapScript("fixture.mjs", FIXTURE, script));
  } finally {
    await s.post("Profiler.stopPreciseCoverage").catch(() => null);
    s.disconnect();
  }
});

test("script URLs map to mod files by id or folder name", () => {
  assert.equal(scriptRel("fs://game/Test-Mod/ui/a%20b.js?x=1", ["test-mod"]), "ui/a b.js");
  assert.equal(scriptRel("fs://game/other/ui/a.js", ["test-mod", "folder"]), null);
  assert.equal(scriptRel("fs://game/folder/ui/a.js", ["test-mod", "folder"]), "ui/a.js");
  const cov = mapCdp([RECORDED, { ...RECORDED, url: "fs://game/test-mod/ui/extra.js" }],
    { modId: "test-mod", roots: ["test-mod"], files: [{ rel: "ui/fixture.js", text: FIXTURE }, { rel: "ui/gone.js", text: "function a() {}" }] });
  assert.equal(cov.files[1].ran, false);
  assert.match(cov.notes[0], /ui\/extra\.js/);
  const none = mapCdp([], { modId: "test-mod", roots: ["test-mod"], files: [] });
  assert.match(none.notes[0], /never loaded/);
});

test("counter reads and UI.log dumps map onto the saved table", () => {
  const r = instrumentSource(FIXTURE, { fileId: 9, modId: "test-mod", rel: "ui/fixture.js" });
  const saved = { modId: "test-mod", files: [{ rel: "ui/fixture.js", fileId: 9, table: r.table },
    { rel: "ui/late.js", fileId: 10, table: [{ k: "f", kind: "function", name: "late", line: 1, col: 1 }] }] };
  const log = "[t]\t[TB-COVERAGE] d=a f=9 0:1,1:5\n[t]\t[TB-COVERAGE] d=b f=9 0:2\n[t]\t[TB-COVERAGE] d=b f=9 2:3\n";
  const parsed = parseCoverageLog(log);
  assert.equal(parsed.dump, "b");
  assert.deepEqual(parsed.counts["9"].c, { 0: 2, 2: 3 });
  const cov = mapInstrumented(saved, parsed.counts);
  const s = summarize(cov);
  assert.equal(s.files[0].functions.hit, 2);
  assert.deepEqual(s.filesNeverLoaded, ["ui/late.js"]);
  assert.ok(s.neverRan.some((u) => u.name === "Counter.never"));
  const md = formatReport(cov, { md: true });
  assert.match(md, /^# Coverage: test-mod/);
  assert.match(md, /\| ui\/late\.js \| 0\/1 \(0%\) \| 0\/0 \(-\) \| no \|/);
  assert.match(formatReport(cov), /never ran \(\d+\):/);
});

test("page functions read, dump and zero the counters", () => {
  assert.equal(coverageRead().installed, false);
  const r = instrumentSource("function a() {}\na();\n", { fileId: 3, modId: "m", rel: "a.js" });
  new Function(r.code)();
  assert.deepEqual(coverageRead().files["3"].c, { 0: 1 });
  const orig = console.error;
  const lines = [];
  console.error = (l) => lines.push(l);
  try { assert.equal(coverageDump().lines, 1); } finally { console.error = orig; }
  assert.match(lines[0], /^\[TB-COVERAGE\] d=\w+ f=3 0:1$/);
  coverageReset();
  assert.deepEqual(coverageRead().files["3"].c, {});
});

// A synthetic mod: a source folder and the live copy the game loads.
function makeMod() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cov-mod-"));
  const src = path.join(root, "src");
  const live = path.join(root, "live");
  fs.mkdirSync(path.join(src, "ui", "lib"), { recursive: true });
  fs.writeFileSync(path.join(src, "test-mod.modinfo"), `<?xml version="1.0"?><Mod id="test-mod" version="1" xmlns="ModInfo">
<ActionGroups><ActionGroup id="g" scope="game"><Actions><UIScripts><Item>ui/main.js</Item></UIScripts>
<UpdateText><Item>text/en.xml</Item></UpdateText></Actions></ActionGroup></ActionGroups></Mod>`);
  fs.writeFileSync(path.join(src, "ui", "main.js"), "import { helper } from \"./lib/helper.js\";\nfunction start() { return helper(); }\nstart();\n");
  fs.writeFileSync(path.join(src, "ui", "lib", "helper.js"), "export function helper() { if (1) { return 1; } }\nimport \"/elsewhere/x.js\";\n");
  fs.cpSync(src, live, { recursive: true });
  return { root, src, live };
}

function fakeBench(root, { plan, call, send } = {}) {
  const logs = [];
  const ws = {};
  return {
    logs,
    paths: { evidence: path.join(root, "bench", "evidence"), logs: path.join(root, "logs"), cdpPort: 1 },
    planFor: (dir) => ({ modId: "test-mod", srcDir: dir, liveDir: path.join(root, "live"), ...plan }),
    log: (e) => { logs.push(e); return e; },
    requireConnection: async () => {},
    confirmDeployed: async (_id, _changes, _stamp, { files }) => { for (const f of files) f.live = "SERVED"; return true; },
    cdp: {
      ws, scope: "game", target: { url: "fs://game/base/root-game.html" },
      ensure: async () => {},
      call: call ?? (async () => true),
      send: send ?? (async () => ({})),
    },
  };
}

test("the mod's JS is what the modinfo declares and what those files import inside the folder", () => {
  const { src } = makeMod();
  assert.deepEqual(modJsFiles(src), { modId: "test-mod", files: ["ui/lib/helper.js", "ui/main.js"] });
});

test("instrument writes counting copies to the live copy only, proves them, logs, and restore undoes it", async () => {
  const { root, src, live } = makeMod();
  const bench = fakeBench(root);
  const before = fs.readFileSync(path.join(src, "ui", "main.js"), "utf8");
  const preview = await instrumentMod(bench, src);
  assert.equal(preview.applied, false);
  assert.ok(!fs.readFileSync(path.join(live, "ui", "main.js"), "utf8").includes(PROLOGUE_END), "a preview writes nothing");
  const r = await instrumentMod(bench, src, { yes: true });
  assert.equal(r.applied, true);
  assert.deepEqual(r.files.map((f) => f.live), ["SERVED", "SERVED"]);
  assert.ok(fs.readFileSync(path.join(live, "ui", "main.js"), "utf8").includes(PROLOGUE_END));
  assert.equal(fs.readFileSync(path.join(src, "ui", "main.js"), "utf8"), before, "the source is untouched");
  assert.equal(bench.logs[0].kind, "coverage-instrument");
  const restored = await restoreMod(bench, src, { yes: true });
  assert.equal(restored.applied, true);
  assert.equal(fs.readFileSync(path.join(live, "ui", "main.js"), "utf8"), before);
  assert.equal(bench.logs[1].kind, "coverage-restore");
  assert.equal((await restoreMod(bench, src, { yes: true })).applied, false, "nothing left to restore");
});

test("instrument refuses a Workshop copy and a folder the game loads in place", async () => {
  const { root, src } = makeMod();
  const workshop = fakeBench(root, { plan: { refuse: "the copy the game loads is Steam Workshop" } });
  await assert.rejects(instrumentMod(workshop, src, { yes: true }), (e) => e instanceof BenchError && /Workshop/.test(e.message));
  const inPlace = fakeBench(root, { plan: { inPlace: true } });
  await assert.rejects(instrumentMod(inPlace, src, { yes: true }), /overwrite your source/);
});

test("read maps the page's counters onto the table and saves a report", async () => {
  const { root, src } = makeMod();
  const bench = fakeBench(root);
  await instrumentMod(bench, src, { yes: true });
  // Run the live copies' code the way the page would, then hand the counters to the fake debugger.
  const live = path.join(root, "live", "ui", "lib", "helper.js");
  const runnable = path.join(root, "helper-run.mjs");
  fs.writeFileSync(runnable, fs.readFileSync(live, "utf8").replace(/import "\/elsewhere\/x\.js";/, ""));
  (await import(pathToFileURL(runnable).href)).helper();
  bench.cdp.call = async (fn) => fn();
  const r = await readInstrumented(bench, { mod: "test-mod" });
  assert.equal(r[0].total.functions.hit, 1);
  assert.equal(r[0].total.functions.total, 2);
  assert.deepEqual(r[0].filesNeverLoaded, ["ui/main.js"]);
  assert.equal(bench.logs.at(-1).kind, "coverage-read");
  const name = listReads(bench.paths, "test-mod")[0];
  assert.equal(loadRead(bench.paths, name)?.route, "instrument");
  assert.equal(loadRead(bench.paths, "../escape.json"), null);
});

test("probe reports each CDP answer or error as given", async () => {
  const { root } = makeMod();
  const refused = fakeBench(root, { send: async (m) => { throw new Error(`'${m}' wasn't found`); } });
  const no = await probeProfiler(refused);
  assert.equal(no.verdict, "NO PRECISE COVERAGE");
  assert.ok(no.steps.every((s) => !s.ok && /wasn't found/.test(s.error)));
  assert.ok(no.protocol.error);
  const answers = fakeBench(root, { send: async (m) => (m === "Profiler.takePreciseCoverage" ? { result: [RECORDED], timestamp: 1 }
    : m === "Schema.getDomains" ? { domains: [{ name: "Profiler", version: "1.3" }] } : {}) });
  const yes = await probeProfiler(answers);
  assert.equal(yes.verdict, "PROFILER ANSWERS");
  assert.deepEqual(yes.steps.map((s) => s.method), ["Schema.getDomains", "Profiler.enable", "Profiler.startPreciseCoverage",
    "Profiler.takePreciseCoverage", "Profiler.stopPreciseCoverage", "Profiler.disable"]);
  assert.deepEqual(describeAnswer("Profiler.takePreciseCoverage", { result: [RECORDED] }),
    { scripts: 1, functions: 9, urls: ["fs://game/test-mod/ui/fixture.js"] });
  assert.equal(answers.logs[0].kind, "coverage-probe");
});

test("CDP take maps the live files and refuses after a reconnect", async () => {
  const { root, src, live } = makeMod();
  fs.writeFileSync(path.join(live, "ui", "main.js"), FIXTURE);
  const scripts = [{ ...RECORDED, url: "fs://game/test-mod/ui/main.js" }];
  const bench = fakeBench(root, { send: async (m) => (m === "Profiler.takePreciseCoverage" ? { result: scripts } : {}) });
  await assert.rejects(cdpTake(bench, src), /not running in this process/);
  await cdpStart(bench);
  const r = await cdpTake(bench, src);
  assert.equal(r.route, "cdp");
  assert.equal(r.files.find((f) => f.rel === "ui/main.js")?.functions.hit, 6);
  bench.cdp.ws = {};
  await assert.rejects(cdpTake(bench, src), /reconnected/);
});
