import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SIGNATURES } from "../lib/signatures.mjs";
import {
  RULE_TECHNIQUES, loadTechniques, searchTechniques, techniqueIds, techniquesFor, techniquesForCode,
} from "../lib/techniques.mjs";

const LIB = loadTechniques();
const entry = (id, extra = {}) => ({
  id, title: id.replace(/-/g, " "), category: "c", purpose: "p", why: "w", status: "works", kind: "technique", ...extra,
});

function fixture() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tb-tq-")), "t.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, categories: [{ id: "c", title: "C" }], entries: [
    entry("lens-registration", { objects: ["LensManager"], purpose: "draw a map overlay" }),
    entry("shared-modsettings", { objects: ["localStorage"], purpose: "persist options" }),
    entry("decorate-dont-replace", { objects: ["Controls"] }),
  ] }));
  return loadTechniques(file);
}

test("search ranks by title and engine object, and an empty query lists everything", () => {
  const lib = fixture();
  assert.equal(searchTechniques("LensManager", lib)[0].id, "lens-registration");
  assert.equal(searchTechniques("persist", lib)[0].id, "shared-modsettings");
  assert.equal(searchTechniques("", lib).length, 3);
  assert.deepEqual(searchTechniques("nothing-like-this", lib), []);
});

test("console code offers the entries for the objects it names", () => {
  const lib = fixture();
  assert.deepEqual(techniquesForCode("LensManager.getActiveLens()", lib).map((t) => t.id), ["lens-registration"]);
  assert.deepEqual(techniquesForCode("Game.turn", lib), []);
});

test("a rule offers only entries the library has", () => {
  const lib = fixture();
  assert.deepEqual(techniqueIds("conflict:define-collision", lib), ["decorate-dont-replace"]);
  assert.deepEqual(techniquesFor("lint:italic", lib), []);
  assert.deepEqual(techniqueIds("no-such:rule", lib), []);
});

// The shipped library and the rule map must agree: a link that names a missing entry is a dead link.
test("every technique a rule names exists in the shipped library", () => {
  assert.ok(LIB.entries.length > 0, "lib/techniques/techniques.json is missing or empty");
  const ids = new Set(LIB.entries.map((t) => t.id));
  const missing = Object.entries(RULE_TECHNIQUES).flatMap(([rule, list]) => list.filter((id) => !ids.has(id)).map((id) => `${rule} -> ${id}`));
  assert.deepEqual(missing, []);
});

// Signatures that describe something no technique fixes: an unknown error, a parse warning, a missing
// asset, the tail of a rollback, or another language's own error.
const UNMAPPED_SIGNATURES = new Set([
  "generic-error", "html-parse", "missing-asset", "db-rollback-consequence", "python-error", "lua-error",
]);

test("every log signature that reports a fixable problem links to at least one technique", () => {
  const unlinked = SIGNATURES.map((s) => s.id)
    .filter((id) => !UNMAPPED_SIGNATURES.has(id) && !(RULE_TECHNIQUES[`log:${id}`]?.length));
  assert.deepEqual(unlinked, []);
});

test("every lint rule links to a technique", () => {
  for (const rule of ["italic", "border-color", "subpixel-border", "unresolved-text"]) {
    assert.ok(RULE_TECHNIQUES[`lint:${rule}`]?.length, rule);
  }
});

test("library entries are well formed and their related links resolve", () => {
  const ids = new Set(LIB.entries.map((t) => t.id));
  const cats = new Set(LIB.categories.map((c) => c.id));
  for (const t of LIB.entries) {
    for (const k of ["id", "title", "category", "purpose", "why", "status", "kind"]) assert.ok(t[k], `${t.id}: ${k}`);
    assert.ok(cats.has(t.category), `${t.id}: unknown category ${t.category}`);
    assert.ok(["works", "changed", "dead"].includes(t.status), `${t.id}: status ${t.status}`);
    assert.ok(["technique", "avoid"].includes(t.kind), `${t.id}: kind ${t.kind}`);
    for (const r of t.related ?? []) assert.ok(ids.has(r), `${t.id}: related ${r} does not exist`);
  }
  assert.equal(ids.size, LIB.entries.length, "duplicate ids");
});

test("a passing lab recipe marks its techniques watched; a later failure shows as the latest run", async () => {
  const { recordTechniqueRun, libraryWithRuns } = await import("../lib/techniques.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-watched-"));
  const paths = { evidence: path.join(root, "evidence") };
  const lib = fixture();
  recordTechniqueRun(paths, { ids: ["lens-registration"], recipe: "lens-check", passed: true, version: "1.5.0" });
  let e = libraryWithRuns(paths, lib).entries.find((t) => t.id === "lens-registration");
  assert.equal(e.watched.recipe, "lens-check");
  recordTechniqueRun(paths, { ids: ["lens-registration"], recipe: "lens-check", passed: false, version: "1.5.1" });
  e = libraryWithRuns(paths, lib).entries.find((t) => t.id === "lens-registration");
  assert.equal(e.watched.version, "1.5.0", "the last pass is kept");
  assert.equal(e.lastRun.passed, false);
  assert.equal(libraryWithRuns(paths, lib).entries.find((t) => t.id === "shared-modsettings").watched, undefined);
});

test("only a recipe run in a lab game records techniques, and unknown ids are refused", async () => {
  const { runRecipe, validateRecipe } = await import("../lib/recipes.mjs");
  const { readWatched } = await import("../lib/techniques.mjs");
  assert.match(validateRecipe({ techniques: ["no-such-technique"], steps: [{ eval: "1" }] }), /unknown technique/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-watched-"));
  const id = LIB.entries[0].id;
  const bench = { paths: { evidence: path.join(root, "evidence") }, version: "1.5.0",
    status: async () => ({}), eval: async () => true };
  const recipe = { name: "r", techniques: [id], steps: [{ eval: "true" }] };
  await runRecipe(bench, recipe, {});
  assert.deepEqual(readWatched(bench.paths), {}, "outside a lab nothing is recorded");
  await runRecipe(bench, recipe, { endTurns: async () => [] });
  assert.equal(readWatched(bench.paths)[id].length, 1);
});
