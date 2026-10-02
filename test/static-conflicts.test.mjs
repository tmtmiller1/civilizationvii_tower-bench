import assert from "node:assert/strict";
import { before, test } from "node:test";
import { findConflicts } from "../lib/static/conflicts.mjs";
import { Schema, Vanilla } from "../lib/static/game.mjs";
import { loadMod } from "../lib/static/mod.mjs";
import { group, makeInstall, makeMod, makeUserDir, tmp } from "./fixtures/static/make.mjs";

/** @type {Vanilla} */
let vanilla;
/** @type {Schema | null} */
let schema;
let parent = "";
let n = 0;

before(() => {
  vanilla = Vanilla.load(makeInstall(tmp()));
  schema = Schema.load(makeUserDir(tmp())).schema;
  parent = tmp("tb-static-pairs-");
});

/** A mod whose single UIScript is `js`. */
function scriptMod(js, id = `m${++n}`) {
  return loadMod(makeMod(parent, id, { groups: group("g", "game", "always", { UIScripts: ["ui/s.js"] }), files: { "ui/s.js": js } }), { vanilla });
}

function dataMod(xml, id = `d${++n}`) {
  return loadMod(makeMod(parent, id, {
    groups: group("g", "game", "always", { UpdateDatabase: ["data/d.xml"], UpdateText: ["text/t.xml"] }),
    files: { "data/d.xml": `<Database>${xml}</Database>`, "text/t.xml": "<Database><EnglishText/></Database>" },
  }), { vanilla });
}

const between = (a, b) => findConflicts([a, b], { vanilla, schema });

test("two plain overwrites of one global conflict", () => {
  const c = between(scriptMod("globalThis.SharedThing = { a: 1 };"), scriptMod("window.SharedThing = { b: 2 };"));
  assert.deepEqual(c.map((x) => [x.rule, x.severity]), [["shared-global", "Medium"]]);
  assert.equal(c[0].static, true);
});

test("cooperative merges into one global are not a conflict", () => {
  const forms = [
    "globalThis.SharedThing = Object.assign(globalThis.SharedThing || {}, { a: 1 });",
    "window.SharedThing = { ...(window.SharedThing || {}), b: 2 };",
    "globalThis.SharedThing = globalThis.SharedThing ?? [];",
    "if (!globalThis.SharedThing) {\n  globalThis.SharedThing = {};\n}\nglobalThis.SharedThing.c = 3;",
    "globalThis.SharedThing ??= {};\nglobalThis.SharedThing.d = 4;",
  ];
  const mods = forms.map((js) => scriptMod(js));
  assert.deepEqual(findConflicts(mods, { vanilla, schema }), []);
});

test("a merge next to a plain overwrite still conflicts, and says which one overwrites", () => {
  const coop = scriptMod("globalThis.SharedThing = Object.assign(globalThis.SharedThing || {}, { a: 1 });", "coop-mod");
  const c = between(coop, scriptMod("globalThis.SharedThing = { b: 2 };"));
  assert.equal(c.length, 1);
  assert.match(c[0].text, /coop-mod merges into it, the other overwrites it/);
});

test("decorator chains stay Low; two defines of one component are High", () => {
  const dec = between(scriptMod("Controls.decorate('panel-x', A);"), scriptMod("Controls.decorate('panel-x', B);"));
  assert.deepEqual(dec.map((x) => [x.rule, x.severity]), [["decorate-chain", "Low"]]);
  const def = between(scriptMod("Controls.define('panel-x', A);"), scriptMod("Controls.decorate('panel-x', B); Controls.define('panel-x', B);"));
  assert.deepEqual(def.map((x) => x.rule).sort(), ["define-collision", "define-over-decorated"]);
});

test("the shared modSettings localStorage key is not a conflict; another shared key is", () => {
  const ls = (k) => scriptMod(`localStorage.setItem('${k}', '1');`);
  assert.deepEqual(between(ls("modSettings"), ls("modSettings")), []);
  assert.equal(between(ls("myKey"), ls("myKey"))[0].rule, "localstorage-key");
});

test("prototype patches and ui-next registrations of one name conflict", () => {
  const proto = between(scriptMod("Panel.prototype.render = function () {};"), scriptMod("Panel.prototype.render = wrap;"));
  assert.equal(proto[0].rule, "proto-patch");
  const reg = "ComponentRegistry.register({ name: 'thing', component: X });";
  assert.equal(between(scriptMod(reg), scriptMod(reg))[0].rule, "registry-collision");
});

test("two mods with one modinfo id conflict", () => {
  const a = loadMod(makeMod(tmp(), "same", { groups: "" }), { vanilla });
  const b = loadMod(makeMod(tmp(), "same", { groups: "" }), { vanilla });
  const c = between(a, b);
  assert.deepEqual(c.map((x) => [x.rule, x.severity, x.a, x.b]), [["same-id", "High", "same", "same"]]);
  assert.notEqual(c[0].aRoot, c[0].bRoot);
});

test("database rows: plain inserts of one key are High, differing Replaces Medium, identical Replaces nothing", () => {
  const row = (mode, name) => `<Traditions><${mode} TraditionType="T_SHARED" Name="${name}" CultureSlotType="S"/></Traditions>`;
  assert.deepEqual(between(dataMod(row("Row", "a")), dataMod(row("Row", "b"))).map((x) => [x.rule, x.severity]), [["db-key-collision", "High"]]);
  assert.deepEqual(between(dataMod(row("Replace", "a")), dataMod(row("Replace", "b"))).map((x) => x.severity), ["Medium"]);
  assert.deepEqual(between(dataMod(row("Replace", "a")), dataMod(row("Replace", "a"))), []);
  const upd = (v) => `<Nodes><Update><Where NodeType="NODE_A"/><Set Cost="${v}"/></Update></Nodes>`;
  assert.equal(between(dataMod(upd(1)), dataMod(upd(2)))[0].rule, "db-update-collision");
});

test("the same English text tag with different text is a Low conflict", () => {
  const text = (t) => loadMod(makeMod(parent, `t${++n}`, {
    groups: group("g", "game", "always", { UpdateText: ["text/t.xml"] }),
    files: { "text/t.xml": `<Database><EnglishText><Replace Tag="LOC_SHARED"><Text>${t}</Text></Replace></EnglishText></Database>` },
  }), { vanilla });
  assert.deepEqual(between(text("one"), text("two")).map((x) => [x.rule, x.severity]), [["loc-tag-collision", "Low"]]);
  assert.deepEqual(between(text("same"), text("same")), []);
});

test("two different replacements of one vanilla script conflict; byte-identical ones are Low", () => {
  const replace = (body) => loadMod(makeMod(parent, `r${++n}`, {
    groups: group("g", "game", "always", { ImportFiles: ["ui/panels/panel-x.js"] }),
    files: { "ui/panels/panel-x.js": body },
  }), { vanilla });
  assert.deepEqual(between(replace("a"), replace("b")).map((x) => [x.rule, x.severity]), [["vanilla-file-override", "High"]]);
  assert.deepEqual(between(replace("a"), replace("a")).map((x) => x.severity), ["Low"]);
});
