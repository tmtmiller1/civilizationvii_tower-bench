import { $, state, h, api, muted, messageOf } from "./core.js";
import { techniqueLinks } from "./techniques.js";

function leafClass(v) {
  if (typeof v === "string") return v.startsWith("[") ? "m" : "s";
  return typeof v === "number" ? "n" : "m";
}

const leafText = (v) => (typeof v === "string" && !v.startsWith("[") ? JSON.stringify(v) : String(v));

function tree(v, key) {
  const label = key == null ? null : h("span", { class: "k" }, key + ": ");
  if (v === null || typeof v !== "object") return h("div", {}, label, h("span", { class: leafClass(v) }, leafText(v)));
  const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
  const d = h("details", { open: key == null || entries.length <= 8 });
  d.append(h("summary", {}, label, Array.isArray(v) ? `array(${v.length})` : `object {${entries.length}}`));
  for (const [k, x] of entries) {
    if (k === "__methods") d.append(h("div", {}, h("span", { class: "k" }, "methods: "), h("span", { class: "m" }, x.join("  "))));
    else d.append(tree(x, k));
  }
  return d;
}

function sqlTable(r) {
  if (!r.rows.length) return muted("0 rows");
  const cols = Object.keys(r.rows[0]);
  const cell = (v) => h("td", {}, v == null ? "" : String(v));
  return h("div", {},
    h("table", {}, h("thead", {}, h("tr", {}, cols.map((c) => h("th", {}, c)))),
      h("tbody", {}, r.rows.map((row) => h("tr", {}, cols.map((c) => cell(row[c])))))),
    h("p", { class: "muted" }, `${r.total} row(s)${r.truncated ? `, first ${r.rows.length} shown` : ""}`));
}

function currentLang() {
  const checked = document.querySelector("input[name=lang]:checked");
  return checked instanceof HTMLInputElement ? checked.value : "js";
}

async function run() {
  const code = $("code").value.trim();
  if (!code) return;
  const lang = currentLang();
  const t0 = performance.now();
  $("run-meta").textContent = "running...";
  try {
    if (lang === "sql") $("output").replaceChildren(sqlTable(await api("/api/sql", { sql: code })));
    else {
      const r = await api("/api/eval", { code });
      $("output").replaceChildren(...[tree(r.value), techniqueLinks(r.techniques, "Techniques that use this:")].filter((el) => el !== null));
    }
    remember(lang, code);
  } catch (e) {
    $("output").replaceChildren(h("pre", { class: "error" }, messageOf(e)));
  }
  $("run-meta").textContent = `${Math.round(performance.now() - t0)} ms`;
}

function remember(lang, code) {
  state.history = [{ lang, code }, ...state.history.filter((x) => x.code !== code)].slice(0, 40);
  try { localStorage.setItem("tb-history", JSON.stringify(state.history)); } catch {}
  paintHistory();
}

function paintHistory() {
  const label = (x) => `${x.lang.toUpperCase()}  ${x.code.replace(/\s+/g, " ").slice(0, 70)}`;
  $("history").replaceChildren(h("option", { value: "" }, "History"),
    ...state.history.map((x, i) => h("option", { value: i }, label(x))));
}

try { state.history = JSON.parse(localStorage.getItem("tb-history") ?? "[]"); } catch {}
paintHistory();
$("history").addEventListener("change", () => {
  const x = state.history[Number($("history").value)];
  if (!x) return;
  $("code").value = x.code;
  const radio = document.querySelector(`input[name=lang][value=${x.lang}]`);
  if (radio instanceof HTMLInputElement) radio.checked = true;
  $("history").value = "";
});
$("run").addEventListener("click", run);
$("code").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); }
});
