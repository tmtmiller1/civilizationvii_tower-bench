import assert from "node:assert/strict";
import { test } from "node:test";
import { modHealth, sourceOf } from "../lib/mods.mjs";

const paths = { userMods: "/U/Library/Application Support/Civilization VII/Mods" };
const WS = "/U/Library/Application Support/Steam/steamapps/workshop/content/1295660";

const row = (id, path, disabled, extra = {}) => ({ row: 1, id, version: 1, disabled, path, lastWrite: 0, name: id, ...extra });

test("sources are classified from the scanned path", () => {
  assert.deepEqual(sourceOf(`${WS}/3737200066/demographics/demographics.modinfo`, paths), { kind: "workshop", label: "Workshop 3737200066" });
  assert.equal(sourceOf(`${paths.userMods}/demographics/demographics.modinfo`, paths).kind, "local");
  assert.equal(sourceOf(`${paths.userMods}/demographics/dist/demographics/demographics.modinfo`, paths).kind, "nested");
  assert.equal(sourceOf("/X/CivilizationVII.app/Contents/Resources/DLC/napoleon/napoleon.modinfo", paths).kind, "official");
  assert.equal(sourceOf("/X/CivilizationVII.app/Contents/Resources/Base/modules/core/core.modinfo", paths).kind, "official");
});

test("two enabled copies of one id is an error", () => {
  const [m] = modHealth([
    row("emigration", `${WS}/1/emigration/emigration.modinfo`, 0),
    row("emigration", `${paths.userMods}/emigration/emigration.modinfo`, 0),
  ], paths);
  assert.equal(m.issues[0].severity, "error");
});

test("a Workshop copy live over a local copy is a warning that names the live copy", () => {
  const [m] = modHealth([
    row("demographics", `${WS}/3737200066/demographics/demographics.modinfo`, 0),
    row("demographics", `${paths.userMods}/demographics/demographics.modinfo`, 1),
  ], paths);
  assert.equal(m.issues[0].severity, "warn");
  assert.match(m.issues[0].text, /Live: Workshop 3737200066/);
});

test("a local copy live over a disabled Workshop copy is informational", () => {
  const [m] = modHealth([
    row("demographics", `${WS}/3737200066/demographics/demographics.modinfo`, 1),
    row("demographics", `${paths.userMods}/demographics/demographics.modinfo`, 0),
  ], paths);
  assert.equal(m.issues[0].severity, "info");
});

test("a nested build copy is flagged and problems sort before clean mods", () => {
  const mods = modHealth([
    row("aaa-clean", `${paths.userMods}/aaa/aaa.modinfo`, 0),
    row("zzz", `${paths.userMods}/zzz/dist/zzz/zzz.modinfo`, 0),
  ], paths);
  assert.equal(mods[0].id, "zzz");
  assert.match(mods[0].issues[0].text, /build output/);
  assert.equal(mods[1].issues.length, 0);
});

test("an enabled test probe is flagged; a disabled one is not", () => {
  const mods = modHealth([
    row("canal-grant-probe", `${paths.userMods}/canal-grant-probe/canal-grant-probe.modinfo`, null),
    row("old-repro", `${paths.userMods}/old-repro/old-repro.modinfo`, 1),
  ], paths);
  assert.match(mods.find((m) => m.id === "canal-grant-probe").issues[0].text, /loads into every game you start/);
  assert.equal(mods.find((m) => m.id === "old-repro").issues.length, 0);
});

test("a LOC tag name falls back to a readable name from another copy", () => {
  const [m] = modHealth([
    row("x", `${WS}/1/x/x.modinfo`, 0, { name: "LOC_MOD_X_NAME" }),
    row("x", `${paths.userMods}/x/x.modinfo`, 1, { name: "Readable X" }),
  ], paths);
  assert.equal(m.name, "Readable X");
});
