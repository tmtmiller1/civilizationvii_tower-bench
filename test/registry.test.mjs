import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";
import { registryInfo } from "../lib/engine-registry.mjs";
import { compareActive, overridden } from "../lib/registry.mjs";

const g = /** @type {any} */ (globalThis);
afterEach(() => { delete g.Controls; delete g.Modding; });

// A stand-in for the game's component-registry module: a Map of wrappers with a factory accessor.
function fakeRegistryModule() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tb-reg-")), "registry.mjs");
  fs.writeFileSync(file, `
    function BasePanel() {}
    function ModPanel() {}
    const w = (f, p) => Object.assign(() => null, { factory: () => f, overridePriority: p });
    export const ComponentRegistry = { componentFactories: new Map([["VictoriesScreen", w(ModPanel, 100)], ["Tooltip", w(BasePanel, 0)]]) };
  `);
  return pathToFileURL(file).href;
}

test("the registry view reads definitions, registrations and the mods this game applied", async () => {
  class PanelExample {}
  g.Controls = { getDefinitions: () => [
    { name: "panel-example", priority: 0, createInstance: PanelExample, styles: ["fs://game/base-standard/ui/x.css"] },
    { name: "panel-example-2", priority: 2, createInstance: class Replacement {}, styles: ["fs://game/my-mod/ui/y.css"] },
  ] };
  g.Modding = {
    getActiveMods: () => [1, 2],
    getModInfo: (h) => (h === 1 ? { id: "my-mod", name: "My Mod" } : { id: "base-standard", official: true }),
  };
  const info = await registryInfo({ registryModule: fakeRegistryModule() });
  assert.deepEqual(info.apis, { controls: true, componentRegistry: true, activeMods: true });
  assert.deepEqual(info.controls[1], { name: "panel-example-2", priority: 2, className: "Replacement", mods: ["my-mod"] });
  assert.deepEqual(info.components[0], { name: "VictoriesScreen", priority: 100, factory: "ModPanel" });
  const o = overridden(info);
  assert.deepEqual(o.components.map((c) => c.name), ["VictoriesScreen"]);
  assert.deepEqual(o.controls.map((c) => c.name), ["panel-example-2"]);
});

test("an API the game does not expose is reported as unavailable, not thrown", async () => {
  const info = await registryInfo({ registryModule: "file:///no/such/module.mjs" });
  assert.equal(info.apis.controls, false);
  assert.equal(info.apis.componentRegistry, false);
  assert.match(info.apis.componentRegistryError, /module|find|ERR/i);
  assert.equal(info.apis.activeMods, false);
  assert.equal(info.activeMods, null);
});

test("applied-now and next-launch mod sets are compared without official content", () => {
  const rows = [
    { id: "a", disabled: 0, path: "/u/Mods/a/a.modinfo" },
    { id: "b", disabled: 1, path: "/u/Mods/b/b.modinfo" },
    { id: "c", disabled: null, path: "/u/Mods/c/c.modinfo" },
    { id: "base-standard", disabled: 0, path: "/g/Base/modules/base-standard/x.modinfo" },
  ];
  const active = [{ id: "a", official: false }, { id: "b", official: false }, { id: "base-standard", official: true }];
  const r = compareActive(active, rows, (row) => row.path.startsWith("/g/"));
  assert.deepEqual(r.onlyNow, ["b"]);
  assert.deepEqual(r.onlyNext, ["c"]);
  assert.equal(r.notes.length, 2);
  assert.deepEqual(compareActive([{ id: "a", official: false }], rows.slice(0, 2), () => false).notes, []);
});
