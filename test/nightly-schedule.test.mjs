import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LABEL, agentEnv, cronLine, launchctlCommands, nightlyCommand, parseAt, plistXml, schedule, scheduleStatus,
  schtasksLine, unschedule, xmlEscape,
} from "../lib/nightly-schedule.mjs";

const paths = { evidence: "/home/u/.tower-bench/evidence" };

/** An in-memory file system and a recording launchctl; nothing on the machine is touched. */
function fakeSys({ loadedAtStart = false, failBootout = false, failBootstrap = false } = {}) {
  const files = new Map();
  const calls = [];
  let isLoaded = loadedAtStart;
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    const [sub] = args;
    if (sub === "print") { if (!isLoaded) throw new Error("not found"); return "state = waiting"; }
    if (sub === "bootout") { if (failBootout) throw new Error("bootout unsupported"); isLoaded = false; return ""; }
    if (sub === "unload") { isLoaded = false; return ""; }
    if (sub === "bootstrap") { if (failBootstrap) throw new Error("bootstrap failed"); isLoaded = true; return ""; }
    if (sub === "load") { isLoaded = true; return ""; }
    throw new Error(`unexpected ${sub}`);
  };
  const fsx = /** @type {any} */ ({
    existsSync: (f) => files.has(f),
    readFileSync: (f) => files.get(f),
    writeFileSync: (f, data) => { files.set(f, String(data)); },
    mkdirSync: () => {},
    rmSync: (f) => { files.delete(f); },
  });
  return { files, calls, sys: { exec, fsx, platform: "darwin", uid: 501, home: "/home/u" } };
}

const AGENT = `/home/u/Library/LaunchAgents/${LABEL}.plist`;

test("parseAt accepts 24-hour times and refuses anything else", () => {
  assert.deepEqual(parseAt("03:00"), { hour: 3, minute: 0 });
  assert.deepEqual(parseAt("23:59"), { hour: 23, minute: 59 });
  for (const bad of ["24:00", "3", "03:60", "", undefined]) assert.throws(() => parseAt(bad), /24-hour/);
});

test("the plist escapes every argument and carries the schedule, log and environment", () => {
  const args = nightlyCommand({ node: "/n/node", bench: "/b & c/tower-bench.mjs", suite: "/s/<suite>'s.json" });
  const xml = plistXml({ args, hour: 3, minute: 5, log: "/l/launchd.log", env: { TOWER_BENCH_USER_DIR: "/u & v" } });
  assert.ok(xml.includes("<string>/b &amp; c/tower-bench.mjs</string>"));
  assert.ok(xml.includes("<string>/s/&lt;suite&gt;&apos;s.json</string>"));
  assert.ok(xml.includes("<string>/u &amp; v</string>"));
  assert.match(xml, /<key>Hour<\/key>\s*<integer>3<\/integer>\s*<key>Minute<\/key>\s*<integer>5<\/integer>/);
  assert.match(xml, new RegExp(`<key>Label</key>\\s*<string>${LABEL.replaceAll(".", "\\.")}</string>`));
  assert.ok(xml.includes("<string>--only-if-updated</string>"));
  assert.equal((xml.match(/<string>\/l\/launchd\.log<\/string>/g) ?? []).length, 2, "stdout and stderr");
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), "no bare ampersand");
  assert.equal(xmlEscape(`<&>"'`), "&lt;&amp;&gt;&quot;&apos;");
});

test("agentEnv keeps PATH and TOWER_BENCH_* only", () => {
  assert.deepEqual(agentEnv({ PATH: "/usr/bin", TOWER_BENCH_CDP_PORT: "9", HOME: "/h", SECRET: "x" }),
    { PATH: "/usr/bin", TOWER_BENCH_CDP_PORT: "9" });
});

test("launchctl commands target the gui domain and the bench's own label only", () => {
  const c = launchctlCommands(501, AGENT);
  assert.deepEqual(c.bootstrap, ["bootstrap", "gui/501", AGENT]);
  assert.deepEqual(c.bootout, ["bootout", `gui/501/${LABEL}`]);
  assert.deepEqual(c.print, ["print", `gui/501/${LABEL}`]);
});

test("schedule without --yes shows the plist and writes nothing", () => {
  const f = fakeSys();
  const r = schedule(paths, { at: "03:00", suite: "/s/suite.json", bench: "/b/tower-bench.mjs", env: {} }, f.sys);
  assert.equal(r.installed, false);
  assert.match(r.xml ?? "", /StartCalendarInterval/);
  assert.equal(f.files.size, 0);
  assert.deepEqual(f.calls, []);
});

test("schedule --yes writes the agent and bootstraps it; a second run replaces it", () => {
  const f = fakeSys();
  const r = schedule(paths, { at: "03:00", suite: "/s/suite.json", bench: "/b/tower-bench.mjs", yes: true, env: {} }, f.sys);
  assert.equal(r.installed, true);
  assert.equal(r.replaced, false);
  assert.deepEqual([...f.files.keys()], [AGENT]);
  assert.deepEqual(f.calls.at(-1), ["launchctl", "bootstrap", "gui/501", AGENT]);
  const again = schedule(paths, { at: "04:30", suite: "/s/suite.json", bench: "/b/tower-bench.mjs", yes: true, notify: true, env: {} }, f.sys);
  assert.equal(again.replaced, true);
  assert.ok(f.calls.some((c) => c[1] === "bootout"));
  const st = scheduleStatus(paths, f.sys);
  assert.equal(st.at, "04:30");
  assert.equal(st.loaded, true);
  assert.equal(st.suite, "/s/suite.json");
  assert.ok(st.args?.includes("--notify"));
});

test("legacy load and unload are the fallbacks when bootstrap or bootout fail", () => {
  const f = fakeSys({ failBootstrap: true, failBootout: true });
  schedule(paths, { at: "03:00", suite: "/s/suite.json", bench: "/b/t.mjs", yes: true, env: {} }, f.sys);
  assert.deepEqual(f.calls.at(-1), ["launchctl", "load", "-w", AGENT]);
  const r = unschedule({ yes: true }, f.sys);
  assert.equal(r.removed, true);
  assert.ok(f.calls.some((c) => c[1] === "unload"));
  assert.equal(f.files.size, 0);
});

test("unschedule needs --yes, and reports when nothing is installed", () => {
  const f = fakeSys();
  assert.match(unschedule({ yes: true }, f.sys).note ?? "", /no nightly schedule/);
  f.files.set(AGENT, "<plist/>");
  assert.match(unschedule({}, f.sys).note ?? "", /--yes/);
  assert.equal(f.files.size, 1);
});

test("Windows and Linux get a printed line, not an install", () => {
  const args = nightlyCommand({ node: "node", bench: "C:\\b\\tower-bench.mjs", suite: "C:\\s\\suite.json" });
  assert.equal(schtasksLine(args, { hour: 3, minute: 0 }),
    'schtasks /Create /SC DAILY /ST 03:00 /TN "tower-bench-nightly" /TR "\\"node\\" \\"C:\\b\\tower-bench.mjs\\" \\"nightly\\" '
    + '\\"run\\" \\"--only-if-updated\\" \\"--suite\\" \\"C:\\s\\suite.json\\"" /F');
  assert.equal(cronLine(["node", "/b/t.mjs", "nightly", "run", "--suite", "/s/my suite.json"], { hour: 3, minute: 15 }, "/l/x.log"),
    "15 3 * * * node /b/t.mjs nightly run --suite '/s/my suite.json' >> /l/x.log 2>&1");
  const f = fakeSys();
  const r = schedule(paths, { at: "03:00", suite: "/s/suite.json", bench: "/b/t.mjs", yes: true, env: {} },
    { ...f.sys, platform: "linux" });
  assert.equal(r.installed, false);
  assert.match(r.line ?? "", /^0 3 \* \* \* /);
  assert.deepEqual(f.calls, []);
});
