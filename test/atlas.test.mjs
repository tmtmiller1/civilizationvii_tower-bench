import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { argCount, blankLiterals, declaredNames, indexUsage, scanSource, usageIndex } from "../lib/atlas-usage.mjs";
import { paramCounts, readDeclarations, readSdk, sdkMembers } from "../lib/atlas-sdk.mjs";
import { apiPath, parseVerdicts } from "../lib/atlas-verdicts.mjs";
import { buildAtlas, listAtlases, loadAtlas, runBuild, saveAtlas, savedCrawls } from "../lib/atlas.mjs";
import { diffAtlases, searchAtlas, showMember } from "../lib/atlas-query.mjs";
import { exportMarkdown } from "../lib/atlas-md.mjs";
import { ATLAS_COMMANDS, ATLAS_ROUTES } from "../lib/cli/atlas.mjs";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `tb-atlas-${p}-`));

const SCRIPT = `import { Helper } from "./helper.js";
// Game.inComment(1)
class Panel { }
const Local = { a: 1 };
function f(Param) { return Param.x; }
((Wrapped) => { Wrapped.y = 1; })(Wrapped || {});
const id = Game.PlayerOperations.sendRequest(player, "OP", { X: 1, Y: f(2, 3) });
const n = GameplayMap.getPlotIndex(x, y) + GameplayMap.getGridWidth();
const t = Game.turn;
console.log(\`IM.switchTo(\${Locale.compose("LOC_A", a, b)})\`, "Fake.inString(1)", /Rx.inRegex/);
engine.on("UnitMoved", cb); engine.trigger('ui-ready'); engine.on(name, cb);
Helper.go(); Panel.make(); Local.a; Math.max(1, 2); HTMLElement.prototype; Wrapped.z;
`;

test("the scanner reads engine chains, argument counts and event names, not text or comments", () => {
  const s = scanSource(SCRIPT);
  const paths = s.uses.map((u) => u.path);
  for (const p of ["Game.PlayerOperations", "Game.PlayerOperations.sendRequest", "GameplayMap.getPlotIndex", "Game.turn",
    "Locale.compose", "engine.on", "engine.trigger"]) assert.ok(paths.includes(p), p);
  for (const p of ["Game.inComment", "IM.switchTo", "Fake.inString", "Rx.inRegex"]) assert.ok(!paths.includes(p), p);
  const send = s.uses.find((u) => u.path === "Game.PlayerOperations.sendRequest");
  assert.deepEqual([send?.args, send?.line, send?.call], [3, 7, true]);
  assert.equal(s.uses.find((u) => u.path === "GameplayMap.getGridWidth")?.args, 0);
  assert.equal(s.uses.find((u) => u.path === "Locale.compose")?.args, 3);
  assert.equal(s.uses.find((u) => u.path === "Game.turn")?.call, false);
  assert.deepEqual(s.events.map((e) => `${e.verb}:${e.name}`), ["on:UnitMoved", "trigger:ui-ready", "on:(computed)"]);
});

test("names a script declares, imports or takes as a parameter are not roots, nor are built-ins", () => {
  const d = declaredNames(blankLiterals(SCRIPT));
  for (const n of ["Helper", "Panel", "Local", "Param", "Wrapped"]) assert.ok(d.has(n), n);
  const idx = indexUsage([{ label: "core/ui/a.js", scan: scanSource(SCRIPT) }]);
  assert.deepEqual(Object.keys(idx.roots).sort(), ["Game", "GameplayMap", "Locale", "engine"]);
  assert.deepEqual(idx.members["Game.PlayerOperations.sendRequest"].examples, ["core/ui/a.js:7"]);
  assert.deepEqual(idx.members["Game.PlayerOperations.sendRequest"].args, { 3: 1 });
  assert.equal(idx.events.UnitMoved.on, 1);
});

test("argument counting skips nested calls, objects and arrow bodies", () => {
  const code = "f(a, g(b, c), { x: 1, y: [2, 3] }, (p, q) => { return p, q; })";
  assert.equal(argCount(code, 1), 4);
  assert.equal(argCount("f( )", 1), 0);
  assert.equal(argCount("f(a, b", 1), null);
});

test("the usage index reads a game install's module tree", () => {
  const install = tmp("install");
  const ui = path.join(install, "Base", "modules", "core", "ui");
  fs.mkdirSync(ui, { recursive: true });
  fs.writeFileSync(path.join(ui, "a.js"), SCRIPT);
  fs.writeFileSync(path.join(ui, "a.js.map"), "Game.notScript()");
  fs.mkdirSync(path.join(install, "DLC", "extra"), { recursive: true });
  fs.writeFileSync(path.join(install, "DLC", "extra", "b.js"), "Game.turn; UI.reloadUI();");
  const u = usageIndex(install);
  assert.equal(u.files, 2);
  assert.equal(u.members["Game.turn"].count, 2);
  assert.equal(u.members["Game.turn"].files, 2);
  assert.ok(!u.members["Game.notScript"]);
  assert.deepEqual(u.members["UI.reloadUI"].examples, ["extra/b.js:1"]);
  assert.throws(() => usageIndex(path.join(install, "none")), /install was not found/);
});

const DTS = `declare const Game: GameLibrary, Plain: any;
interface GameLibrary extends Base {
  readonly turn: number;
  PlayerOperations: Ops;
  canStart(a: number, b?: string, ...rest: any[]): boolean;
}
interface Base { maxTurns: number }
interface Ops { sendRequest(player: number, op: string, args: { X: number, Y: number }): void; }
declare namespace UI { function reloadUI(): void; }
declare enum YieldTypes { YIELD_FOOD = 0, YIELD_GOLD }
declare class Database { static query(db: string, sql: string): any[]; }
declare global { const engine: { on(name: string, cb: Function, ctx?: any): void }; }
`;

test("declaration files give members, signatures and parameter counts", () => {
  const m = sdkMembers(readDeclarations([{ file: "civ.d.ts", text: DTS }]));
  assert.equal(m["Game.turn"].kind, "property");
  assert.equal(m["Game.maxTurns"].kind, "property", "inherited through extends");
  assert.deepEqual(m["Game.canStart"].params, { required: 1, total: null });
  assert.deepEqual(m["Game.PlayerOperations.sendRequest"].params, { required: 3, total: 3 });
  assert.equal(m["UI.reloadUI"].kind, "function");
  assert.ok(m["YieldTypes.YIELD_GOLD"]);
  assert.deepEqual(m["Database.query"].params, { required: 2, total: 2 });
  assert.deepEqual(m["engine.on"].params, { required: 2, total: 3 });
  assert.equal(m.Plain.kind, "global");
  assert.deepEqual(paramCounts("a = 1, b?: x, c: y"), { required: 1, total: 3 });
  const dir = tmp("sdk");
  fs.writeFileSync(path.join(dir, "civ.d.ts"), DTS);
  const r = readSdk(dir);
  assert.equal(r.files, 1);
  assert.equal(r.members["Game.turn"].file, "civ.d.ts", "file names are relative to the folder");
});

const FINDINGS = `# Findings

## Storage

- **\`Store.getItem(key)\` returns the first key's value.** Writes land correctly.
  Evidence: watched 2026-09-16 (probe run 2).
- **Only one store survives a restart.** Tried \`Configuration.getUser().setValue\`, \`UI.setOption\`
  and \`Mods.sqlite\`. Evidence: \`inferred\`, read from the binary.
- **Writing at runtime poisons the save.** \`Configuration.editGame\` is the cause.
  Evidence: watched
  2026-09-20.
- A note with no API and no evidence.
- **\`Object.keys\` on a native object is empty.** Evidence: watched.
`;

test("verdicts come from bold claims, with the evidence level and date", () => {
  assert.equal(apiPath("Configuration.getUser().setValue"), "Configuration.getUser");
  assert.equal(apiPath("Mods.sqlite"), null);
  assert.equal(apiPath("Object.keys"), null, "a JavaScript built-in is not engine API");
  const v = parseVerdicts(FINDINGS);
  assert.equal(v.length, 3);
  assert.deepEqual([v[0].members, v[0].level, v[0].date, v[0].role, v[0].section],
    [["Store.getItem"], "watched", "2026-09-16", "subject", "Storage"]);
  assert.deepEqual([v[1].members, v[1].level, v[1].role], [["Configuration.getUser", "UI.setOption"], "inferred", "mention"]);
  assert.deepEqual([v[2].members, v[2].date, v[2].role], [["Configuration.editGame"], "2026-09-20", "mention"],
    "a member named only in the body is a mention, even when it is the only one; the date may wrap");
});

const USAGE = { files: 1, bytes: 10, ms: 1, members: {
  "Game.turn": { count: 4, called: 0, args: {}, files: 2, examples: ["core/a.js:1"] },
  "Game.getTurn": { count: 2, called: 2, args: { 0: 2 }, files: 1, examples: ["core/a.js:2"] },
  "Store.getItem": { count: 1, called: 1, args: { 1: 1 }, files: 1, examples: ["core/a.js:3"] },
}, events: { UnitMoved: { on: 1, trigger: 0, other: 0, examples: ["core/a.js:4"] } } };

const LIVE = { game: { scope: "game", at: "2026-10-01T00:00:00Z", stats: { records: 3 }, records: {
  Game: { kind: "object", cls: "GameLibrary" }, "Game.turn": { kind: "accessor", get: true, set: false },
  "Game.getTurn": { kind: "function", arity: 1 }, "Game.hidden": { kind: "function", arity: 2 },
} } };

function sampleAtlas(version = "1.5.0", live = LIVE) {
  return buildAtlas({ gameVersion: version, usage: USAGE, live,
    sdk: { files: 1, members: { "Game.turn": { kind: "property", signature: "turn: number", type: "number", file: "x.d.ts" } } },
    verdicts: { entries: 5, verdicts: parseVerdicts(FINDINGS) } });
}

test("the atlas merges the sources with badges, and keeps verdicts about members no source knows", () => {
  const a = sampleAtlas();
  assert.deepEqual(a.members["Game.turn"].badges, ["LIVE", "USED", "DOCUMENTED"]);
  assert.equal(a.members["Game.turn"].kind, "accessor");
  assert.equal(a.members["Game.getTurn"].arity, 1, "the live arity wins over usage");
  assert.deepEqual(a.members["Game.hidden"].badges, ["LIVE"]);
  assert.deepEqual(a.members["Store.getItem"].badges, ["USED", "WATCHED"]);
  assert.deepEqual(a.members["Configuration.getUser"].badges, [], "an inferred mention is listed, not badged");
  assert.equal(a.members["Configuration.editGame"].kind, "unknown");
  assert.equal(a.sources.verdicts.attached, 1);
  assert.deepEqual(a.roots.Game.live, { game: "object" });
});

test("show, search and diff read the atlas", () => {
  const a = sampleAtlas();
  const s = showMember(a, "game.getturn");
  assert.equal(s?.member?.path, "Game.getTurn");
  const root = showMember(a, "Game");
  assert.deepEqual(root?.children.map((c) => c.path), ["Game.getTurn", "Game.hidden", "Game.turn"]);
  assert.equal(showMember(a, "Nope.x"), null);
  assert.equal(showMember(a, "Store.getItem")?.verdicts[0].level, "watched");
  const r = searchAtlas(a, "turn");
  assert.equal(r.results[0].path, "Game.turn");
  assert.equal(searchAtlas(a, "first key").results[0].path, "Store.getItem", "verdict text is searched");
  const old = buildAtlas({ gameVersion: "1.4.0", usage: { ...USAGE, members: { "Game.turn": USAGE.members["Game.turn"],
    "Game.gone": { count: 1, called: 1, args: {}, files: 1, examples: [] } }, events: {} },
  live: { game: { ...LIVE.game, records: { "Game.getTurn": { kind: "function", arity: 0 } } } } });
  const d = diffAtlases(old, a);
  assert.deepEqual(d.removed, ["Game.gone"]);
  assert.ok(d.added.includes("Game.hidden") && !d.added.includes("Configuration.editGame"));
  assert.deepEqual(d.arity, [{ path: "Game.getTurn", from: 0, to: 1 }]);
  assert.deepEqual(d.events.added, ["UnitMoved"]);
});

test("atlases are stored per version and exported as Markdown with no local paths", () => {
  const dir = tmp("store");
  saveAtlas(dir, sampleAtlas("1.4.0"));
  saveAtlas(dir, sampleAtlas("1.5.0"));
  assert.deepEqual(listAtlases(dir).map((x) => x.version).sort(), ["1.4.0", "1.5.0"]);
  assert.equal(loadAtlas(dir, "1.4.0").gameVersion, "1.4.0");
  assert.equal(loadAtlas(dir, undefined, "1.5.0").gameVersion, "1.5.0");
  assert.throws(() => loadAtlas(dir, "9.9"), /no atlas for "9.9"/);
  const md = tmp("md");
  const r = exportMarkdown(sampleAtlas(), md);
  assert.ok(r.files >= 4);
  const index = fs.readFileSync(path.join(md, "index.md"), "utf8");
  assert.match(index, /\[Game\]\(Game\.md\)/);
  const game = fs.readFileSync(path.join(md, "Game.md"), "utf8");
  assert.match(game, /### `Game\.turn`/);
  assert.match(game, /core\/a\.js:1/);
  for (const f of fs.readdirSync(md)) assert.ok(!fs.readFileSync(path.join(md, f), "utf8").includes(os.tmpdir()), f);
});

test("build reads the install, carries inputs over and merges saved crawls; CLI and routes answer", async () => {
  const root = tmp("build");
  const install = path.join(root, "install");
  fs.mkdirSync(path.join(install, "Base", "modules", "core"), { recursive: true });
  fs.writeFileSync(path.join(install, "Base", "modules", "core", "a.js"), "Game.turn; Store.getItem(k);");
  const findings = path.join(root, "findings.md");
  fs.writeFileSync(findings, FINDINGS);
  const paths = { install, evidence: path.join(root, "home", "evidence"), cdpPort: 9 };
  const bench = { paths, version: "1.5.0" };
  const first = await runBuild(bench, { verdicts: findings });
  assert.equal(first.summary.watched, 1, "only members a bold claim names earn WATCHED");
  fs.writeFileSync(path.join(root, "home", "atlas", "1.5.0.live-shell.json"), JSON.stringify({ ...LIVE.game, scope: "shell" }));
  assert.deepEqual(Object.keys(savedCrawls(path.join(root, "home", "atlas"), "1.5.0")), ["shell"]);
  const second = await runBuild(bench, {});
  assert.equal(second.summary.sources.verdicts.verdicts, 3, "the verdicts of the last build carry over");
  assert.equal(second.summary.live, 3);
  const offline = { ...bench, requireConnection: async () => { throw new Error("not connected") ; } };
  await assert.rejects(runBuild(offline, { live: true }), /not connected/, "a live build needs a connection");
  const q = new URLSearchParams({ q: "turn", member: "Game.turn", atlas: "1.5.0" });
  assert.equal((await ATLAS_ROUTES["GET /api/atlas/search"](bench, null, q)).results[0].path, "Game.turn");
  assert.equal((await ATLAS_ROUTES["GET /api/atlas/show"](bench, null, q)).member.path, "Game.turn");
  const lines = [];
  const log = console.log;
  console.log = (s) => lines.push(s);
  try {
    await ATLAS_COMMANDS.atlas({ bench, paths, opt: { atlas: "1.5.0" } }, ["show", "Game.turn"], "atlas");
  } finally { console.log = log; }
  assert.match(lines[0], /^Game\.turn \(game 1\.5\.0\): accessor/);
  assert.throws(() => ATLAS_COMMANDS.atlas({ bench, paths, opt: {} }, ["export"], "atlas"), /export --md <dir>/);
});
