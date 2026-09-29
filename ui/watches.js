import { $, h, api, toast, muted, errorSpan, headRow, messageOf } from "./core.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function setAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function sparkline(points) {
  const vals = points.map((p) => p.value).filter((v) => typeof v === "number");
  if (vals.length < 2) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * 118 + 1},${22 - ((v - min) / span) * 20}`).join(" ");
  const svg = setAttrs(document.createElementNS(SVG_NS, "svg"), { width: "120", height: "24", class: "spark" });
  svg.append(setAttrs(document.createElementNS(SVG_NS, "polyline"),
    { points: pts, fill: "none", stroke: "#6fa8dc", "stroke-width": "1.5" }));
  return svg;
}

function watchLatest(last) {
  if (!last) return muted("not sampled");
  return last.error ? errorSpan(last.error) : JSON.stringify(last.value);
}

function invariantLatest(r) {
  if (!r) return muted("not sampled");
  return r.ok ? h("span", { class: "ok" }, "holds") : errorSpan(`VIOLATED ${r.detail ?? ""}`);
}

const removeButton = (name) => h("td", {}, h("button", { onclick: () => removeWatch(name) }, "Remove"));

function watchRow(w, series) {
  return h("tr", {}, h("td", {}, "watch"), h("td", {}, w.name), h("td", { class: "mono" }, w.expr),
    h("td", {}, watchLatest(series.at(-1))), h("td", {}, sparkline(series)), removeButton(w.name));
}

function invariantRow(v, r) {
  return h("tr", {}, h("td", {}, "invariant"), h("td", {}, v.name), h("td", { class: "mono" }, v.expr),
    h("td", {}, invariantLatest(r)), h("td", {}), removeButton(v.name));
}

export async function loadWatches(lastSample) {
  try {
    const d = await api("/api/watches");
    const rows = [
      ...d.watches.map((w) => watchRow(w, d.series[w.name] ?? [])),
      ...d.invariants.map((v) => invariantRow(v, lastSample?.invariants?.[v.name])),
    ];
    $("watches").replaceChildren(rows.length ? h("table", {},
      headRow(["kind", "name", "expression", "latest", "series", ""]),
      h("tbody", {}, rows)) : muted("Nothing watched yet."));
  } catch (e) { $("watches").replaceChildren(errorSpan(messageOf(e))); }
}

async function removeWatch(name) {
  try { await api("/api/watches/remove", { name }); loadWatches(); } catch (e) { toast(messageOf(e), true); }
}

$("w-add").addEventListener("click", async () => {
  try {
    await api("/api/watches", { kind: $("w-kind").value, name: $("w-name").value.trim(), expr: $("w-expr").value.trim() });
    $("w-name").value = "";
    $("w-expr").value = "";
    loadWatches();
  } catch (e) { toast(messageOf(e), true); }
});
$("w-sample").addEventListener("click", async () => {
  try { loadWatches(await api("/api/watches/sample", {})); } catch (e) { toast(messageOf(e), true); }
});
