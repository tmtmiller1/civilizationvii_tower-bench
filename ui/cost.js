// Cost tab: past "cost" runs, the per-turn cost of a mod measured off against on in seeded test games.
import { h, api, muted, headRow, messageOf, registerTab } from "./core.js";

const els = {
  cost: h("div", {}, muted("Loading...")),
};

const when = (iso) => (iso ? new Date(iso).toLocaleString("sv-SE").slice(0, 16) : "?");
const table = (cols, rows) => h("table", {}, headRow(cols), h("tbody", {}, rows));

async function loadCost() {
  try {
    const reports = await api("/api/cost");
    els.cost.replaceChildren(reports.length ? table(["When", "Mod", "Verdict", "Detail", "Turns x reps"], reports.map((r) =>
      h("tr", {}, h("td", {}, when(r.at)), h("td", {}, r.mod), h("td", {}, r.verdict), h("td", {}, r.detail),
        h("td", {}, `${r.turns} x ${r.replicates}`))))
      : muted("No cost runs yet. Run \"tower-bench cost <mod-id> --yes\" with the game closed."));
  } catch (e) { els.cost.replaceChildren(muted(messageOf(e))); }
}

registerTab({
  id: "cost",
  label: "Cost",
  build: () => h("div", { class: "stack" }, h("div", { class: "card" }, h("h3", {}, "Mod cost runs"), els.cost)),
  load: () => { loadCost(); },
});
