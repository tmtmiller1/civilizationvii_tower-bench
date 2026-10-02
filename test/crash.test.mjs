import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  appliedMods, bisectCommand, crashDirs, crashTriage, ipsDate, listCrashes, logsRun, parseIps, readCrash,
  signatureOf, summariseIps,
} from "../lib/crash.mjs";
import { printCrash, printCrashList } from "../lib/cli/doctor.mjs";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "crash", "minimal.ips");
const SIG = "1000001:CivilizationVII+0xa00010,CivilizationVII+0xb00020,CivilizationVII+0xc00030";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tb-crash-"));

// A copy of the fixture with its incident, capture time and top game frame changed.
function variant(dir, name, { incident, capture, top }) {
  const { header, body } = parseIps(fs.readFileSync(FIXTURE, "utf8"));
  header.incident_id = incident;
  body.incident = incident;
  if (capture) body.captureTime = capture;
  if (top !== undefined) body.threads[1].frames[1].imageOffset = top;
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(body)}`);
  return file;
}

const stamp = (d) => {
  const p = (n) => String(n).padStart(2, "0");
  return `[${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`;
};

test("an .ips report reads as time, exception, faulting thread and image-relative frames", () => {
  const r = readCrash(FIXTURE);
  assert.equal(r.time, "2026-01-10T17:00:04.500Z");
  assert.equal(r.launched, "2026-01-10T16:58:00.000Z");
  assert.equal(r.version, "9.9.0");
  assert.equal(r.build, "1000001");
  assert.deepEqual(r.exception, { type: "EXC_BAD_ACCESS", signal: "SIGSEGV", subtype: "KERN_INVALID_ADDRESS at 0x0000000000000000" });
  assert.deepEqual(r.thread, { index: 1, name: "Worker1" });
  assert.deepEqual(r.frames[0], { image: "libsystem_platform.dylib", offset: "0x64", main: false, symbol: "_platform_memmove + 8" });
  assert.equal(r.frames[1].offset, "0xa00010");
  assert.equal(r.frames.length, 5);
});

test("the signature is the game binary's top three frames, prefixed by the build", () => {
  assert.equal(readCrash(FIXTURE).signature, SIG, "the system frame on top is skipped");
  const frames = [{ image: "libsystem_c.dylib", offset: "0x10", main: false, symbol: "abort" }];
  assert.equal(signatureOf(frames, "7"), "7:libsystem_c.dylib+abort", "without game frames, the top frames of any image");
  assert.equal(signatureOf([], "7"), null);
});

test("the faulting thread falls back to the triggered one, and a bad file is refused", () => {
  const { header, body } = parseIps(fs.readFileSync(FIXTURE, "utf8"));
  delete body.faultingThread;
  assert.equal(summariseIps({ header, body }).thread.index, 1);
  assert.throws(() => parseIps("not json at all"), /not an \.ips crash report/);
  assert.throws(() => parseIps("{}\n{broken"), /not an \.ips crash report/);
});

test("ips times carry their zone", () => {
  assert.equal(ipsDate("2026-09-30 22:34:04.0103 -0400")?.toISOString(), "2026-10-01T02:34:04.010Z");
  assert.equal(ipsDate("2026-09-30 22:34:04 +0130")?.toISOString(), "2026-09-30T21:04:04.000Z");
  assert.equal(ipsDate("yesterday"), null);
});

test("reports group by signature, one per incident, newest first; other files are ignored", () => {
  const a = tmp();
  const b = tmp();
  variant(a, "CivilizationVII-2026-01-10-120005.ips", { incident: "i1", capture: "2026-01-10 12:00:04.5 -0500" });
  variant(a, "CivilizationVII-2026-01-11-090000.ips", { incident: "i2", capture: "2026-01-11 09:00:00.0 -0500" });
  variant(a, "CivilizationVII-2026-01-12-090000.ips", { incident: "i3", capture: "2026-01-12 09:00:00.0 -0500", top: 0x123 });
  variant(b, "CivilizationVII-2026-01-11-090000.ips", { incident: "i2" }); // a lab copy of i2
  fs.writeFileSync(path.join(a, "CivilizationVII-broken.ips"), "garbage");
  fs.writeFileSync(path.join(a, "OtherApp-2026-01-10.ips"), "garbage");
  const { reports, unreadable } = listCrashes([a, b, path.join(a, "missing")]);
  assert.deepEqual(reports.map((r) => r.incident), ["i3", "i2", "i1"]);
  assert.deepEqual(reports.map((r) => r.repeats), [1, 2, 2]);
  assert.equal(unreadable.length, 1);
});

test("crash folders include lab run copies", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "runs", "2026-01-01T00-00-00"), { recursive: true });
  const dirs = crashDirs({ evidence: path.join(root, "evidence") }, "/home/x");
  assert.equal(dirs[0], path.join("/home/x", "Library", "Logs", "DiagnosticReports"));
  assert.ok(dirs.includes(path.join(root, "runs", "2026-01-01T00-00-00")));
});

test("logs started after the crash belong to a later run", () => {
  const logs = tmp();
  const crash = { time: "2026-01-10T17:00:04.500Z", launched: "2026-01-10T16:58:00.000Z" };
  fs.writeFileSync(path.join(logs, "Modding.log"), `${stamp(new Date("2026-01-10T16:58:01Z"))}\tConnected to modding database!\n`);
  assert.equal(logsRun(logs, crash).run, "crash");
  fs.writeFileSync(path.join(logs, "Modding.log"), `${stamp(new Date("2026-01-10T18:00:00Z"))}\tConnected to modding database!\n`);
  assert.equal(logsRun(logs, crash).run, "later");
  fs.writeFileSync(path.join(logs, "Modding.log"), `${stamp(new Date("2026-01-09T10:00:00Z"))}\tConnected to modding database!\n`);
  assert.equal(logsRun(logs, crash).run, "earlier");
  assert.equal(logsRun(path.join(logs, "none"), crash).run, "unknown");
});

test("the last Target Mods block names the mods the run applied", () => {
  const lines = [
    "[t]\tTarget Mods (in no particular order):", "[t]\told-mod (Old)",
    "[t]\tConfiguring game content", "[t]\tTarget Mods (in no particular order):",
    "[t]\tbase-standard (Base Game)", "[t]\tsample-mod (Sample Mod (dev))", "[t]\tGame configuration needs to change.",
  ];
  assert.deepEqual(appliedMods(lines), [{ id: "base-standard", name: "Base Game" }, { id: "sample-mod", name: "Sample Mod (dev)" }]);
  assert.equal(appliedMods(["[t]\tnothing"]), null);
});

test("bisect runs over the mods the crashed run applied that are still enabled, else the enabled set", () => {
  const ctx = { logs: { run: "crash" }, applied: [{ id: "a" }, { id: "gone" }], enabled: ["a", "b"] };
  assert.match(bisectCommand(ctx) ?? "", /bisect --mods a --turns/);
  assert.match(bisectCommand({ ...ctx, logs: { run: "later" } }) ?? "", /--mods a,b /);
  assert.equal(bisectCommand({ ...ctx, enabled: [] }), null);
});

test("triage gathers the logs, warns when they are from a later run, and ends with the bisect command", () => {
  const root = tmp();
  const logs = path.join(root, "Logs");
  fs.mkdirSync(logs);
  const reports = path.join(root, "reports");
  fs.mkdirSync(reports);
  variant(reports, "CivilizationVII-a.ips", { incident: "i1" });
  variant(reports, "CivilizationVII-b.ips", { incident: "i2", capture: "2026-01-10 11:00:00.0 -0500" });
  const at = stamp(new Date("2026-01-10T16:58:01Z"));
  fs.writeFileSync(path.join(logs, "Modding.log"), `${at}\tTarget Mods (in no particular order):\n${at}\tsample-mod (Sample)\n`);
  fs.writeFileSync(path.join(logs, "UI.log"), `${at}\tline one\n${at}\t[TB-EVENT] {"name":"x"}\n${at}\tlast line\n`);
  fs.writeFileSync(path.join(logs, "Renderer.log"), `${at}\tok\n${at}\tERROR: out of slots\n`);
  fs.writeFileSync(path.join(logs, "AI_ConstructibleBroker.csv"), "Turn, Player, Item\n4, 1, BUILDING_SAMPLE\n");
  fs.writeFileSync(path.join(logs, "AI_Empty.csv"), "Turn, Player\n");
  const paths = { logs, modsDb: path.join(root, "missing.sqlite"), userMods: path.join(root, "Mods"), evidence: path.join(root, "ev") };
  const r = crashTriage(paths, { dirs: [reports], platform: "darwin" });
  assert.equal(r.crash.incident, "i1");
  assert.equal(r.repeats.count, 2);
  assert.equal(r.context.logs.run, "crash");
  assert.deepEqual(r.warnings, []);
  assert.equal(r.context.uiTail.at(-1), `${at}\tlast line`);
  assert.equal(r.context.breadcrumbs.length, 1);
  assert.deepEqual(r.context.renderer, [`${at}\tERROR: out of slots`]);
  assert.deepEqual(r.context.ai, [{ file: "AI_ConstructibleBroker.csv", header: "Turn, Player, Item", last: ["4, 1, BUILDING_SAMPLE"] }]);
  assert.deepEqual(r.context.applied, [{ id: "sample-mod", name: "Sample" }]);
  assert.ok(r.context.modsError, "an unreadable registry is reported, not thrown");

  fs.writeFileSync(path.join(logs, "Modding.log"), `${stamp(new Date("2026-01-11T09:00:00Z"))}\tConnected\n`);
  const later = crashTriage(paths, { dirs: [reports], platform: "darwin" });
  assert.match(later.warnings[0], /later run/);
  assert.equal(crashTriage(paths, { dirs: [reports], incident: "i2", platform: "darwin" }).crash.incident, "i2");
  assert.throws(() => crashTriage(paths, { dirs: [reports], incident: "nope", platform: "darwin" }), /no crash report/);
});

test("other platforms get a clean refusal, and an empty folder says so", () => {
  const paths = { logs: tmp(), modsDb: "/none", userMods: "/none", evidence: "/none/ev" };
  assert.deepEqual(crashTriage(paths, { platform: "win32" }), { supported: false, note: "crash reports not supported on this platform yet" });
  assert.equal(crashTriage(paths, { dirs: [tmp()], platform: "darwin" }).crash, null);
});

test("the printed triage and list name the signature and the next step", (t) => {
  const lines = [];
  t.mock.method(console, "log", (s) => lines.push(s));
  const crash = readCrash(FIXTURE);
  printCrash({ supported: true, crash, repeats: { count: 3, others: [{ time: crash.time }] }, warnings: [],
    context: { logs: { run: "crash" }, uiTail: [], breadcrumbs: [], moddingErrors: [], applied: [], ai: [], renderer: [],
      enabled: ["sample-mod"] }, next: "tower-bench bisect --mods sample-mod --turns <N>" });
  printCrashList([{ ...crash, repeats: 3 }]);
  const text = lines.join("\n");
  assert.match(text, /signature 1000001:CivilizationVII\+0xa00010/);
  assert.match(text, /seen 3 times/);
  assert.match(text, /bisect --mods sample-mod/);
  assert.match(text, /3x {2}Worker1/);
});
