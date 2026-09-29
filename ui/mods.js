import { $, h, api, muted, errorSpan, messageOf, registryLocked, toast } from "./core.js";
import { refreshStatus } from "./status.js";

const flagLabel = (c) => (c.disabled === null || c.disabled === undefined ? "default" : c.enabled ? "on" : "off");

async function change(request) {
  try {
    const r = await api("/api/mods/set", request);
    const moved = r.changes.map((c) => `${c.label} ${Number(c.to) ? "off" : "on"}`).join(", ");
    toast(r.verdict === "ALREADY" ? "Already that way." : `${r.verdict}: ${moved}. Applies at the next launch.`,
      r.verdict === "NO EFFECT");
    await refreshStatus();
    await loadMods();
  } catch (e) { toast(messageOf(e), true); }
}

function copyActions(m, c) {
  const lock = registryLocked();
  const button = (label, request, title) => h("button", { class: "small", "data-registry": "", disabled: lock, title,
    onclick: () => change({ id: m.id, copy: c.source.label, ...request }) }, label);
  if (m.official) return null;
  const duplicate = c.enabled && m.copies.filter((x) => x.enabled).length > 1;
  if (duplicate) {
    return [button("Load only this copy", { op: "live" }, "Keep this copy on and switch the others off"), " ",
      button("Off", { op: "off" }, "Switch this copy off at the next launch")];
  }
  if (c.enabled) return button("Off", { op: "off" }, "Switch this copy off at the next launch");
  if (m.copies.length > 1) return button("Load this copy", { op: "live" }, "Switch this copy on and the others off");
  return button("On", { op: "on" }, "Switch on at the next launch");
}

function copyRow(m, c) {
  return h("div", { class: `copy${c.enabled ? " live" : ""}` },
    h("span", {}, `${c.enabled ? "live " : "     "} ${c.source.label}  v${c.version}  `), muted(flagLabel(c)), " ",
    copyActions(m, c));
}

function modRow(m) {
  return h("div", { class: "mod" },
    h("div", {}, h("strong", {}, m.id), m.name !== m.id ? muted(`  ${m.name}`) : null,
      m.authors ? muted(`  by ${m.authors}`) : null, m.enabled ? null : muted("  (off)")),
    m.copies.map((c) => copyRow(m, c)),
    m.issues.map((i) => h("div", { class: `issue sev-${i.severity}` }, i.text)));
}

export async function loadMods() {
  try {
    const q = $("mods-filter").value.trim();
    const mods = await api(`/api/mods${q ? `?q=${encodeURIComponent(q)}` : ""}`);
    const noted = mods.filter((m) => m.issues.length);
    const shown = $("mods-all").checked || q ? mods : noted;
    const enabled = mods.filter((m) => m.enabled).length;
    $("mods-summary").textContent = `${mods.length} ${q ? "matching " : ""}ids, ${enabled} enabled, ${noted.length} with notes`;
    const empty = q ? "No mod matches that id, name or author." : "No duplicate ids or other notes.";
    $("mods").replaceChildren(...(shown.length ? shown.map(modRow) : [muted(empty)]));
  } catch (e) { $("mods").replaceChildren(errorSpan(messageOf(e))); }
}

let filterTimer;
$("mods-filter").addEventListener("input", () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(loadMods, 200);
});
$("mods-refresh").addEventListener("click", loadMods);
$("mods-all").addEventListener("change", loadMods);
