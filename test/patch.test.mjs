import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { BenchError } from "../lib/bench.mjs";
import { PATCH_COMMANDS } from "../lib/cli/patch.mjs";
import { diffIndexes } from "../lib/patch-diff.mjs";
import { gameTarget, importClauses, indexView } from "../lib/patch-impact.mjs";
import {
  buildIndex, compareVersions, componentsOf, listIndexes, parseExports, readIndex, writeIndex,
} from "../lib/patch-snapshot.mjs";
import { expandFolder, impactContext, impactGame, impactOfFolders, snapshotGame, versionChanged } from "../lib/patch.mjs";
import { loadMod } from "../lib/static/mod.mjs";
import { group, modinfo, tmp, writeTree } from "./fixtures/static/make.mjs";

const plist = (v) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${v}</string></dict></plist>`;

// Two fake installs: what a mod could rely on in 1.0.0, and what 1.1.0 changed.
const V1 = {
  "core/ui/input/focus-manager.js": "class FocusManager {}\nexport { FocusManager as default };",
  "core/ui/panel-support.chunk.js": "class P {}\nexport { P as P, AnchorType as A };",
  "core/ui/utilities/utilities-image.js": "export function loadImage() {}\nexport const ImageCache = 1;",
  "core/ui/utilities/same.js": "export const Same = 1;",
  "base-standard/ui/diplomacy/diplomacy-manager.js": "class DiplomacyManager {}\nexport { DiplomacyManager as L, DiplomacyManager as default };",
  "base-standard/ui/panels/panel-old.js": "Controls.define('panel-old', {});\nexport {};",
  "base-standard/ui/options/screen-options.js": "// v1\nexport const Options = 1;",
  "base-standard/ui/unchanged.js": "export const U = 1;",
};
const V2 = {
  "core/ui-next/services/focus-manager.js": "class FocusManager {}\nexport { FocusManager };",
  "core/ui/panel-support.js": "class Panel {}\nexport { AnchorType, Panel as default };",
  "core/ui/utilities/utilities-image.js": "export function loadImage() {}",
  "core/ui/utils/same.js": "export const Same = 1;",
  "base-standard/ui/diplomacy/diplomacy-manager.js": "class DiplomacyManager {}\nexport { DiplomacyManager as default };",
  "base-standard/ui/panels/panel-new.js": "ComponentRegistry.register({ name: \"PanelNew\", createInstance: X });",
  "base-standard/ui/options/screen-options.js": "// v2\nexport const Options = 2;",
  "base-standard/ui/unchanged.js": "export const U = 1;",
};

function makeDb(dir, { required, removedTable, effects, extraCol }) {
  fs.mkdirSync(dir, { recursive: true });
  const cso = required ? "CultureSlotType TEXT NOT NULL" : "Grantable INTEGER";
  const sql = [
    "CREATE TABLE Types (Type TEXT PRIMARY KEY, Kind TEXT NOT NULL);",
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1100) INSERT INTO Types SELECT 'TYPE_' || i, 'KIND_X' FROM n;",
    ...effects.map((e) => `INSERT INTO Types VALUES ('${e}', 'KIND_EFFECT');`),
    "CREATE TABLE DynamicModifiers (ModifierType TEXT PRIMARY KEY, CollectionType TEXT, EffectType TEXT);",
    `CREATE TABLE Traditions (TraditionType TEXT PRIMARY KEY, Name TEXT NOT NULL, ${cso}${extraCol ? ", OldWeight INTEGER" : ""});`,
    removedTable ? "CREATE TABLE MapExtras (MapType TEXT PRIMARY KEY);" : "CREATE TABLE MapNew (MapType TEXT PRIMARY KEY);",
  ].join("\n");
  execFileSync("sqlite3", [path.join(dir, "gameplay-copy.sqlite"), sql]);
  return dir;
}

function makeInstall(root, version, files) {
  writeTree(root, { "Contents/Info.plist": plist(version) });
  const res = path.join(root, "Contents", "Resources");
  for (const [rel, text] of Object.entries(files)) {
    const [mod, ...rest] = rel.split("/");
    writeTree(path.join(res, "Base", "modules", mod), { [rest.join("/")]: text });
  }
  writeTree(path.join(res, "DLC", "extra"), { "Platforms/Mac/art.blp": "binary", "modules/extra.modinfo": "<Mod/>" });
  return root;
}

const EFFECT = "EFFECT_GRANT_SOMETHING";

function setup() {
  const root = tmp("tb-patch-");
  const store = path.join(root, "store");
  const a = buildIndex({ install: makeInstall(path.join(root, "v1"), "1.0.0", V1), user: root },
    { version: "1.0.0", schemaDir: makeDb(path.join(root, "db1"), { required: false, removedTable: true, effects: [EFFECT], extraCol: true }) });
  const b = buildIndex({ install: makeInstall(path.join(root, "v2"), "1.1.0", V2), user: root },
    { version: "1.1.0", schemaDir: makeDb(path.join(root, "db2"), { required: true, removedTable: false, effects: [], extraCol: false }) });
  return { root, store, a, b };
}

function makeMod(root) {
  const dir = path.join(root, "mods", "sample-mod");
  writeTree(dir, {
    "sample-mod.modinfo": modinfo({ id: "sample-mod", groups: group("g", "game", "always", {
      UIScripts: ["ui/main.js"], ImportFiles: ["ui/options/screen-options.js"],
      UpdateDatabase: ["data/rows.xml", "data/effects.xml"],
    }) }),
    "ui/main.js": [
      "import FocusManager from '/core/ui/input/focus-manager.js';",
      "import { L as DiplomacyManager } from '/base-standard/ui/diplomacy/diplomacy-manager.js';",
      "import { P } from '/core/ui/panel-support.chunk.js';",
      "import { loadImage } from '/core/ui/utilities/utilities-image.js';",
      "import { Same } from '/core/ui/utilities/same.js';",
      "import { U } from '/base-standard/ui/unchanged.js';",
      "Controls.decorate('panel-old', (c) => ({}));",
    ].join("\n"),
    "ui/options/screen-options.js": "// v1\nexport const Options = 1;",
    "data/rows.xml": `<Database>
      <Traditions><Row TraditionType="TRADITION_A" Name="LOC_A" OldWeight="2"/></Traditions>
      <MapExtras><Row MapType="MAP_A"/></MapExtras>
    </Database>`,
    "data/effects.xml": `<GameEffects xmlns="GameEffects"><Modifier id="MOD_A" collection="COLLECTION_OWNER" effect="${EFFECT}"/></GameEffects>`,
  });
  return dir;
}

test("exports: lists with renames, declarations, default and star re-exports", () => {
  const r = parseExports(`/* export { Hidden } */
    export { a as b, c };
    export function f() {}
    export async function g() {}
    export class K {}
    export const x = 1, y = 2;
    export default Thing;
    export * from './other.js';
    export * as ns from './ns.js';
    export { z } from './z.js';`);
  assert.deepEqual(r.names, { b: "a", c: "", f: "", g: "", K: "", x: "", default: "", ns: "", z: "" });
  assert.deepEqual(r.stars, ["./other.js"]);
  assert.deepEqual(parseExports("export default class Foo {}").names, { default: "Foo" });
});

test("components: legacy tags through literals and TagName constants, ui-next registry names", () => {
  const c = componentsOf(`const BoxTagName = 'fxs-box';
    Controls.define(BoxTagName, {}); Controls.define("panel-a", {}); defineLegacyComponent("legacy-b", {});
    const X = ComponentRegistry.register({ name: "ScreenX", createInstance: Y });`);
  assert.deepEqual([...c.legacy].sort(), ["fxs-box", "legacy-b", "panel-a"]);
  assert.deepEqual([...c.registry], ["ScreenX"]);
});

test("versions sort numerically and indexes round-trip through gzip", () => {
  assert.ok(compareVersions("1.10.0", "1.9.2") > 0);
  assert.ok(compareVersions("1.4.2", "1.5.0") < 0);
  const { store, a, b } = setup();
  writeIndex(store, b);
  writeIndex(store, a);
  assert.deepEqual(listIndexes(store), ["1.0.0", "1.1.0"]);
  const back = readIndex(store, "1.0.0");
  assert.deepEqual(back.files, a.files);
  assert.ok(!Object.keys(a.files).some((k) => k.includes("Platforms")), "art packages are not indexed");
  assert.equal(a.files["base-standard/ui/unchanged.js"][0], b.files["base-standard/ui/unchanged.js"][0]);
  assert.throws(() => readIndex(store, "2.0.0"), /no game index for 2.0.0/);
  assert.throws(() => writeIndex(store, { ...a, version: "../x" }), /not a usable version/);
});

test("tables installed mods create are left out of the game's schema", () => {
  const root = tmp("tb-patch-modtables-");
  const install = makeInstall(path.join(root, "game"), "2.0.0", { "core/a.js": "export const A = 1;" });
  const db = makeDb(path.join(root, "db"), { required: true, removedTable: false, effects: [], extraCol: false });
  const idx = buildIndex({ install, user: root }, { version: "2.0.0", schemaDir: db, modTables: ["MapNew"] });
  assert.ok(idx.schema?.gameplay.traditions);
  assert.equal(idx.schema?.gameplay.mapnew, undefined);
  assert.deepEqual(idx.modTables, ["mapnew"]);
});

test("a Debug database older than the install is refused, not indexed as the new version", () => {
  const root = tmp("tb-patch-stale-");
  const install = makeInstall(path.join(root, "game"), "2.0.0", { "core/a.js": "export const A = 1;" });
  makeDb(path.join(root, "user", "Debug"), { required: true, removedTable: false, effects: [], extraCol: false });
  const old = new Date(Date.now() - 86400e3);
  fs.utimesSync(path.join(root, "user", "Debug", "gameplay-copy.sqlite"), old, old);
  const idx = buildIndex({ install, user: path.join(root, "user") }, { version: "2.0.0" });
  assert.equal(idx.schema, null);
  assert.match(String(idx.schemaNote), /predates this install/);
});

test("diff: moved by hash, renamed by name, changed, lost exports, components, schema, effect types", () => {
  const { a, b } = setup();
  const d = diffIndexes(a, b);
  const moved = Object.fromEntries(d.files.moved.map((m) => [m.from, [m.to, m.how]]));
  assert.deepEqual(moved["core/ui/utilities/same.js"], ["core/ui/utils/same.js", "moved"]);
  assert.deepEqual(moved["core/ui/input/focus-manager.js"], ["core/ui-next/services/focus-manager.js", "renamed"]);
  assert.deepEqual(moved["core/ui/panel-support.chunk.js"], ["core/ui/panel-support.js", "renamed"]);
  assert.deepEqual(d.files.removed, ["base-standard/ui/panels/panel-old.js"]);
  assert.ok(d.files.changed.includes("base-standard/ui/options/screen-options.js"));
  assert.ok(!d.files.changed.includes("base-standard/ui/unchanged.js"));
  const dm = d.exports.find((e) => e.file === "base-standard/ui/diplomacy/diplomacy-manager.js");
  assert.deepEqual(dm?.removed, ["L"]);
  const img = d.exports.find((e) => e.file === "core/ui/utilities/utilities-image.js");
  assert.deepEqual(img?.removed, ["ImageCache"]);
  const fm = d.exports.find((e) => e.file === "core/ui/input/focus-manager.js");
  assert.deepEqual(fm?.renamed, [{ from: "default", to: "FocusManager" }], "same local binding, new exported name");
  assert.deepEqual(d.components.legacy.removed, ["panel-old"]);
  assert.deepEqual(d.components.registry.added, ["PanelNew"]);
  assert.equal(d.schema.available, true);
  const s = /** @type {any} */ (d.schema);
  assert.deepEqual(s.tablesRemoved, [{ db: "gameplay", table: "MapExtras" }]);
  assert.deepEqual(s.tablesAdded, [{ db: "gameplay", table: "MapNew" }]);
  assert.deepEqual(s.nowRequired, [{ db: "gameplay", table: "Traditions", column: "cultureslottype" }]);
  assert.ok(s.columnsRemoved.some((c) => c.column === "oldweight"));
  assert.deepEqual(d.effectTypes.removed, [EFFECT]);
});

test("diff without a schema on one side says so instead of reporting every table as removed", () => {
  const { a, b } = setup();
  const d = diffIndexes(a, { ...b, schema: null, schemaNote: "start or load a game once" });
  assert.equal(d.schema.available, false);
  assert.match(String(/** @type {any} */ (d.schema).note), /1.1.0.*start or load a game once/);
  assert.equal(d.types.available, false);
});

test("import clauses carry the names they take", () => {
  const c = importClauses(`import D, { a as x, b } from '/m.js';
    import * as NS from './ns.js'; import './side.js'; export { q } from '../q.js'; import('/dyn.js');`);
  assert.deepEqual(c.map((x) => [x.spec, x.names, x.dynamic]), [
    ["/m.js", ["default", "a", "b"], false], ["./ns.js", null, false], ["./side.js", [], false],
    ["../q.js", ["q"], false], ["/dyn.js", null, true]]);
});

test("impact: every rule against a synthetic mod, each with the old and new fact and a fix", () => {
  const { root, a, b } = setup();
  const ctx = impactContext(a, b);
  const { mods, failed } = impactOfFolders(ctx, [makeMod(root)]);
  assert.deepEqual(failed, []);
  const f = mods[0].findings;
  const by = (rule) => f.filter((x) => x.rule === rule);
  const files = by("removed-file");
  const focus = files.find((x) => x.text.includes("focus-manager"));
  assert.match(String(focus?.now), /renamed to `\/core\/ui-next\/services\/focus-manager\.js`; it does not export `default`/);
  assert.match(String(focus?.fix), /core\/ui-next\/services\/focus-manager\.js/);
  assert.ok(files.some((x) => x.text.includes("panel-support.chunk.js")));
  assert.ok(files.some((x) => x.text.includes("same.js") && /moved unchanged/.test(x.now)));
  const exp = by("removed-export");
  assert.equal(exp.length, 1, "the mod imports loadImage, which survived; only L is gone");
  assert.ok(exp[0].text.includes("`L`"));
  assert.equal(by("removed-component")[0]?.text.includes("panel-old"), true);
  assert.equal(by("newly-required-column")[0]?.severity, "High");
  assert.match(String(by("newly-required-column")[0]?.fix), /cultureslottype/);
  assert.equal(by("removed-table").length, 1);
  assert.equal(by("removed-column").length, 1);
  assert.equal(by("removed-effect-type").length, 1);
  const stale = by("stale-override")[0];
  assert.match(String(stale?.text), /screen-options\.js.*changed in 1\.1\.0.*old file unchanged/);
  assert.ok(!f.some((x) => x.text.includes("unchanged.js")), "unchanged files raise nothing");
  assert.equal(f[0].severity, "High", "sorted worst first");
  for (const x of f) {
    assert.ok(x.was && x.now && x.fix, `${x.rule} has old, new and fix`);
    assert.ok(Array.isArray(x.techniques));
  }
  assert.ok(by("removed-file")[0].techniques.includes("import-current-paths"));
});

test("relative imports from a vanilla-mirroring file resolve to the game file they used to reach", () => {
  const { root, a } = setup();
  const dir = path.join(root, "mods", "mirror");
  writeTree(dir, {
    "mirror.modinfo": modinfo({ id: "mirror", groups: group("g", "game", "always", { UIScripts: ["ui/panels/x.js"] }) }),
    "ui/panels/x.js": "import { L } from '../diplomacy/diplomacy-manager.js';",
  });
  const view = indexView(a);
  const mod = loadMod(dir, { vanilla: /** @type {any} */ ({ roots: view.roots }) });
  assert.equal(gameTarget(mod, path.join(dir, "ui/panels/x.js"), "../diplomacy/diplomacy-manager.js", view),
    "base-standard/ui/diplomacy/diplomacy-manager.js");
  assert.equal(gameTarget(mod, path.join(dir, "ui/panels/x.js"), "https://example.com/x.js", view), null);
});

test("a folder of mods expands to its mod folders", () => {
  const root = tmp("tb-patch-many-");
  writeTree(root, { "one/a.modinfo": "<Mod/>", "two/inner/b.modinfo": "<Mod/>", "notes/readme.txt": "x" });
  assert.deepEqual(expandFolder(root).map((d) => path.basename(d)), ["one", "two"]);
  assert.deepEqual(expandFolder(path.join(root, "one")), [path.join(root, "one")]);
  assert.throws(() => expandFolder(path.join(root, "missing")), BenchError);
});

test("snapshot refuses to replace an index without yes, logs what it wrote; impact reads the store", () => {
  const root = tmp("tb-patch-bench-");
  const install = makeInstall(path.join(root, "game"), "1.1.0", V2);
  const logged = [];
  const paths = { install, user: path.join(root, "user"), evidence: path.join(root, "tb", "evidence"), modsDb: path.join(root, "none.sqlite") };
  const bench = /** @type {any} */ ({ paths, log: (e) => logged.push(e) });
  const r = snapshotGame(bench, { version: "1.1.0" });
  assert.equal(r.version, "1.1.0");
  assert.match(String(r.schemaNote), /no Debug database/);
  assert.equal(logged[0].kind, "game-snapshot");
  assert.throws(() => snapshotGame(bench, { version: "1.1.0" }), /--yes/);
  assert.equal(snapshotGame(bench, { version: "1.1.0", yes: true }).version, "1.1.0");
  assert.throws(() => impactGame(paths, { mods: [root] }), /need two game indexes/);
  const { a } = setup();
  writeIndex(path.join(root, "tb", "game-index"), { ...a, schema: null });
  const res = impactGame(paths, { mods: [makeMod(root)] });
  assert.equal(res.from, "1.0.0");
  assert.equal(res.to, "1.1.0");
  assert.match(String(res.schemaNote), /schema missing/);
  assert.ok(res.mods[0].findings.every((x) => !x.rule.includes("column") && x.rule !== "removed-table"));
});

test("versionChanged: none yet, current, and an update since the newest index", () => {
  const root = tmp("tb-patch-ver-");
  const install = makeInstall(path.join(root, "game"), "1.2.0", { "core/a.js": "" });
  const paths = { install, evidence: path.join(root, "tb", "evidence") };
  assert.match(String(versionChanged(paths)?.message), /no game index yet/);
  const { a, b } = setup();
  writeIndex(path.join(root, "tb", "game-index"), a);
  writeIndex(path.join(root, "tb", "game-index"), { ...b, version: "1.2.0" });
  assert.equal(versionChanged(paths)?.changed, false);
  fs.writeFileSync(path.join(install, "Contents", "Info.plist"), plist("1.3.0"));
  const v = versionChanged(paths);
  assert.equal(v?.changed, true);
  assert.match(String(v?.message), /1\.2\.0 -> 1\.3\.0.*game snapshot.*game impact.*loads no mods/);
  assert.equal(versionChanged({ install: null, evidence: paths.evidence }), null);
});

test("the game command routes its subcommands and refuses unknown ones", () => {
  const ctx = /** @type {any} */ ({ paths: {}, opt: {} });
  assert.throws(() => PATCH_COMMANDS.game(ctx, ["frobnicate"], "game"), BenchError);
});
