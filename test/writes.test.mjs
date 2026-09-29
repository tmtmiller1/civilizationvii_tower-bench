import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Bench } from "../lib/bench.mjs";
import { toMarkdown } from "../lib/evidence.mjs";
import { hintsFor, snippetFor, validateRequest } from "../lib/writes.mjs";

test("requests are validated before anything reaches the game", () => {
  assert.equal(validateRequest({ op: "unit.place", args: { x: 1, y: 2, type: "UNIT_WARRIOR", owner: 0 } }), null);
  assert.match(validateRequest({ op: "unit.place", args: { x: 1, y: 2, type: "UNIT_WARRIOR" } }), /needs owner/);
  assert.match(validateRequest({ op: "unit.place", args: { x: 1.5, y: 2, type: "U", owner: 0 } }), /integers/);
  assert.match(validateRequest({ op: "town.place", args: { x: 1, y: 2, owner: "3" } }), /player id/);
  assert.match(validateRequest({ op: "nuke.drop", args: { x: 1, y: 2 } }), /unknown operation/);
  assert.equal(validateRequest({ op: "feature.set", args: { x: 1, y: 2, type: null } }), null);
});

test("snippets are the calls a mod would make, including clears", () => {
  assert.equal(
    snippetFor({ op: "unit.place", args: { x: 3, y: 4, type: "UNIT_SCOUT", owner: 2 } }),
    'Game.PlayerOperations.sendRequest(GameContext.localPlayerID, "CREATE_ELEMENT", { Kind: "UNIT", Type: "UNIT_SCOUT", Location: { x: 3, y: 4 }, Owner: 2 });',
  );
  assert.match(snippetFor({ op: "terrain.set", args: { x: 1, y: 1, type: "TERRAIN_COAST" } }), /startBlock\(\);\n.*setTerrain\(GameInfo\.Terrains\.lookup\("TERRAIN_COAST"\)\.\$index/);
  assert.match(snippetFor({ op: "feature.set", args: { x: 1, y: 1, type: null } }), /FeatureTypes\.NO_FEATURE/);
  assert.match(snippetFor({ op: "resource.set", args: { x: 1, y: 1, type: null } }), /NO_RESOURCE, \{ x: 1, y: 1 \}, 0\)/);
});

test("a town that did not land gets the silent-rejection note", () => {
  const hints = hintsFor({ op: "town.place", args: { x: 1, y: 1, owner: 0 } }, { verdict: "NO EFFECT" });
  assert.ok(hints.some((h) => /silently rejects some founding spots/.test(h)));
  assert.ok(hints.some((h) => /turn roll/.test(h)));
});

function tempBench() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-"));
  return new Bench({ evidence: dir, cdpPort: 1, install: null, logs: dir, modsDb: "", userMods: "" });
}

test("undo history comes from the evidence log: landed writes, newest first, minus landed undos", () => {
  const b = tempBench();
  const inv = (n) => ({ op: "feature.set", args: { x: n, y: 0, type: null } });
  const w1 = b.log({ kind: "write", request: { op: "feature.set", args: { x: 1, y: 0, type: "F" } }, result: { verdict: "LANDED", inverse: inv(1) } });
  b.log({ kind: "write", request: { op: "feature.set", args: { x: 2, y: 0, type: "F" } }, result: { verdict: "NO EFFECT", inverse: null } });
  const w3 = b.log({ kind: "write", request: { op: "feature.set", args: { x: 3, y: 0, type: "F" } }, result: { verdict: "LANDED", inverse: inv(3) } });
  assert.deepEqual(b.undoable().map((e) => e.id), [w1.id, w3.id]);

  b.log({ kind: "undo", undoOf: w3.id, request: inv(3), result: { verdict: "NO EFFECT" } });
  assert.equal(b.undoable().length, 2, "an undo that did not land leaves the write undoable");

  b.log({ kind: "undo", undoOf: w3.id, request: inv(3), result: { verdict: "LANDED" } });
  assert.deepEqual(b.undoable().map((e) => e.id), [w1.id]);
  assert.notEqual(w1.id, w3.id, "entries written in the same millisecond still have distinct ids");
});

test("writes stay disarmed until armed, and nothing is sent", async () => {
  const b = tempBench();
  await assert.rejects(b.write({ op: "feature.set", args: { x: 1, y: 1, type: null } }), /disarmed/);
});

test("evidence exports as Markdown bullets with timing and the plot delta", () => {
  const md = toMarkdown([{
    ts: "2026-09-26T19:00:00.000Z", kind: "write", version: "1.5.0", turn: 30,
    request: { op: "terrain.set", args: { x: 5, y: 6, type: "TERRAIN_COAST" } },
    result: { verdict: "LANDED", landedMs: 108, sent: true, returned: null, before: { terrain: "TERRAIN_FLAT", units: [] }, after: { terrain: "TERRAIN_COAST", units: [] } },
  }, { ts: "2026-09-26T19:00:01.000Z", kind: "eval", request: { code: "1" } }]);
  assert.equal(md.split("\n").length, 1, "only writes are exported");
  assert.match(md, /^- \*\*set terrain TERRAIN_COAST at \(5, 6\): LANDED in 108 ms\.\*\* terrain TERRAIN_FLAT -> TERRAIN_COAST\./);
  assert.match(md, /Evidence: watched 2026-09-26 on 1\.5\.0, turn 30, tower-bench\.$/);
});
