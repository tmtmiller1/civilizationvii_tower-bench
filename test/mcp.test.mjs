import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { group, makeInstall, makeMod, makeUserDir, tmp } from "./fixtures/static/make.mjs";

// TOWER_BENCH_MCP_ENTRY points the tests at another entry script with the same `mcp` handler.
const CLI = process.env.TOWER_BENCH_MCP_ENTRY
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tower-bench.mjs");

// A throwaway user dir, home (crash reports are read from ~/Library/Logs) and install, and a debugger port
// nothing listens on: the server can never reach a real game or real files.
function sandbox() {
  const root = tmp("tb-mcp-");
  const user = makeUserDir(path.join(root, "user"));
  fs.mkdirSync(path.join(user, "Logs"));
  fs.writeFileSync(path.join(user, "Logs", "Modding.log"),
    "[2026-09-26 17:22:16]\tWarning: Apply Actions - No registered handler for 'x-group (ReplaceUIScript)'.\n");
  execFileSync("sqlite3", [path.join(user, "Mods.sqlite"),
    "CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT, LastWriteTime INTEGER);"
    + "CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ScannedFileRowId INTEGER, ModId TEXT, Version INTEGER, Disabled BOOLEAN);"
    + "CREATE TABLE ModProperties(ModRowId INTEGER, Name TEXT, Value TEXT);"
    + "CREATE TABLE LocalizedText(ModRowId INTEGER, Tag TEXT, Locale TEXT, Text TEXT);"]);
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, "Library", "Logs", "DiagnosticReports"), { recursive: true });
  const mods = path.join(root, "src");
  const mod = makeMod(mods, "synthetic-mod", {
    groups: group("g", "game", "always", { UpdateDatabase: ["data/d.xml"] }),
    files: { "data/d.xml": "<Database><Nodes><Row NodeType=\"NODE_NEW\"/></Nodes></Database>" },
  });
  return {
    mod,
    env: {
      HOME: home, TOWER_BENCH_USER_DIR: user, TOWER_BENCH_EVIDENCE_DIR: path.join(root, "evidence"),
      TOWER_BENCH_CDP_PORT: "1", TOWER_BENCH_INSTALL: makeInstall(path.join(root, "install")),
    },
    evidence: path.join(root, "evidence"),
  };
}

const servers = [];
after(() => { for (const s of servers) s.child.kill(); });

/** Spawns the server and gives a request/response client over its stdio. */
function startServer(env, ...flags) {
  const child = spawn(process.execPath, [CLI, "mcp", ...flags], { env: { ...process.env, ...env }, stdio: "pipe" });
  const lines = [];
  const waiting = new Map();
  let buf = "";
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      lines.push(line);
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  let next = 1;
  const s = {
    child, lines, stderr: () => stderr,
    raw: (text, id) => new Promise((resolve) => {
      waiting.set(id, resolve);
      child.stdin.write(`${text}\n`);
    }),
    request: (method, params) => {
      const id = next++;
      return s.raw(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }), id);
    },
    notify: (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`),
    call: async (name, args = {}) => (await s.request("tools/call", { name, arguments: args })).result,
    close: () => new Promise((resolve) => { child.on("exit", resolve); child.stdin.end(); }),
  };
  servers.push(s);
  return s;
}

const textOf = (result) => result.content.map((c) => c.text).join("\n");

async function initialised(env, ...flags) {
  const s = startServer(env, ...flags);
  const init = await s.request("initialize", { protocolVersion: "2025-06-18", capabilities: {},
    clientInfo: { name: "test", version: "1" } });
  s.notify("notifications/initialized");
  return { s, init };
}

test("initialize negotiates the version and lists the tools, writes refused and eval unlisted", async () => {
  const { env } = sandbox();
  const { s, init } = await initialised(env);
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "tower-bench");
  assert.ok(init.result.capabilities.tools);
  assert.match(init.result.instructions, /proves nothing/);

  const old = await s.request("initialize", { protocolVersion: "1999-01-01", capabilities: {} });
  assert.equal(old.result.protocolVersion, "2025-11-25");

  const { tools } = (await s.request("tools/list")).result;
  const names = tools.map((t) => t.name);
  for (const n of ["status", "techniques_search", "crash_list", "check_mod", "write", "do_action", "undo", "lab_start",
    "lab_turns", "bisect", "mods_switch", "deploy"]) assert.ok(names.includes(n), n);
  assert.ok(!names.includes("eval"), "eval is listed only with --allow-eval");
  const write = tools.find((t) => t.name === "write");
  assert.match(write.description, /LANDED/);
  assert.match(write.description, /Currently refused/);
  assert.equal(write.annotations.readOnlyHint, false);
  assert.equal(write.inputSchema.type, "object");
  assert.equal(tools.find((t) => t.name === "status").annotations.readOnlyHint, true);

  for (const [name, args] of [["undo", {}], ["write", { op: "terrain.set", args: { x: 1, y: 2, type: "TERRAIN_HILL" } }],
    ["mods_switch", { op: "off", id: "a" }], ["lab_turns", { n: 1 }], ["lab_stop", {}], ["deploy", { folder: "/x" }]]) {
    const r = await s.call(name, args);
    assert.equal(r.isError, true, name);
    assert.match(textOf(r), /Refused: .*--allow-writes/, name);
  }
  await s.close();
});

test("lab tools need --allow-lab as well; eval is listed with --allow-eval", async () => {
  const { env } = sandbox();
  const { s } = await initialised(env, "--allow-writes", "--allow-eval");
  const names = (await s.request("tools/list")).result.tools.map((t) => t.name);
  assert.ok(names.includes("eval"));
  for (const name of ["lab_start", "bisect"]) {
    const r = await s.call(name, {});
    assert.equal(r.isError, true);
    assert.match(textOf(r), /--allow-lab/);
    assert.doesNotMatch(textOf(r), /without --allow-writes/);
  }
  // Allowed, so it runs, and fails for want of a game rather than for want of permission.
  const w = await s.call("write", { op: "terrain.set", args: { x: 1, y: 2, type: "TERRAIN_HILL" } });
  assert.equal(w.isError, true);
  assert.match(textOf(w), /not connected/);
  // The lab's own refusals hold: no lab run here, so no turns are ended and nothing is quit.
  const turns = await s.call("lab_turns", { n: 1 });
  assert.equal(turns.isError, true);
  assert.match(textOf(turns), /not this lab's test game/);
  const stop = await s.call("lab_stop");
  assert.match(textOf(stop), /no test run in progress/);
  await s.close();
});

test("a recipe that runs code needs --allow-eval as well", async () => {
  const { env } = sandbox();
  const recipe = path.join(tmp("tb-mcp-recipe-"), "r.json");
  fs.writeFileSync(recipe, JSON.stringify({ steps: [{ snapshot: "a" }, { expect: "true" }] }));
  const { s } = await initialised(env, "--allow-writes");
  const r = await s.call("recipe_run", { file: recipe });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /1 step\(s\) that run code.*--allow-eval/);
  await s.close();
});

test("modern requests: server/discover, per-request versions, resultType", async () => {
  const { env } = sandbox();
  const s = startServer(env);
  const meta = (v) => ({ _meta: { "io.modelcontextprotocol/protocolVersion": v } });
  const d = await s.request("server/discover", meta("2026-07-28"));
  assert.equal(d.result.resultType, "complete");
  assert.ok(d.result.supportedVersions.includes("2026-07-28"));
  assert.equal(d.result._meta["io.modelcontextprotocol/serverInfo"].name, "tower-bench");
  const list = await s.request("tools/list", meta("2026-07-28"));
  assert.equal(list.result.resultType, "complete");
  const bad = await s.request("tools/list", meta("1900-01-01"));
  assert.equal(bad.error.code, -32022);
  assert.equal(bad.error.data.requested, "1900-01-01");
  await s.close();
});

test("offline tools answer from files", async () => {
  const { env, mod } = sandbox();
  const { s } = await initialised(env);

  const tech = await s.call("techniques_search", { query: "lens" });
  assert.equal(tech.isError, false);
  assert.match(textOf(tech), /```json/);

  const status = await s.call("status");
  assert.equal(status.isError, false);
  assert.match(textOf(status), /^offline:/);

  const logs = await s.call("logs_recent", { level: "warn" });
  assert.match(textOf(logs), /ReplaceUIScript/);

  const check = await s.call("check_mod", { folder: mod });
  assert.equal(check.isError, false, textOf(check));
  assert.match(textOf(check), /synthetic-mod/);

  if (process.platform === "darwin") {
    const crashes = await s.call("crash_list");
    assert.equal(crashes.isError, false);
    assert.match(textOf(crashes), /no Civilization VII crash reports found/);
  }
  const mods = await s.call("mods_list", { all: true });
  assert.equal(mods.isError, false);
  await s.close();
});

test("errors: unknown tool, bad arguments, malformed JSON, unknown method", async () => {
  const { env } = sandbox();
  const { s } = await initialised(env);
  const unknown = await s.request("tools/call", { name: "no_such_tool", arguments: {} });
  assert.equal(unknown.error.code, -32602);

  const wrongType = await s.call("techniques_show", { id: 5 });
  assert.equal(wrongType.isError, true);
  assert.match(textOf(wrongType), /id must be a string/);
  const extra = await s.call("status", { surprise: true });
  assert.equal(extra.isError, true);
  assert.match(textOf(extra), /unknown argument "surprise"/);
  const missing = await s.call("check_mod", {});
  assert.match(textOf(missing), /missing required argument "folder"/);
  const failing = await s.call("check_mod", { folder: "/no/such/folder" });
  assert.equal(failing.isError, true);
  assert.match(textOf(failing), /no such folder/);

  const parse = await s.raw("{not json", null);
  assert.equal(parse.error.code, -32700);
  const method = await s.request("no/such/method");
  assert.equal(method.error.code, -32601);
  const ping = await s.request("ping");
  assert.deepEqual(ping.result, {});
  await s.close();
});

test("resources list the techniques and the evidence log", async () => {
  const { env } = sandbox();
  const { s } = await initialised(env);
  await s.call("techniques_search", { query: "lens" });
  const { resources } = (await s.request("resources/list")).result;
  const technique = resources.find((r) => r.uri.startsWith("tower-bench://techniques/"));
  assert.ok(technique);
  assert.ok(resources.some((r) => r.uri.startsWith("tower-bench://evidence/")));
  const read = await s.request("resources/read", { uri: technique.uri });
  assert.equal(JSON.parse(read.result.contents[0].text).id, technique.name);
  const none = await s.request("resources/read", { uri: "tower-bench://techniques/no-such" });
  assert.equal(none.error.code, -32002);
  await s.close();
});

test("every call is in the evidence log, and stdout carries nothing but JSON-RPC", async () => {
  const { env, evidence } = sandbox();
  const { s } = await initialised(env);
  await s.call("status");
  await s.call("undo");
  await s.call("techniques_show", { id: 5 });
  await s.close();
  for (const line of s.lines) assert.equal(JSON.parse(line).jsonrpc, "2.0", line);
  assert.match(s.stderr(), /serving \d+ tools/);
  const entries = fs.readdirSync(evidence).flatMap((f) => fs.readFileSync(path.join(evidence, f), "utf8").trim().split("\n"))
    .map((l) => JSON.parse(l)).filter((e) => e.kind === "mcp");
  assert.deepEqual(entries.map((e) => [e.request.tool, e.result.outcome]),
    [["status", "ok"], ["undo", "refused"], ["techniques_show", "bad-args"]]);
});
