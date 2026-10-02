import { $, h, api, toast, muted, headRow, messageOf } from "./core.js";

const table = (cols, rows) => h("table", {}, headRow(cols), h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c) => h("td", {}, c))))));

function activeBlock(a) {
  if (!a) return muted("This game version does not expose the active mod list.");
  return h("div", {},
    h("p", {}, `${a.now} mod(s) applied to this game; ${a.next} enabled for the next launch.`),
    a.onlyNow.length ? h("p", { class: "sev-warn" }, `Only in this game: ${a.onlyNow.join(", ")}`) : null,
    a.onlyNext.length ? h("p", { class: "sev-warn" }, `Only at the next launch: ${a.onlyNext.join(", ")}`) : null,
    a.notes.map((n) => h("p", { class: "note" }, n)));
}

function render(r) {
  const unavailable = Object.entries(r.apis).filter(([k, v]) => !k.endsWith("Error") && !v).map(([k]) => k);
  $("reg-meta").textContent = `${r.scope} page${unavailable.length ? `; unavailable here: ${unavailable.join(", ")}` : ""}`;
  $("registry").replaceChildren(
    h("h3", {}, "Mods"), activeBlock(r.active),
    h("h3", {}, `Legacy components replaced or styled by a mod (${r.controls.length} of ${r.totals.controls ?? "?"})`),
    r.controls.length ? table(["Tag", "Priority", "Class", "Mod files"], r.controls.map((c) => [c.name, c.priority, c.className ?? "", c.mods.join(", ")]))
      : muted("None."),
    h("h3", {}, `ui-next components above base priority (${r.components.length} of ${r.totals.components ?? "?"})`),
    r.components.length ? table(["Name", "Priority", "Winning factory"], r.components.map((c) => [c.name, c.priority, c.factory ?? "?"]))
      : muted(r.apis.componentRegistry ? "None." : `Unavailable: ${r.apis.componentRegistryError ?? "not exposed"}`));
}

export async function loadRegistry() {
  try { render(await api("/api/registry")); } catch (e) { toast(messageOf(e), true); }
}

$("reg-load").addEventListener("click", loadRegistry);
