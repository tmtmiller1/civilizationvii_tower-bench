import { $, h, api, muted, errorSpan, messageOf } from "./core.js";

function modRow(m) {
  return h("div", { class: "mod" },
    h("div", {}, h("strong", {}, m.id), m.name !== m.id ? muted(`  ${m.name}`) : null, m.enabled ? null : muted("  (off)")),
    m.copies.map((c) => h("div", { class: `copy${c.enabled ? " live" : ""}` },
      `${c.enabled ? "live " : "     "} ${c.source.label}  v${c.version}`)),
    m.issues.map((i) => h("div", { class: `issue sev-${i.severity}` }, i.text)));
}

export async function loadMods() {
  try {
    const mods = await api("/api/mods");
    const noted = mods.filter((m) => m.issues.length);
    const shown = $("mods-all").checked ? mods : noted;
    const enabled = mods.filter((m) => m.enabled).length;
    $("mods-summary").textContent = `${mods.length} ids, ${enabled} enabled, ${noted.length} with notes`;
    $("mods").replaceChildren(...(shown.length ? shown.map(modRow) : [muted("No duplicate ids or other notes.")]));
  } catch (e) { $("mods").replaceChildren(errorSpan(messageOf(e))); }
}

$("mods-refresh").addEventListener("click", loadMods);
$("mods-all").addEventListener("change", loadMods);
