import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, modOf } from "../lib/signatures.mjs";

// Lines copied verbatim from the 1.5.0 logs on the development machine, 2026-09-26.
const REAL = {
  civ6Verb: "[2026-09-26 17:22:16]\tWarning: Apply Actions - No registered handler for 'game-artifacttweaks-always (ReplaceUIScript)'.",
  scopeNoise: "[2026-09-26 17:22:15]\tWarning: Apply Actions - No registered handler for 'shell-washington (UpdateText)'.",
  textIssues: "[2026-09-26 17:22:15]\tWarning: There were issues loading 'text/en_us/MoveLaterText.xml' but it safe to continue.",
  missingAsset: "[2026-09-26 17:22:11]\tResourceRequestJob | Failed loading resource: blp:lp_circ_alexander_256",
  startupMessages: "[2026-09-26 17:22:08]\t[localization]: StartupErrorMessages.xml",
  htmlParse: "[2026-09-26 17:22:18]\tHTML Parser Error@:fs://game/root-game.html@1:2043: Premature end of file  Currently open tags: html, div, div..",
};

test("a Civ VI action verb is a warning that names the dead action group", () => {
  const r = classify(REAL.civ6Verb);
  assert.equal(r.signature, "civ6-verb");
  assert.equal(r.severity, "warn");
  assert.match(r.hint, /ReplaceUIScript is a Civ VI action/);
  assert.match(r.hint, /game-artifacttweaks-always/);
});

test("a valid Civ VII verb without a handler in this scope is noise", () => {
  const r = classify(REAL.scopeNoise);
  assert.equal(r.signature, "civ6-verb");
  assert.equal(r.severity, "noise");
});

test("text-file load issues warn about the whole file being dropped", () => {
  const r = classify(REAL.textIssues);
  assert.equal(r.severity, "warn");
  assert.match(r.hint, /MoveLaterText\.xml/);
  assert.match(r.hint, /duplicate LOC tag/);
});

test("a missing blp asset names the asset", () => {
  const r = classify(REAL.missingAsset);
  assert.equal(r.signature, "missing-asset");
  assert.match(r.hint, /blp:lp_circ_alexander_256/);
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
  assert.equal(modOf("TypeError at fs://game/demographics/ui/screen.js:12"), "demographics");
  assert.equal(modOf("at fs://game/base-standard/ui/x.js:1"), null);
  assert.equal(modOf("at fs://game/core/ui/x.js:1"), null);
  assert.equal(modOf("Failed loading resource: fs://game/icon_right_bumper"), null);
});
