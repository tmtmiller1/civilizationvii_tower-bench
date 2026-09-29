import { $, h, api, toast, muted, errorSpan, headRow, messageOf } from "./core.js";

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function outcome(result) {
  return result?.verdict ?? result?.error ?? (result?.total != null ? `${result.total} rows` : "ok");
}

const evidenceRow = (e) => h("tr", {},
  h("td", {}, e.ts.slice(11, 19)), h("td", {}, e.kind), h("td", {}, e.turn ?? ""),
  h("td", {}, JSON.stringify(e.request).slice(0, 90)), h("td", {}, outcome(e.result)));

$("ev-date").value = today();

export async function loadEvidence() {
  try {
    const entries = await api(`/api/evidence?date=${$("ev-date").value || today()}`);
    if (!entries.length) return $("evidence").replaceChildren(muted("Nothing recorded that day."));
    $("evidence").replaceChildren(h("table", {}, headRow(["time", "kind", "turn", "request", "outcome"]),
      h("tbody", {}, entries.slice().reverse().map(evidenceRow))));
  } catch (e) { $("evidence").replaceChildren(errorSpan(messageOf(e))); }
}

$("ev-load").addEventListener("click", loadEvidence);
$("ev-md").addEventListener("click", async () => {
  try {
    const { markdown } = await api(`/api/evidence?date=${$("ev-date").value || today()}&format=md`);
    if (!markdown) return toast("No writes recorded that day.", true);
    await navigator.clipboard.writeText(markdown);
    toast("Copied as Markdown bullets.");
  } catch (e) { toast(messageOf(e), true); }
});
