import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, modOf } from "../lib/signatures.mjs";

// Lines from the 1.5.0 logs, 2026-09-26, with mod and asset names replaced by neutral ones.
const REAL = {
  civ6Verb: "[2026-09-26 17:22:16]\tWarning: Apply Actions - No registered handler for 'game-example-always (ReplaceUIScript)'.",
  scopeNoise: "[2026-09-26 17:22:15]\tWarning: Apply Actions - No registered handler for 'shell-example (UpdateText)'.",
  textIssues: "[2026-09-26 17:22:15]\tWarning: There were issues loading 'text/en_us/ExampleText.xml' but it safe to continue.",
  missingAsset: "[2026-09-26 17:22:11]\tResourceRequestJob | Failed loading resource: blp:lp_circ_example_256",
  startupMessages: "[2026-09-26 17:22:08]\t[localization]: StartupErrorMessages.xml",
  htmlParse: "[2026-09-26 17:22:18]\tHTML Parser Error@:fs://game/root-game.html@1:2043: Premature end of file  Currently open tags: html, div, div..",
};

test("a Civ VI action verb is a warning that names the dead action group", () => {
  const r = classify(REAL.civ6Verb);
  assert.equal(r.signature, "civ6-verb");
  assert.equal(r.severity, "warn");
  assert.match(r.hint, /ReplaceUIScript is a Civ VI action/);
  assert.match(r.hint, /game-example-always/);
});

test("a valid Civ VII verb without a handler in this scope is noise", () => {
  const r = classify(REAL.scopeNoise);
  assert.equal(r.signature, "civ6-verb");
  assert.equal(r.severity, "noise");
});

test("text-file load issues warn about the whole file being dropped", () => {
  const r = classify(REAL.textIssues);
  assert.equal(r.severity, "warn");
  assert.match(r.hint, /ExampleText\.xml/);
  assert.match(r.hint, /duplicate LOC tag/);
});

test("a missing blp asset names the asset", () => {
  const r = classify(REAL.missingAsset);
  assert.equal(r.signature, "missing-asset");
  assert.match(r.hint, /blp:lp_circ_example_256/);
});

test("a file NAMED like an error is not an error", () => {
  const r = classify(REAL.startupMessages);
  assert.equal(r.severity, "info");
  assert.equal(r.signature, null);
});

test("HTML parser errors are warnings, and root-game.html is not attributed to a mod", () => {
  const r = classify(REAL.htmlParse);
  assert.equal(r.signature, "html-parse");
  assert.equal(r.mod, null);
});

test("GameFace CSS grid failures are errors", () => {
  assert.equal(classify("CSS parse error near text: 1fr 2fr").signature, "css-grid");
});

test("modOf attributes UI files to the mod root and ignores official roots", () => {
  assert.equal(modOf("TypeError at fs://game/example-mod/ui/screen.js:12"), "example-mod");
  assert.equal(modOf("at fs://game/base-standard/ui/x.js:1"), null);
  assert.equal(modOf("at fs://game/core/ui/x.js:1"), null);
  assert.equal(modOf("Failed loading resource: fs://game/icon_right_bumper"), null);
});

// A failed database action and a module that fails to load, from watched 1.5.0 repro runs
// (2026-09-21/22), with mod names replaced by neutral ones.
const ROLLBACK = [
  "[2026-09-21 18:45:00]\tWarning: UpdateDatabase - Error Loading XML.",
  "[2026-09-21 18:45:00]\tERROR: There were errors loading 'data/age-anti/mod_data.xml' that require a rollback.",
  "[2026-09-21 18:45:00]\tWarning: Apply Actions - Errors when applying action 'age-anti-main (UpdateDatabase)'. Rollback Required.",
  "[2026-09-21 18:45:00]\tERROR: Failed to apply enabled components.",
  "[2026-09-21 18:45:00]\tERROR: Rolling back database to a good state.",
  "[2026-09-21 18:45:00]\tPerforming a complete rollback to vanilla.",
];

test("a database rollback reads as one incident: cause and outcome are errors, the rest noise", () => {
  const r = ROLLBACK.map(classify);
  assert.equal(r[1].signature, "db-rollback-file");
  assert.match(r[1].hint, /data\/age-anti\/mod_data\.xml/);
  assert.equal(r[2].signature, "db-rollback-action");
  assert.match(r[2].hint, /'age-anti-main' \(UpdateDatabase\)/);
  assert.equal(r[3].signature, "db-rollback");
  assert.match(r[3].hint, /validation error/);
  assert.deepEqual([r[4].severity, r[5].severity], ["noise", "noise"]);
  assert.equal(r.filter((x) => x.severity === "error").length, 3);
});

test("an invalid reference names the missing type and the column that points at it", () => {
  const r = classify("[2026-09-21 22:42:57]\t[gameplay] ERROR: Invalid Reference on DynamicModifiers.EffectType - \"EFFECT_EXAMPLE_REMOVED\" does not exist in Types");
  assert.equal(r.signature, "invalid-reference");
  assert.equal(r.severity, "error");
  assert.match(r.hint, /EFFECT_EXAMPLE_REMOVED is not defined in Types/);
  assert.match(r.hint, /DynamicModifiers\.EffectType/);
  assert.equal(classify("[2026-09-21 22:42:57]\t[gameplay]: Failed Validation.").severity, "noise");
});

test("a missing .chunk.js bundle is an import error, not a missing asset", () => {
  const resource = classify("[2026-09-22 07:04:32]\tResourceRequestJob | Failed loading resource: fs://game/core/ui/shell/example/example-manager.chunk.js");
  assert.equal(resource.signature, "chunk-import");
  assert.match(resource.hint, /example-manager\.chunk\.js/);
  assert.match(resource.hint, /without "\.chunk"/);
  const open = classify("[2026-09-22 07:04:32]\tFailed to open file - /Game/Resources/Base/modules/core/ui/example/example-model.chunk.js");
  assert.equal(open.signature, "chunk-import");
});

test("a SOURCE ERROR names the module and is attributed to its mod", () => {
  const r = classify("[2026-09-22 07:04:32]\tSOURCE ERROR - /example-mod/patch/shell.js ");
  assert.equal(r.signature, "source-error");
  assert.equal(r.severity, "error");
  assert.equal(r.mod, "example-mod");
  assert.match(r.hint, /\/example-mod\/patch\/shell\.js failed to load/);
  assert.equal(classify("[t]\tSOURCE ERROR - /core/ui/x.js").mod, null);
});

test("a main-menu file that needs a rollback ends in a config failure, not a game rollback", () => {
  const lines = [
    "[2026-09-21 22:35:21]\tERROR: There were errors loading 'config/config.xml' that require a rollback.",
    "[2026-09-21 22:35:21]\tWarning: Apply Actions - Errors when applying action 'shell-example (UpdateDatabase)'. Rollback Required.",
    "[2026-09-21 22:35:21]\tERROR: There was an error applying config actions.",
  ].map(classify);
  assert.deepEqual(lines.map((r) => r.signature), ["db-rollback-file", "db-rollback-action", "config-rollback"]);
  assert.doesNotMatch(lines[0].hint, /every mod/);
  assert.match(lines[2].hint, /main-menu/);
});

test("Python and Lua errors from in-page interpreters are classified, not lost as info", () => {
  assert.equal(classify("[2026-10-02 10:00:00]\tTraceback (most recent call last):").signature, "python-error");
  assert.equal(classify("[2026-10-02 10:00:00]\t  File \"fs://game/my-mod/ui/main.py\", line 4, in <module>").signature, "python-error");
  assert.equal(classify("[2026-10-02 10:00:00]\tNameError: name 'Players' is not defined").signature, "python-error");
  const lua = classify("[2026-10-02 10:00:00]\tUncaught [string \"main.lua\"]:3: attempt to index a nil value (global 'Game')");
  assert.equal(lua.signature, "lua-error");
  assert.equal(classify("[t]\tTypeError: x is not a function").signature, "js-error");
});
