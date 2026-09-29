import { $, h, api, toast, muted, headRow, messageOf } from "./core.js";
import { loadMap } from "./map.js";

function snapTable(newest) {
  if (!newest.length) return muted("No snapshots yet.");
  return h("table", {}, headRow(["name", "turn", "size", "taken"]),
    h("tbody", {}, newest.map((s) => h("tr", {}, h("td", {}, s.label), h("td", {}, s.turn), h("td", {}, s.size),
      h("td", {}, s.takenAt.slice(0, 19).replace("T", " "))))));
}

function fillSnapSelects(newest) {
  const opts = (extra) => [...extra, ...newest.map((s) => h("option", { value: s.label }, `${s.label} (turn ${s.turn})`))];
  const keep = { a: $("diff-a").value, b: $("diff-b").value, o: $("map-overlay").value };
  $("diff-a").replaceChildren(...opts([]));
  $("diff-b").replaceChildren(...opts([h("option", { value: "now" }, "now (live game)")]));
  $("map-overlay").replaceChildren(...opts([h("option", { value: "" }, "(no overlay)")]));
  if (keep.a) $("diff-a").value = keep.a;
  $("diff-b").value = keep.b || "now";
  $("map-overlay").value = keep.o;
}

export async function loadSnaps() {
  try {
    const newest = (await api("/api/snapshots")).slice().reverse();
    fillSnapSelects(newest);
    $("snap-list").replaceChildren(snapTable(newest));
  } catch (e) { toast(messageOf(e), true); }
}

$("snap-take").addEventListener("click", async () => {
  try {
    const r = await api("/api/snapshot", { label: $("snap-label").value.trim() });
    toast(`Saved ${r.label}: turn ${r.turn}, ${r.units} units, ${r.settlements} settlements.`);
    $("snap-label").value = "";
    loadSnaps();
  } catch (e) { toast(messageOf(e), true); }
});

$("diff-run").addEventListener("click", async () => {
  const a = $("diff-a").value;
  if (!a) return toast("Take a snapshot first.", true);
  $("diff-out").textContent = "diffing...";
  try {
    const r = await api(`/api/diff?a=${encodeURIComponent(a)}&b=${encodeURIComponent($("diff-b").value)}`);
    $("diff-out").textContent = r.text;
    $("diff-out").classList.remove("muted");
  } catch (e) { $("diff-out").textContent = messageOf(e); }
});

$("diff-map").addEventListener("click", () => {
  const a = $("diff-a").value;
  if (!a) return toast("Take a snapshot first.", true);
  $("map-overlay").value = a;
  /** @type {HTMLElement | null} */ (document.querySelector('nav button[data-tab="map"]'))?.click();
  loadMap();
});
