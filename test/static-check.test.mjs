import assert from "node:assert/strict";
import { before, test } from "node:test";
import { checkMod, runtimeRefs } from "../lib/static/check.mjs";
import { moduleRoots, Schema, Vanilla } from "../lib/static/game.mjs";
import { loadMod } from "../lib/static/mod.mjs";
import { group, makeInstall, makeMod, makeUserDir, tmp } from "./fixtures/static/make.mjs";

/** @type {Vanilla} */
let vanilla;
/** @type {Schema} */
let schema;
let mods = "";

before(() => {
  vanilla = Vanilla.load(makeInstall(tmp()));
  const loaded = Schema.load(makeUserDir(tmp()));
  assert.equal(loaded.full, true);
  schema = /** @type {Schema} */ (loaded.schema);
  mods = tmp("tb-static-mods-");
});

/** Writes a mod and checks it; returns its findings. */
function check(id, opts, otherMods = []) {
  const mod = loadMod(makeMod(mods, id, opts), { vanilla });
  return checkMod(mod, { vanilla, schema, otherMods });
}

const rules = (findings) => findings.map((f) => f.rule).sort();
const one = (findings, rule) => {
  const hit = findings.filter((f) => f.rule === rule);
  assert.equal(hit.length, 1, `${rule} in ${JSON.stringify(findings.map((f) => f.rule))}`);
  return hit[0];
};

const data = (id, xml, criteria = "always", scope = "game") => ({
  groups: group("g", scope, criteria, { UpdateDatabase: ["data/d.xml"] }),
  files: { "data/d.xml": `<Database>${xml}</Database>` },
});

test("the game tree indexes modules, components and the version", () => {
  assert.deepEqual([...vanilla.roots.keys()], ["base-standard", "core", "extra-civ"]);
  assert.equal(vanilla.version, "9.9.9");
  assert.ok(vanilla.hasPath("core/ui/utilities/utilities.js"));
  assert.ok(vanilla.components.has("panel-x"));
  assert.ok(vanilla.components.has("focus-thing"), "a define through a *TagName constant counts");
  assert.equal(Vanilla.load(vanilla.install), vanilla, "memoised per install path");
});

test("the Windows layout is found too", () => {
  const roots = moduleRoots(makeInstall(tmp(), { windows: true }));
  assert.deepEqual([...roots.keys()], ["base-standard", "core", "extra-civ"]);
});

test("a boot-time Debug copy reports the schema unavailable instead of producing findings", () => {
  const r = Schema.load(makeUserDir(tmp(), { boot: true }));
  assert.equal(r.full, false);
  assert.equal(r.schema, null);
  assert.match(String(r.reason), /start or load a game once/);
  assert.match(String(Schema.load(tmp()).reason), /schema unavailable/);
});

test("the schema reads keys, required columns and cascades", () => {
  assert.deepEqual(schema.find("gameplay", "nodeunlocks")?.pk, ["nodetype", "targettype"]);
  assert.deepEqual([...(schema.required.gameplay.get("traditions") ?? [])].sort(), ["cultureslottype", "name", "traditiontype"]);
  assert.equal(schema.required.gameplay.get("counters")?.has("id"), false, "an INTEGER primary key fills itself");
  assert.deepEqual(schema.cascades.gameplay.get("nodeunlocks"), [{ col: "nodetype", parent: "nodes", pcol: "nodetype" }]);
});

test("a missing NOT NULL column without a default blocks the game", () => {
  const f = one(check("req", data("req", `<Traditions><Row TraditionType="T1" Name="n"/></Traditions>`, "antiquity")), "missing-required-column");
  assert.equal(f.verdict, "BLOCKS GAME");
  assert.equal(f.age, "antiquity");
  assert.deepEqual(f.evidence.columns, ["cultureslottype"]);
  assert.equal(f.static, true);
});

test("an unknown table or column blocks the game; a table the mod creates does not", () => {
  const f = check("tbl", data("tbl", `<NoSuchTable><Row A="1"/></NoSuchTable><Nodes><Row NodeType="N9" Bogus="1"/></Nodes>`));
  assert.deepEqual(rules(f), ["unknown-column", "unknown-table"]);
  const sql = {
    groups: group("g", "game", "always", { UpdateDatabase: ["data/d.sql"] }),
    files: { "data/d.sql": "CREATE TABLE MyTable (Id TEXT); INSERT INTO MyTable (Id) VALUES ('a');" },
  };
  assert.deepEqual(check("own-table", sql), []);
});

test("a plain insert of a base row blocks the game in the age both load", () => {
  const f = one(check("dupe", data("dupe", `<TypeTags><Row Type="UNIT_X" Tag="TAG_A"/></TypeTags>`)), "duplicate-base-row");
  assert.equal(f.verdict, "BLOCKS GAME");
  assert.match(f.text, /base-standard\/data\/base\.xml/);
});

test("rows loaded in a different age from the base row never collide", () => {
  assert.deepEqual(check("ages", data("ages", `<TypeTags><Row Type="UNIT_ANT" Tag="TAG_A"/></TypeTags>`, "exploration")), []);
  one(check("ages2", data("ages2", `<TypeTags><Row Type="UNIT_ANT" Tag="TAG_A"/></TypeTags>`, "antiquity")), "duplicate-base-row");
});

test("a delete matched against the base row's old key re-adds instead of colliding", () => {
  const xml = `<Scorings><Delete TrackerType="TRACKER_OLD"/><Row VictoryType="VICTORY_A" TrackerType="TRACKER_NEW"/></Scorings>`;
  assert.deepEqual(check("del-old", data("del-old", xml)), []);
  const wrong = `<Scorings><Delete TrackerType="TRACKER_OTHER"/><Row VictoryType="VICTORY_A" TrackerType="TRACKER_NEW"/></Scorings>`;
  one(check("del-wrong", data("del-wrong", wrong)), "duplicate-base-row");
});

test("a Replace on the parent row clears its children through ON DELETE CASCADE", () => {
  const xml = `<Nodes><Replace NodeType="NODE_A"/></Nodes><NodeUnlocks><Row NodeType="NODE_A" TargetType="UNIT_X"/></NodeUnlocks>`;
  assert.deepEqual(check("cascade", data("cascade", xml)), []);
});

test("a modifier whose effect type the game does not define blocks the game; a gated group is not checked", () => {
  const effects = (id, criteria) => ({
    criteria: `<Criteria id="gated"><ModIsEnabled>other-mod</ModIsEnabled></Criteria>`,
    groups: group("g", "game", criteria, { UpdateDatabase: ["data/e.xml"] }),
    files: { "data/e.xml": `<GameEffects><Modifier id="M" effect="EFFECT_GONE" collection="COLLECTION_OWNER"/><Modifier id="K" effect="EFFECT_KEPT" collection="COLLECTION_OWNER"/></GameEffects>` },
  });
  const f = one(check("effect", effects("effect", "always")), "removed-effect-type");
  assert.deepEqual(f.evidence.values, ["EFFECT_GONE"]);
  assert.deepEqual(check("effect-gated", effects("effect-gated", "gated")), []);
});

test("a mismatched XML close tag is not a defect: the loader closes the innermost element", () => {
  const xml = `<Nodes><Row NodeType="N1"><Cost>2</Costs></Row></Nodes>`;
  assert.deepEqual(check("mismatch", data("mismatch", xml)), []);
  const truncated = { groups: group("g", "game", "always", { UpdateDatabase: ["data/d.xml"] }), files: { "data/d.xml": "<Database><Nodes>" } };
  assert.equal(one(check("truncated", truncated), "malformed-data-xml").verdict, "FEATURE DEAD");
});

test("a listed data file that does not ship blocks the game; a missing .dds is minor", () => {
  const f = check("missing", { groups: group("g", "game", "always", { UpdateText: ["text/gone.xml"], ImportFiles: ["art/gone.dds", "ui/gone.js"] }) });
  const byItem = Object.fromEntries(f.filter((x) => x.rule === "missing-listed-file")
    .flatMap((x) => x.evidence.items.map((i) => [i.item, x.verdict])));
  assert.deepEqual(byItem, { "text/gone.xml": "BLOCKS GAME", "art/gone.dds": "MINOR", "ui/gone.js": "FEATURE DEAD" });
});

test("an import of a game file that does not exist kills the module; the mod's own files and real game files resolve", () => {
  const f = check("imports", {
    groups: group("g", "game", "always", { UIScripts: ["core/ui/main.js"], ImportFiles: ["api/helper.js"] }),
    files: {
      // core/ui/main.js mirrors the game's core module, so '../api/helper.js' reads as /core/api/helper.js;
      // the mod ships api/helper.js and such an import was watched loading
      "core/ui/main.js": [
        "import { Utils } from '/core/ui/utilities/utilities.js';",
        "import '/core/ui/input/focus-manager.js';",
        "import { h } from '../api/helper.js';",
        "import { u } from '../ui/utilities/utilities.js';",
      ].join("\n"),
      "api/helper.js": "export const h = 1; export const g = 2;",
    },
  });
  const hit = one(f, "unresolved-import");
  assert.equal(hit.verdict, "FEATURE DEAD");
  assert.equal(hit.evidence.spec, "/core/ui/input/focus-manager.js");
});

test("only scripts reachable from the modinfo are analysed", () => {
  const mod = loadMod(makeMod(mods, "reach", {
    groups: group("g", "game", "always", { UIScripts: ["ui/entry.js"] }),
    files: { "ui/entry.js": "import './dep.js';", "ui/dep.js": "Controls.decorate('panel-x', D);", "ui/unused.js": "Controls.decorate('nothing-here', D);" },
  }), { vanilla });
  assert.deepEqual(Object.keys(mod.js.decorate), ["panel-x"]);
  assert.deepEqual(mod.unloadedJs, ["ui/unused.js"]);
});

test("a decorator whose target nothing defines never attaches", () => {
  const f = check("deco", { groups: group("g", "game", "always", { UIScripts: ["ui/d.js"] }), files: { "ui/d.js": "Controls.decorate('no-such-panel', D);" } });
  assert.equal(one(f, "unknown-decorate-target").verdict, "FEATURE DEAD");
});

test("a text tag that duplicates a base tag blocks the main menu when the file is shell text", () => {
  const f = check("dup-text", {
    groups: group("s", "shell", "always", { UpdateText: ["text/shell.xml"] }) + group("t", "game", "always", { UpdateText: ["text/game.xml"] }),
    files: {
      "text/shell.xml": `<Database><LocalizedText><Row Tag="LOC_SHELL_TAG" Language="en_US"><Text>Mine</Text></Row></LocalizedText></Database>`,
      "text/game.xml": `<Database><EnglishText><Replace Tag="LOC_BASE_NAME"><Text>Mine</Text></Replace><Row Tag="LOC_NEW"/></EnglishText></Database>`,
    },
  });
  const hit = one(f, "duplicate-loc-tag");
  assert.equal(hit.verdict, "BLOCKS GAME");
  assert.equal(hit.age, "main menu");
  assert.equal(hit.evidence.tags[0].tag, "LOC_SHELL_TAG");
});

test("the same tag in two per-age text files is not a duplicate", () => {
  const f = check("age-text", {
    groups: group("a", "game", "antiquity", { UpdateText: ["text/a.xml"] }) + group("e", "game", "exploration", { UpdateText: ["text/e.xml"] }),
    files: {
      "text/a.xml": `<Database><EnglishText><Row Tag="LOC_MINE"/></EnglishText></Database>`,
      "text/e.xml": `<Database><EnglishText><Row Tag="LOC_MINE"/></EnglishText></Database>`,
    },
  });
  assert.deepEqual(f, []);
});

test("a file fetched at run time that no action declares is flagged; declared and computed paths are not", () => {
  const mod = loadMod(makeMod(mods, "fetcher", {
    groups: group("g", "game", "always", { UIScripts: ["ui/f.js"], ImportFiles: ["data/listed.json"] }),
    files: {
      "ui/f.js": [
        "const x = new XMLHttpRequest(); x.open('GET', 'fs://game/fetcher/data/hidden.json');",
        "x.open('GET', 'fs://game/fetcher/' + 'data/listed.json');",
        "x.open('GET', base + name);",
        "const s = document.createElement('script'); s.src = '/fetcher/ui/extra.js';",
      ].join("\n"),
      "data/hidden.json": "{}", "data/listed.json": "{}", "ui/extra.js": "",
    },
  }), { vanilla });
  const r = runtimeRefs(mod);
  assert.deepEqual(r.undeclared.map((u) => u.path).sort(), ["data/hidden.json", "ui/extra.js"]);
  assert.equal(r.unresolved, 1);
  const f = checkMod(mod, { vanilla, schema, otherMods: [] }).filter((x) => x.rule === "undeclared-runtime-file");
  assert.equal(f.length, 1);
  assert.equal(f[0].verdict, "MINOR");
  assert.match(f[0].text, /1 computed path/);
});

test("a table another analysed mod creates is a dependency to declare, not an unknown table", () => {
  const creator = loadMod(makeMod(mods, "creator", {
    groups: group("g", "game", "always", { UpdateDatabase: ["data/c.sql"] }),
    files: { "data/c.sql": "CREATE TABLE SharedTable (Id TEXT);" },
  }), { vanilla });
  const user = data("user", `<SharedTable><Row Id="a"/></SharedTable>`);
  const f = check("user", user, [creator]);
  assert.deepEqual(rules(f), ["undeclared-table-dependency"]);
  const declared = { ...user, deps: `<Dependencies><Mod id="creator" title="c"/></Dependencies>` };
  assert.deepEqual(check("user2", declared, [creator]), []);
});

test("without a schema only the file and script checks run", () => {
  const mod = loadMod(makeMod(mods, "noschema", data("noschema", `<NoSuchTable><Row A="1"/></NoSuchTable>`)), { vanilla });
  assert.deepEqual(checkMod(mod, { vanilla, schema: null }), []);
});

test("modinfo items are found case-insensitively, as the game's file system does", () => {
  const mod = loadMod(makeMod(mods, "casing", {
    groups: group("g", "game", "always", { UIScripts: ["ui/Main.js"] }),
    files: { "UI/main.js": "Controls.define('casing-panel', {});" },
  }), { vanilla });
  assert.deepEqual(Object.keys(mod.js.define), ["casing-panel"]);
  assert.deepEqual(mod.missing, []);
});
