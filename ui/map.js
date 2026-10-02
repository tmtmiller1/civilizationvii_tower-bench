import { $, state, h, api, toast, messageOf, isOpen } from "./core.js";
import { refreshStatus, paintArm } from "./status.js";
import { map, drawMap, plotAt } from "./map-canvas.js";
import { loadMods } from "./mods.js";

const at = () => ({ x: Number($("x").value), y: Number($("y").value) });

async function inspect() {
  const { x, y } = at();
  state.sel = { x, y };
  drawMap();
  try {
    const p = await api(`/api/plot?x=${x}&y=${y}`);
    renderPlot(p);
  } catch (e) { toast(messageOf(e), true); }
}

function goTo(x, y) {
  $("x").value = x;
  $("y").value = y;
  inspect();
}

function renderPlot(p) {
  const box = $("plot");
  if (!p.valid) return box.replaceChildren(h("span", { class: "error" }, `(${p.x}, ${p.y}) is off the map`));
  const row = (k, v) => h("div", {}, h("span", {}, k), h("span", {}, v ?? "none"));
  const owner = p.owner >= 0 ? `player ${p.owner}` : "unowned";
  const city = p.city ? `${p.city.name ?? "settlement"} (player ${p.city.owner}, id ${p.city.id})` : null;
  const units = p.units.length ? p.units.map((u) => `${u.type} p${u.owner}#${u.id}`).join(", ") : null;
  box.replaceChildren(
    row("plot", `(${p.x}, ${p.y})`), row("terrain", p.terrain), row("feature", p.feature), row("resource", p.resource),
    row("biome", p.biome), row("owner", owner), row("city", city), row("units", units),
  );
}

$("inspect").addEventListener("click", inspect);
for (const id of ["x", "y"]) $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") inspect(); });
$("use-cursor").addEventListener("click", async () => {
  try {
    const c = await api("/api/cursor");
    if (!c) return toast("No plot under the cursor. Hover the map in game, then try again.", true);
    goTo(c.x, c.y);
  } catch (e) { toast(messageOf(e), true); }
});
$("use-selected").addEventListener("click", () => {
  const s = state.status?.snapshot?.selectedUnit;
  if (!s) return toast("No unit is selected in game.", true);
  goTo(s.x, s.y);
});

const typeOf = (id) => $(id).value.trim();

const WRITE_REQUESTS = {
  "unit.place": (loc) => ({ op: "unit.place", args: { ...loc, type: typeOf("unit-type"), owner: Number($("unit-owner").value) } }),
  "unit.remove": (loc) => ({ op: "unit.remove", args: loc }),
  "town.place": (loc) => ({ op: "town.place", args: { ...loc, owner: Number($("town-owner").value) } }),
  "town.remove": (loc) => ({ op: "town.remove", args: loc }),
  "terrain.set": (loc) => ({ op: "terrain.set", args: { ...loc, type: typeOf("terrain-type") } }),
  "feature.set": (loc) => ({ op: "feature.set", args: { ...loc, type: typeOf("feature-type") } }),
  "feature.clear": (loc) => ({ op: "feature.set", args: { ...loc, type: null } }),
  "resource.set": (loc) => ({
    op: "resource.set", args: { ...loc, type: typeOf("resource-type"), amount: Number($("resource-amount").value) || 1 },
  }),
  "resource.clear": (loc) => ({ op: "resource.set", args: { ...loc, type: null } }),
};

const requestFor = (kind) => WRITE_REQUESTS[kind]?.(at());

for (const b of document.querySelectorAll("[data-write]")) {
  const button = /** @type {HTMLButtonElement} */ (b);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const r = await api("/api/write", requestFor(button.dataset.write));
      renderResult(r);
      inspect();
      refreshStatus();
    } catch (e) { toast(messageOf(e), true); } finally { paintArm(); }
  });
}

// Undo refuses when the newest change has no inverse; the page asks before reverting the one before it.
async function undoRequest() {
  try {
    return await api("/api/undo", {});
  } catch (e) {
    const msg = messageOf(e);
    if (!/cannot be undone/.test(msg) || !confirm(`${msg}.\n\nRevert the one before it?`)) throw e;
    return api("/api/undo", { skip: true });
  }
}

$("undo").addEventListener("click", async () => {
  try {
    const r = await undoRequest();
    refreshStatus();
    // An undone mod switch changed the registry, not the map: there is no plot to re-read.
    if (r.changes) {
      toast(`Undone: ${r.undid} (${r.verdict}). Applies at the next launch.`, r.verdict !== "LANDED");
      if (isOpen("mods")) loadMods();
      return;
    }
    renderResult(r);
    inspect();
  } catch (e) { toast(messageOf(e), true); }
});

function timingText(r) {
  if (r.verdict === "LANDED") return `landed in ${r.landedMs} ms`;
  if (r.verdict === "NO EFFECT") return `nothing changed in ${r.waitedMs} ms`;
  return "";
}

function engineNote(r) {
  const canStart = r.canStart !== undefined ? `, canStart ${JSON.stringify(r.canStart)}` : "";
  return h("p", { class: "note" }, `Engine returned ${JSON.stringify(r.returned)}${canStart}. `
    + "Neither proves anything; the verdict comes from re-reading the plot.");
}

function snippetKids(snippet) {
  const onclick = () => navigator.clipboard.writeText(snippet).then(() => toast("Copied."), () => toast("Copy failed.", true));
  return [h("div", { class: "row", style: "margin-top:6px" }, h("button", { onclick }, "Copy as mod code")),
    h("pre", { class: "snippet" }, snippet)];
}

function renderResult(r) {
  const cls = `verdict v-${r.verdict.replace(/\s/g, "")}`;
  const kids = [
    h("div", { class: "row" }, h("span", { class: cls }, r.verdict),
      h("span", {}, r.undid ? `undo: ${r.undid}` : r.description ?? ""), h("span", { class: "muted" }, timingText(r))),
  ];
  if (r.reason) kids.push(h("p", { class: "note" }, r.reason));
  if (r.sent) kids.push(engineNote(r));
  for (const hint of r.hints ?? []) kids.push(h("p", { class: "note" }, hint));
  if (r.snippet) kids.push(...snippetKids(r.snippet));
  $("result").replaceChildren(...kids);
}

export async function loadMap() {
  try {
    map.snap = await api("/api/world");
    const a = $("map-overlay").value;
    map.diff = a ? (await api(`/api/diff?a=${encodeURIComponent(a)}&b=now`)).diff : null;
    drawMap();
  } catch (e) { toast(messageOf(e), true); }
}

function hoverText(p) {
  const snap = map.snap;
  const owner = snap.o[p.i] >= 0 ? `player ${snap.o[p.i]}` : "unowned";
  const terrain = String(snap.names.terrains[snap.t[p.i]] ?? "").replace("TERRAIN_", "");
  return `(${p.x}, ${p.y}) ${terrain} · ${owner}`;
}

$("map-load").addEventListener("click", loadMap);
$("map-overlay").addEventListener("change", loadMap);
$("map").addEventListener("click", (e) => {
  const p = plotAt(e);
  if (p) goTo(p.x, p.y);
});
$("map").addEventListener("mousemove", (e) => {
  if (map.hoverQueued) return;
  map.hoverQueued = true;
  requestAnimationFrame(() => {
    map.hoverQueued = false;
    const p = plotAt(e);
    $("map-hover").textContent = p ? hoverText(p) : "";
  });
});
window.addEventListener("resize", () => drawMap());
