import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { afterEach, test } from "node:test";
import { tokenize } from "../lib/instrument-lex.mjs";
import { fileIdOf, findSites, instrumentChecked, instrumentSource } from "../lib/instrument.mjs";
import { parseCoverageLog } from "../lib/coverage-map.mjs";

const g = /** @type {any} */ (globalThis);
afterEach(() => { delete g.__tbCov; delete g.__tbCoverage; delete g.__tbCovDump; });

const kinds = (src) => tokenize(src).tokens.map((t) => `${t.t}:${t.v}`);

test("a slash after a value divides; after an operator or keyword it opens a regex", () => {
  assert.deepEqual(kinds("a / b / c"), ["name:a", "punct:/", "name:b", "punct:/", "name:c"]);
  assert.ok(kinds("x = /a\\/b[/]c/gi.test(s)").includes("regex:/a\\/b[/]c/gi"));
  assert.ok(kinds("return /}/.test(s)").includes("regex:/}/"));
  assert.ok(kinds("f(1) / 2").includes("punct:/"));
});

test("strings, comments and nested templates hide their braces", () => {
  const src = "const s = '{'; /* { */ // }\nconst t = `a ${ `b ${ {c: 1}.c }` } d`; const u = \"}\";";
  const r = tokenize(src);
  assert.equal(r.error, null);
  assert.equal(findSites(src).sites.length, 0);
  assert.ok(tokenize("x = `unterminated").error);
  assert.ok(tokenize("x = /* open").error);
});

const SAMPLE = `"use strict";
import { x } from "./a.js";
class Foo extends Bar {
  static count = 0;
  constructor(a = {b: 1}) { super(); this.h = () => { return 1; }; }
  get size() { return 1; }
  static async *gen() { yield 1; }
  onClick = (e) => { if (e) { return 1; } else { return 2; } };
  catch(fn) { return fn; }
  get class() { return "c"; }
}
const obj = { a: 1, foo() { return 1; }, "bar": function () {}, baz: async x => { switch (x) { case 1: { break; } default: { } } } };
function top(a) { "use strict"; try { a(); } catch (e) { } finally {} }
export default function () { return cond ? { a: 1 } : { b: 2 }; }
const pick = flag ? flag : { run() { return 1; } };
on("Evt", function () { label: { } });
`;

test("finds every function body and branch block, with names a person can find", () => {
  const { sites, esm, error } = findSites(SAMPLE);
  assert.equal(error, null);
  assert.equal(esm, true);
  const fns = sites.filter((s) => s.k === "f").map((s) => `${s.kind} ${s.name} @${s.line}`);
  assert.deepEqual(fns, [
    "method Foo.constructor @5", "arrow this.h @5", "method Foo.get size @6", "method Foo.gen @7",
    "arrow Foo.onClick @8", "method Foo.catch @9", "method Foo.get class @10",
    "method obj.foo @12", "function obj.bar @12", "arrow obj.baz @12", "function top @13", "function default @14",
    "method run @15", "function (on callback) @16",
  ]);
  const blocks = sites.filter((s) => s.k === "b").map((s) => `${s.kind}@${s.line}`);
  assert.deepEqual(blocks, ["if@8", "else@8", "case@12", "case@12", "catch@13"]);
});

test("the counting copy keeps every line where it was and parses", () => {
  const r = instrumentSource(SAMPLE, { fileId: 7, modId: "m", rel: "x.js" });
  assert.equal(r.error, null);
  const a = SAMPLE.split("\n");
  const b = r.code.split("\n");
  assert.equal(b.length, a.length);
  for (let i = 1; i < a.length; i++) assert.equal(b[i].replace(/globalThis\.__tbCov\?\.\(7,\d+\);/g, ""), a[i]);
  assert.ok(b[0].startsWith('"use strict";(function(g){'), "a leading directive stays first");
  assert.match(r.code, /"use strict";globalThis\.__tbCov\?\.\(7,\d+\); try/, "a body's directive stays first");
  assert.equal(r.table.length, 19);
  const checked = instrumentChecked(SAMPLE.replace("import { x } from \"./a.js\";", ""), { fileId: 7, modId: "m", rel: "x.js" });
  assert.equal(checked.skipped, null);
});

test("a file that does not parse is left plain, with the reason", () => {
  const r = instrumentChecked("function f() { return 1;\n", { fileId: 1, modId: "m", rel: "a.js" });
  assert.match(String(r.skipped), /not instrumented: unbalanced braces/);
  assert.equal(r.code, "function f() { return 1;\n");
  const bad = instrumentChecked("let a = 1; let a = 2;\nfunction f() {}\n", { fileId: 1, modId: "m", rel: "a.js" });
  assert.match(String(bad.skipped), /the source itself does not parse/);
});

test("file ids are stable per mod and path", () => {
  assert.equal(fileIdOf("mod", "ui/a.js"), fileIdOf("mod", "ui/a.js"));
  assert.notEqual(fileIdOf("mod", "ui/a.js"), fileIdOf("mod", "ui/b.js"));
});

const MODULE = `export function add(a, b) { if (a > b) { return a + b; } else { return b + a; } }
export const twice = (f) => { return f() + f(); };
export function unused() { return 0; }
`;

test("an instrumented module counts each function and branch it runs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-instr-"));
  const r = instrumentSource(MODULE, { fileId: 42, modId: "m", rel: "lib.js" });
  const file = path.join(dir, "lib.mjs");
  fs.writeFileSync(file, r.code);
  const m = await import(pathToFileURL(file).href);
  m.add(2, 1);
  m.add(1, 2);
  m.twice(() => m.add(3, 1));
  const c = g.__tbCoverage.files[42].c;
  const at = (name, k = "f") => r.table.findIndex((s) => s.k === k && s.name === name);
  assert.equal(c[at("add")], 4);
  assert.equal(c[at("twice")], 1);
  assert.equal(c[at("unused")], undefined);
  const ifs = r.table.map((s, n) => [s, n]).filter(([s]) => s.k === "b");
  assert.deepEqual(ifs.map(([s, n]) => `${s.kind}=${c[n]}`), ["if=3", "else=1"]);
  const lines = [];
  const orig = console.error;
  console.error = (l) => lines.push(l);
  try { assert.equal(g.__tbCovDump(), 1); } finally { console.error = orig; }
  const parsed = parseCoverageLog(lines.map((l) => `[2026-10-02 10:00:00]\t${l}`).join("\n"));
  assert.deepEqual(parsed.counts["42"].c, Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v])));
});

test("a classic script keeps strict mode and installs the counter once", () => {
  const script = `"use strict"\nfunction who() { return this; }\nvar r = who();\n`;
  const a = instrumentSource(script, { fileId: 1, modId: "m", rel: "a.js" });
  const b = instrumentSource("function other() { return 2; }\nother();\n", { fileId: 2, modId: "m", rel: "b.js" });
  const ctx = vm.createContext({ console });
  vm.runInContext(a.code, ctx);
  vm.runInContext(b.code, ctx);
  assert.equal(vm.runInContext("r", ctx), undefined, "still strict: this is undefined");
  const cov = vm.runInContext("__tbCoverage", ctx);
  assert.deepEqual(Object.keys(cov.files).sort(), ["1", "2"]);
  assert.equal(cov.files[1].c[0], 1);
  assert.equal(cov.files[2].c[0], 1);
});

test("a CRLF line continuation stays inside its string, and a byte-order mark stays first", () => {
  assert.deepEqual(tokenize("var a = 'x\\\r\ny'; b").tokens.map((t) => t.t), ["name", "name", "punct", "str", "punct", "name"]);
  const r = instrumentSource("﻿function f() { return 1; }\n", { fileId: 5, modId: "m", rel: "a.js" });
  assert.ok(r.code.startsWith("﻿(function(g){"));
  assert.equal(r.table.length, 1);
});
