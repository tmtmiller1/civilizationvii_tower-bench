import assert from "node:assert/strict";
import { test } from "node:test";
import { modHealth, planModChange, sourceOf } from "../lib/mods.mjs";

const paths = { userMods: "/U/Library/Application Support/Civilization VII/Mods" };
const WS = "/U/Library/Application Support/Steam/steamapps/workshop/content/1295660";

const row = (id, path, disabled, extra = {}) =>
  ({ row: 1, id, version: 1, disabled, path, lastWrite: 0, name: id, ...extra });

test("sources are classified from the scanned path", () => {
  assert.deepEqual(sourceOf(`${WS}/1234567890/demographics/demographics.modinfo`, paths), { kind: "workshop", label: "Workshop 1234567890" });
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
    row("demographics", `${WS}/1234567890/demographics/demographics.modinfo`, 0),
    row("demographics", `${paths.userMods}/demographics/demographics.modinfo`, 1),
  ], paths);
  assert.equal(m.issues[0].severity, "warn");
  assert.match(m.issues[0].text, /Live: Workshop 1234567890/);
});

test("a local copy live over a disabled Workshop copy is informational", () => {
  const [m] = modHealth([
    row("demographics", `${WS}/1234567890/demographics/demographics.modinfo`, 1),
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

// Watch run 2, block 1: the keeper had a copy nested in its own folder, in Mods/ and in the Workshop item, and
// `mods live tower-settings-keeper Mods/tower-settings-keeper` was refused because two copies shared each label.
const keeper = () => modHealth([
  row("keeper", `${WS}/3815023570/keeper.modinfo`, 1),
  row("keeper", `${WS}/3815023570/3815023570/keeper.modinfo`, 1),
  row("keeper", `${paths.userMods}/tower-settings-keeper/keeper.modinfo`, 0),
  row("keeper", `${paths.userMods}/tower-settings-keeper/3815023570/keeper.modinfo`, 0),
], paths)[0];

test("copies that would share a label are named down to the folder holding the modinfo", () => {
  assert.deepEqual(keeper().copies.map((c) => c.source.label), [
    "Workshop 3815023570", "Workshop 3815023570/3815023570",
    "Mods/tower-settings-keeper", "Mods/tower-settings-keeper/3815023570",
  ]);
});

test("each longer label picks exactly one copy", () => {
  const m = keeper();
  for (const c of m.copies) {
    const plan = planModChange([m], { op: "live", id: "keeper", copy: c.source.label });
    assert.equal(plan.refuse, undefined, c.source.label);
    const live = m.copies.filter((o) => (plan.changes.find((ch) => ch.path === o.path)?.to ?? o.disabled) === 0);
    assert.deepEqual(live.map((o) => o.path), [c.path]);
  }
});

test("two modinfos in one folder are told apart by file name", () => {
  const [m] = modHealth([
    row("x", `${paths.userMods}/x/a.modinfo`, 0),
    row("x", `${paths.userMods}/x/b.modinfo`, 1),
  ], paths);
  assert.deepEqual(m.copies.map((c) => c.source.label), ["Mods/x/a.modinfo", "Mods/x/b.modinfo"]);
});

test("a label that is already unique stays short", () => {
  const [m] = modHealth([
    row("demographics", `${WS}/1234567890/demographics/demographics.modinfo`, 1),
    row("demographics", `${paths.userMods}/demographics/demographics.modinfo`, 0),
  ], paths);
  assert.deepEqual(m.copies.map((c) => c.source.label), ["Workshop 1234567890", "Mods/demographics"]);
});

test("a copy that isn't there is refused with every copy's label, quoted to paste back", () => {
  const plan = planModChange([keeper()], { op: "live", id: "keeper", copy: "Mods/keeper" });
  assert.equal(plan.refuse, 'keeper has no copy "Mods/keeper"; its copies: "Workshop 3815023570", '
    + '"Workshop 3815023570/3815023570", "Mods/tower-settings-keeper", "Mods/tower-settings-keeper/3815023570"');
});
