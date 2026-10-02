import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { parseSql, parseXmlDb } from "../lib/static/dbops.mjs";
import { literalValue, stripJsComments } from "../lib/static/jsscan.mjs";
import { groupAges, isConditional, parseModinfo } from "../lib/static/modinfo.mjs";
import { parseLenient, parseXml, XmlError } from "../lib/static/xml.mjs";
import { group, modinfo, tmp, writeTree } from "./fixtures/static/make.mjs";

test("the strict XML parser rejects what the game's tools reject", () => {
  for (const bad of ["<a><b></a>", "<a>x & y</a>", "<a><!-- x -- y --></a>", "<a/><b/>", "", "  <?xml version=\"1.0\"?><a/>"]) {
    assert.throws(() => parseXml(bad), XmlError, bad);
  }
  const root = parseXml("<?xml version=\"1.0\"?><R a=\"1 &amp; 2\"><C>t<!-- c -->u</C><D/></R>");
  assert.equal(root.attrs.a, "1 & 2");
  assert.equal(root.children[0].text, "tu");
  assert.deepEqual(root.children.map((c) => c.tag), ["C", "D"]);
});

test("a mismatched close tag closes the innermost element, as the game's loader does", () => {
  // the close tag names no open element (the table is <ModArgs>, not <ModArguments>)
  const text = `<Database><ModArgs><Row Id="A"><Value>1</ModArguments></Row><Row Id="B"/></ModArgs></Database>`;
  assert.throws(() => parseXml(text), XmlError);
  const { ops, error } = parseXmlDb(text);
  assert.equal(error, null);
  assert.deepEqual(ops.map((o) => o.values), [{ id: "A", value: "1" }, { id: "B" }]);
});

test("lenient parsing tolerates leading whitespace, '--' in comments and bare ampersands; junk still fails", () => {
  assert.equal(parseLenient("\n  <a><!-- x -- y --><b t=\"R&D\"/></a>").error, null);
  assert.match(String(parseLenient("<a/>junk<b/>").error), /junk after document element/);
  assert.match(String(parseLenient("").error), /no element found/);
});

test("XML database files become row operations", () => {
  const { ops } = parseXmlDb(`<Database>
    <Things><Row Id="A" Name="x"/><Replace Id="B"><Name>y</Name></Replace><InsertOrIgnore Id="C"/></Things>
    <Things><Update><Where Id="A"/><Set Name="z"/></Update><Delete Id="B"/></Things>
  </Database>`);
  assert.deepEqual(ops.map((o) => o.op), ["row", "replace", "ignore", "update", "delete"]);
  assert.deepEqual(ops[1].values, { id: "B", name: "y" });
  assert.deepEqual(ops[3].where, { id: "A" });
  assert.deepEqual(ops[3].set, { name: "z" });
  const effects = parseXmlDb(`<GameEffects><Modifier id="M1" effect="EFFECT_X" collection="COLLECTION_Y"/></GameEffects>`).ops;
  assert.equal(effects[0].table, "Modifiers");
  assert.equal(effects[0].partial, true);
  assert.equal(effects[0].effect, "EFFECT_X");
});

test("SQL statements become row operations", () => {
  const ops = parseSql(`-- comment
    INSERT INTO Things (Id, Name) VALUES ('A', 'it''s'), ('B', NULL);
    INSERT OR REPLACE INTO Things VALUES ('C', 'x');
    INSERT OR IGNORE INTO Things (Id) SELECT Id FROM Other;
    UPDATE Things SET Name = 'n' WHERE Id = 'A' AND Kind = 1;
    UPDATE Things SET Name = 'n' WHERE Id IN ('A');
    DELETE FROM Things WHERE Id = 'B';
    CREATE TABLE IF NOT EXISTS NewThings (Id TEXT);`);
  assert.deepEqual(ops.map((o) => o.op), ["row", "row", "replace", "ignore", "update", "update", "delete", "create"]);
  assert.deepEqual(ops[0].values, { id: "A", name: "it's" });
  assert.equal(ops[1].values?.name, null);
  assert.equal(ops[2].positional, true);
  assert.equal(ops[3].select, true);
  assert.deepEqual(ops[4].where, { id: "A", kind: "1" });
  assert.equal(ops[5].where, null, "an IN clause cannot be evaluated");
  assert.equal(ops[7].table, "NewThings");
});

test("a modinfo reads into groups with criteria, ages and items; items outside the folder are flagged", () => {
  const dir = tmp();
  const file = path.join(dir, "m.modinfo");
  writeTree(dir, {
    "m.modinfo": modinfo({
      id: "m",
      criteria: `<Criteria id="needs-other"><ModIsEnabled>other</ModIsEnabled></Criteria>`,
      groups: group("g1", "game", "antiquity", { UpdateDatabase: ["data/a.xml"], UIScripts: ["ui/a.js"] })
        + group("g2", "shell", "needs-other", { ImportFiles: ["../outside.js", "./ui/b.js"] }),
    }),
  });
  const mi = parseModinfo(file);
  assert.equal(mi.id, "m");
  assert.equal(mi.groups.length, 2);
  assert.deepEqual([...(groupAges(mi.groups[0]) ?? [])], ["antiquity"]);
  assert.equal(groupAges(mi.groups[1]), null);
  assert.equal(isConditional(mi.groups[1]), true);
  assert.deepEqual(mi.items, ["data/a.xml", "ui/a.js", "../outside.js", "ui/b.js"]);
  assert.deepEqual(mi.outside, ["../outside.js"]);
});

test("a malformed modinfo still yields its id", () => {
  const dir = tmp();
  writeTree(dir, { "m.modinfo": `<Mod id="broken"><Properties><Name>N</Name></Properties><ActionGroups></Mod>` });
  const mi = parseModinfo(path.join(dir, "m.modinfo"));
  assert.equal(mi.id, "broken");
  assert.ok(mi.xmlError);
});

test("JS comments are stripped but strings are kept; literal paths evaluate, computed ones do not", () => {
  assert.equal(stripJsComments("a // x\nb /* y\nz */ c 'not // a comment'"), "a \nb \n c 'not // a comment'");
  assert.equal(literalValue(`"fs://game/m/" + 'data.json'`), "fs://game/m/data.json");
  assert.equal(literalValue("base + 'x.json'"), null);
  assert.equal(literalValue("`a${b}`"), null);
});
