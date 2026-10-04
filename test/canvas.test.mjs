import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { flattenMetrics, judgeCandidates, readCrashEvidence, readMetrics } from "../lib/canvas.mjs";
import { CdpSession, TruncatedReplyError } from "../lib/cdp.mjs";
import { agentScript, agentStatus, writeAgent } from "../lib/events.mjs";
import { canvasCandidates, canvasCounter, canvasPaint } from "../lib/engine-canvas.mjs";

const g = /** @type {any} */ (globalThis);
const saved = {};
for (const k of ["UI", "CanvasRenderingContext2D", "document", "requestAnimationFrame", "__tbCanvas"]) saved[k] = g[k];
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; } });

test("a candidate that moves with paint calls and not without them is a counter", () => {
  const before = { "UI.getStats().staticResources": 100, "UI.frameCount": 10, "perf.heap": 5000 };
  const control = { "UI.getStats().staticResources": 100, "UI.frameCount": 70, "perf.heap": 5100 };
  const after = { "UI.getStats().staticResources": 330, "UI.frameCount": 130, "perf.heap": 5300 };
  const r = judgeCandidates(before, control, after, 1000);
  assert.equal(r.verdict, "COUNTER FOUND");
  assert.equal(r.rows[0].key, "UI.getStats().staticResources");
  assert.equal(r.rows[0].perCall, 0.23);
  assert.equal(r.rows.find((x) => x.key === "UI.frameCount").tracks, false, "steady drift is not a counter");
});

test("nothing in range means no counter", () => {
  const r = judgeCandidates({ a: 1 }, { a: 1 }, { a: 2 }, 1000);
  assert.equal(r.verdict, "NO COUNTER");
});

test("CDP metric answers flatten to one map", () => {
  assert.deepEqual(flattenMetrics("Performance.getMetrics", { metrics: [{ name: "Nodes", value: 9 }] }), { "Performance.getMetrics.Nodes": 9 });
  assert.deepEqual(flattenMetrics("Memory.getDOMCounters", { documents: 1, nodes: 40, jsEventListeners: 3 }),
    { "Memory.getDOMCounters.documents": 1, "Memory.getDOMCounters.nodes": 40, "Memory.getDOMCounters.jsEventListeners": 3 });
});

// The reply the game sends on 1.5.0 when no layout ran just before the call.
const CUT = '{"id":3,"result":{"metrics":[{"name":"Nodes","value":3991.0},{"name":"JSEventListeners","value":3619.0},'
  + '{"name":"LayoutCount","value":2.0},{"name":"RecalcStyleCount","value":198.0},{"name":"LayoutDuration","value":';

test("a metrics reply the game cut short keeps its complete pairs and says it was cut", async () => {
  const cdp = { send: async () => { throw new TruncatedReplyError("Performance.getMetrics", CUT); } };
  assert.deepEqual(await readMetrics(cdp, "Performance.getMetrics", 100), {
    values: { "Performance.getMetrics.Nodes": 3991, "Performance.getMetrics.JSEventListeners": 3619,
      "Performance.getMetrics.LayoutCount": 2, "Performance.getMetrics.RecalcStyleCount": 198 },
    truncated: true,
  });
  const whole = { send: async () => ({ metrics: [{ name: "Nodes", value: 1 }] }) };
  assert.deepEqual(await readMetrics(whole, "Performance.getMetrics", 100), { values: { "Performance.getMetrics.Nodes": 1 }, truncated: false });
  const other = { send: async () => { throw new Error("Memory.getDOMCounters wasn't found"); } };
  await assert.rejects(readMetrics(other, "Memory.getDOMCounters", 100), /wasn't found/);
});

test("a frame that is not JSON fails only the call it answers", async () => {
  const s = new CdpSession(0);
  s.ws = /** @type {any} */ ({ send: () => {} });
  const cut = s.send("Performance.getMetrics", {}, 1000);
  const other = s.send("Runtime.getHeapUsage", {}, 1000);
  s.onFrame(CUT.replace('"id":3', '"id":1'));
  s.onFrame('{"id":2,"result":{"usedSize":5}}');
  await assert.rejects(cut, (e) => e instanceof TruncatedReplyError && e.partial.startsWith('{"id":1,'));
  assert.deepEqual(await other, { usedSize: 5 });
});

test("crash evidence reads the renderer's limit and the last breadcrumb", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-canvas-"));
  fs.writeFileSync(path.join(dir, "Renderer.log"), "[t]\tok\n[t]\tPartitionedResourceList.AddStaticResource(), attempting to add more than 49152 items\n");
  fs.writeFileSync(path.join(dir, "UI.log"), "[t]\t[TB-CANVAS-STRESS] page=ab12 painted=48000\n[t]\t[TB-CANVAS-STRESS] page=ab12 painted=49000\n");
  const r = readCrashEvidence(dir);
  assert.equal(r.limit, 49152);
  assert.equal(r.painted, 49000);
  assert.deepEqual(r.pages, ["ab12"]);
  assert.equal(readCrashEvidence(path.join(dir, "none")).rendererLine, null);
});

test("candidate search reads resource-like numbers and zero-argument getters, and nothing else", () => {
  let calls = 0;
  g.UI = { cacheSize: 12, name: "x", getResourceStats: () => { calls++; return { staticResources: 7, label: "s" }; },
    getStatFor: (id) => id, setCount: () => { throw new Error("must not be called"); } };
  const r = canvasCandidates();
  assert.equal(r.candidates["UI.cacheSize"], 12);
  assert.equal(r.candidates["UI.getResourceStats().staticResources"], 7);
  assert.equal(calls, 1);
  assert.ok(!("UI.getStatFor()" in r.candidates), "a getter that takes arguments is not called");
});

test("the paint counter wraps the 2D context once and counts per method", () => {
  class Ctx { fill() { return "f"; } stroke() { return "s"; } }
  g.CanvasRenderingContext2D = Ctx;
  assert.equal(canvasCounter({ op: "read" }).installed, false);
  canvasCounter({ op: "install" });
  canvasCounter({ op: "install" });
  const c = new Ctx();
  assert.equal(c.fill(), "f");
  c.fill(); c.stroke();
  const r = canvasCounter({ op: "read" });
  assert.equal(r.calls, 3);
  assert.deepEqual(r.byMethod, { fill: 2, stroke: 1 });
});

test("painting draws k calls across frames and removes its canvas", async () => {
  let fills = 0;
  let removed = false;
  const ctx = { beginPath() {}, rect() {}, fill() { fills++; }, stroke() {}, fillRect() {} };
  const canvas = { style: {}, getContext: () => ctx, remove: () => { removed = true; } };
  g.document = { createElement: () => canvas, body: { appendChild() {} } };
  g.requestAnimationFrame = (f) => setTimeout(f, 0);
  assert.deepEqual(await canvasPaint({ k: 600, perFrame: 250 }), { painted: 600 });
  assert.equal(fills, 600);
  assert.ok(removed);
  assert.deepEqual(await canvasPaint({ k: 0 }), { painted: 0 });
});

test("the agent counts canvas paint calls from page load only when asked, and keeps the setting", () => {
  class Ctx { fill() {} }
  g.CanvasRenderingContext2D = Ctx;
  new Function(agentScript([], false))();
  assert.equal(g.__tbCanvas, undefined);
  new Function(agentScript([], true))();
  new Ctx().fill();
  assert.equal(g.__tbCanvas.calls, 1);
  const user = fs.mkdtempSync(path.join(os.tmpdir(), "tb-agent-"));
  const paths = { userMods: path.join(user, "Mods") };
  writeAgent(paths, ["UnitMoved"], true);
  assert.equal(agentStatus(paths).canvas, true);
  writeAgent(paths, []);
  assert.equal(agentStatus(paths).canvas, true, "changing the event list keeps counting on");
  writeAgent(paths, [], false);
  assert.equal(agentStatus(paths).canvas, false);
});
