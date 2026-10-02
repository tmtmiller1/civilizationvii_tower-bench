import { h, api, toast, muted, headRow, messageOf, registerTab, state } from "./core.js";

/** @type {Record<string, HTMLInputElement | HTMLSelectElement>} */
const el = {};
/** @type {HTMLElement} */
let result;
/** @type {HTMLElement} */
let reports;

const input = (id, attrs) => {
  el[id] = /** @type {HTMLInputElement} */ (h("input", { id: `dbd-${id}`, ...attrs }));
  return el[id];
};

const fmt = (v) => (v === null ? "NULL" : typeof v === "string" ? JSON.stringify(v) : String(v));
const rowText = (r) => Object.entries(r).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${fmt(v)}`).join(" ");

function samples(t) {
  const lines = [
    ...t.samples.added.map((r) => h("div", { class: "mono ok" }, `+ ${rowText(r)}`)),
    ...t.samples.removed.map((r) => h("div", { class: "mono sev-error" }, `- ${rowText(r)}`)),
    ...t.samples.changed.map((r) => h("div", { class: "mono sev-warn" }, `~ ${rowText(r.key)}: `
      + Object.entries(r.changes).map(([c, v]) => `${c}: ${fmt(v.from)} -> ${fmt(v.to)}`).join("; "))),
  ];
  const cols = Object.entries(t.columnChanges).map(([c, n]) => `${c} (${n})`);
  return h("details", {}, h("summary", {}, "sample rows"),
    cols.length ? h("p", { class: "note" }, `Columns changed: ${cols.join(", ")}`) : null,
    t.columnsOnlyInA.length ? h("p", { class: "note" }, `Columns only before: ${t.columnsOnlyInA.join(", ")}`) : null,
    t.columnsOnlyInB.length ? h("p", { class: "note" }, `Columns only after: ${t.columnsOnlyInB.join(", ")}`) : null,
    lines.length ? lines : muted("No sample rows."));
}

function diffBlock(d, label) {
  const head = `${label ? `${label}: ` : ""}${d.tables.length} of ${d.compared} shared tables differ; `
    + `${d.totals.added} added, ${d.totals.removed} removed, ${d.totals.changed} changed (${d.ms} ms)`;
  const onlyRows = [
    ...d.tablesOnlyInB.map((t) => h("div", {}, `New table ${t.table} (${t.rows} rows)`)),
    ...d.tablesOnlyInA.map((t) => h("div", {}, `Table gone: ${t.table} (had ${t.rows} rows)`)),
  ];
  const rows = d.tables.map((t) => h("tr", {},
    h("td", {}, t.table, samples(t)), h("td", { class: "num" }, `${t.rowsA} -> ${t.rowsB}`),
    h("td", { class: "num" }, t.added), h("td", { class: "num" }, t.removed), h("td", { class: "num" }, t.changed),
    h("td", {}, t.key ? t.key.join(", ") : muted("whole rows"))));
  return h("div", { class: "card" }, h("h3", {}, head), onlyRows,
    rows.length ? h("table", {}, headRow(["Table", "Rows", "Added", "Removed", "Changed", "Key"]), h("tbody", {}, rows))
      : muted("No differences."));
}

function showReport(r) {
  const blocks = Object.entries(r.diffs ?? {}).map(([name, d]) => diffBlock(d, name));
  result.replaceChildren(
    h("p", {}, `${r.mod} (${r.copy}), seed ${r.seed}${r.age ? `, ${r.age}` : ""}: the mod off, then on.`),
    ...(r.warnings ?? []).map((w) => h("p", { class: "sev-warn" }, w)),
    ...(blocks.length ? blocks : [muted("No Debug database was copied from both games.")]));
}

async function compareFiles() {
  const a = el.a.value.trim();
  const b = el.b.value.trim();
  if (!a || !b) { toast("Give two database files.", true); return; }
  result.replaceChildren(muted("comparing..."));
  try {
    const q = new URLSearchParams({ a, b, limit: el.limit.value || "5", tables: el.tables.value.trim() });
    result.replaceChildren(diffBlock(await api(`/api/dbdiff/files?${q}`), ""));
  } catch (e) { result.replaceChildren(); toast(messageOf(e), true); }
}

async function runMod() {
  const mod = el.mod.value.trim();
  if (!mod) { toast("Which mod id?", true); return; }
  if (!state.armed) { toast("Arm writes first: this starts two test games and switches the registry.", true); return; }
  result.replaceChildren(muted("running two test games; this takes several minutes..."));
  try {
    showReport(await api("/api/dbdiff/run", { mod, seed: el.seed.value || 4242, age: el.age.value.trim() || null,
      limit: el.limit.value || 5 }));
    loadReports();
  } catch (e) { result.replaceChildren(); toast(messageOf(e), true); }
}

async function openReport(name) {
  try { showReport(await api(`/api/dbdiff/report?name=${encodeURIComponent(name)}`)); } catch (e) { toast(messageOf(e), true); }
}

async function loadReports() {
  try {
    const list = await api("/api/dbdiff/reports");
    reports.replaceChildren(...(list.length ? list.map((r) => h("div", {},
      h("button", { onclick: () => openReport(r.name) }, r.name), ` ${r.mod ?? "?"}`,
      r.seed != null ? muted(` seed ${r.seed}`) : null)) : [muted("No saved runs yet.")]));
  } catch (e) { toast(messageOf(e), true); }
}

function build() {
  result = h("div", {});
  reports = h("div", {}, muted("..."));
  return [
    h("p", { class: "note" }, "What a mod actually changed in the compiled database. A run starts two seeded test games, "
      + "the mod off and then on, copies each game's Debug databases and diffs them; your saves, settings and "
      + "registry are restored after each game. Any two SQLite files can be compared directly."),
    h("div", { class: "row" }, input("mod", { placeholder: "mod id", style: "width:220px" }),
      input("seed", { placeholder: "seed (4242)", style: "width:110px" }),
      input("age", { placeholder: "AGE_ANTIQUITY", style: "width:150px" }),
      h("button", { class: "primary", onclick: runMod }, "Run off vs on")),
    h("div", { class: "row" }, input("a", { placeholder: "before.sqlite", style: "width:300px" }),
      input("b", { placeholder: "after.sqlite", style: "width:300px" }),
      h("button", { onclick: compareFiles }, "Compare files")),
    h("div", { class: "row" }, input("tables", { placeholder: "only tables (comma-separated)", style: "width:260px" }),
      input("limit", { placeholder: "sample rows (5)", style: "width:130px" })),
    result,
    h("h3", {}, "Saved runs"), reports,
  ];
}

registerTab({ id: "dbdiff", label: "DB diff", build, load: loadReports });
