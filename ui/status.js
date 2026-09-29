import { $, state, h, api, messageOf, registryLocked } from "./core.js";

const CATALOG_LISTS = [["units", "dl-units"], ["terrains", "dl-terrains"], ["features", "dl-features"],
  ["resources", "dl-resources"]];

function factsText(s) {
  const g = s.snapshot;
  if (!g) return s.connected ? (s.version ?? "") : "start the game with the UI debugger on";
  const age = String(g.age ?? "").replace("AGE_", "").toLowerCase();
  return `turn ${g.turn} · ${age} · ${g.map.width}x${g.map.height} · player ${g.localPlayer} · ${s.version ?? ""}`;
}

function paintScope(s) {
  const pill = $("scope");
  pill.className = `pill ${s.connected ? s.scope : "offline"}`;
  pill.textContent = s.connected ? `${s.scope} scope` : "offline";
  pill.title = s.reason ?? s.url ?? "";
}

export async function refreshStatus() {
  let s;
  try { s = await api("/api/status"); } catch (e) { s = { connected: false, scope: "offline", reason: messageOf(e) }; }
  state.status = s;
  paintScope(s);
  $("facts").textContent = factsText(s);
  state.armed = !!s.armed;
  paintArm();
  $("undo").textContent = s.undo ? `Undo (${s.undo})` : "Undo";
  $("undo").disabled = !s.undo || !state.armed;
  if (s.snapshot) fillOwners(s.snapshot);
  if (s.scope === "game" && !state.catalogs) loadCatalogs();
  if (s.scope !== "game") state.catalogs = null;
}

export function paintArm() {
  const b = $("arm");
  b.classList.toggle("armed", state.armed);
  b.setAttribute("aria-pressed", String(state.armed));
  b.textContent = state.armed ? "Writes ARMED" : "Writes disarmed";
  const inGame = state.status?.scope === "game";
  for (const w of document.querySelectorAll("[data-write]")) {
    /** @type {HTMLButtonElement} */ (w).disabled = !state.armed || !inGame;
  }
  for (const w of document.querySelectorAll("[data-registry]")) {
    /** @type {HTMLButtonElement} */ (w).disabled = registryLocked();
  }
}

$("arm").addEventListener("click", async () => {
  const r = await api("/api/arm", { armed: !state.armed });
  state.armed = r.armed;
  paintArm();
  refreshStatus();
});

function ownerLabel(p, g) {
  const you = p.id === g.localPlayer ? " (you)" : "";
  const kind = p.major ? "" : p.independent ? " [independent]" : " [minor]";
  return `${p.id} ${p.name}${you}${kind}`;
}

function fillOwners(g) {
  for (const id of ["unit-owner", "town-owner"]) {
    const sel = $(id);
    const keep = sel.value;
    const sig = g.players.map((p) => p.id).join(",");
    if (sel.dataset.sig === sig) continue;
    sel.dataset.sig = sig;
    sel.replaceChildren(...g.players.map((p) => h("option", { value: p.id }, ownerLabel(p, g))));
    sel.value = keep || String(g.localPlayer);
  }
}

async function loadCatalogs() {
  try {
    state.catalogs = await api("/api/catalogs");
    for (const [key, dl] of CATALOG_LISTS) {
      $(dl).replaceChildren(...state.catalogs[key].map((r) => h("option", { value: r.type }, r.name)));
    }
  } catch { state.catalogs = null; }
}
