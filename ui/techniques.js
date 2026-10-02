import { $, h, api, muted } from "./core.js";

/** @type {{ categories: { id: string, title: string, blurb?: string }[], entries: any[] } | null} */
let lib = null;
const ready = api("/api/techniques").then((l) => { lib = l; return l; }).catch(() => null);

const byId = (id) => lib?.entries.find((t) => t.id === id) ?? null;

const STATUS = { works: "works", changed: "changed in this version", dead: "no longer works" };
const badge = (t) => h("span", { class: `tq-badge tq-${t.kind === "avoid" ? "avoid" : t.status}` },
  t.kind === "avoid" ? "avoid" : STATUS[t.status] ?? t.status);

// Each optional part renders only when the entry has it.
const PARTS = [
  (t) => t.when && h("p", {}, h("strong", {}, "When. "), t.when),
  (t) => t.whenNot && h("p", {}, h("strong", {}, "Not when. "), t.whenNot),
  (t) => t.statusNote && h("p", { class: "note" }, t.statusNote),
  (t) => t.snippet && h("pre", { class: "snippet" }, t.snippet),
  (t) => t.pitfalls?.length && h("div", {}, h("strong", {}, "Pitfalls"), h("ul", {}, t.pitfalls.map((p) => h("li", {}, p)))),
  (t) => t.evidence?.note && h("p", { class: "note" }, `Evidence: ${t.evidence.note}`),
  (t) => t.watched && h("p", { class: "ok" }, `Watched by the bench: recipe ${t.watched.recipe ?? "(unnamed)"} passed in a lab game `
    + `on game ${t.watched.version ?? "?"}, ${t.watched.date.slice(0, 10)}${t.lastRun && !t.lastRun.passed ? "; the latest run failed" : ""}.`),
  (t) => t.related?.length && h("p", { class: "note" }, "Related: ", t.related.map((id, i) => [i ? ", " : "", link(id)])),
];

function entryView(t) {
  return h("div", { class: "tq-entry" },
    h("h2", { class: "tq-title" }, t.title, " ", badge(t)),
    h("p", {}, t.purpose),
    h("p", {}, h("strong", {}, "Why it works. "), t.why),
    PARTS.map((part) => part(t) || null));
}

function link(id) {
  const t = byId(id);
  return h("a", { href: `#technique/${id}`, class: "tq-link", onclick: (e) => { e.preventDefault(); openTechnique(id); } },
    t?.title ?? id);
}

/** "How to do this instead" links for a finding's technique ids; null when there are none. */
export function techniqueLinks(ids, label = "How to do this instead:") {
  if (!ids?.length) return null;
  return h("span", { class: "tq-links" }, `${label} `, ids.map((id, i) => [i ? " · " : "", link(id)]));
}

let current = null;

function paintList() {
  const l = lib;
  if (!l) return;
  const q = $("tq-search").value.trim().toLowerCase();
  const show = $("tq-show").value;
  const match = (t) => (!q || `${t.title} ${t.id} ${t.purpose} ${(t.objects ?? []).join(" ")}`.toLowerCase().includes(q))
    && (show === "all" || (show === "avoid" ? t.kind === "avoid" : t.kind !== "avoid" && t.status !== "dead"));
  const groups = l.categories.map((c) => ({ c, list: l.entries.filter((t) => t.category === c.id && match(t)) }))
    .filter((g) => g.list.length);
  $("tq-list").replaceChildren(...(groups.length ? groups.map(({ c, list }) => h("div", { class: "tq-group" },
    h("div", { class: "tq-cat", title: c.blurb ?? "" }, c.title),
    list.map((t) => h("div", { class: `tq-item${t.id === current ? " sel" : ""}`, onclick: () => openTechnique(t.id, false) },
      t.title, t.kind === "avoid" || t.status !== "works" ? [" ", badge(t)] : null,
      t.watched ? [" ", h("span", { class: "tq-badge tq-works", title: "watched by the bench" }, "watched")] : null))))
    : [muted("No technique matches.")]));
}

/** Shows one entry, switching to the Techniques tab unless asked not to. */
export async function openTechnique(id, switchTab = true) {
  await ready;
  current = id;
  if (switchTab) /** @type {HTMLElement | null} */ (document.querySelector('nav button[data-tab="techniques"]'))?.click();
  const t = byId(id);
  $("tq-entry").replaceChildren(t ? entryView(t) : muted(`No technique "${id}".`));
  paintList();
}

export async function loadTechniques() {
  await ready;
  if (!lib?.entries.length) {
    $("tq-list").replaceChildren(muted("The techniques library is missing."));
    return;
  }
  $("tq-meta").textContent = `${lib.entries.length} techniques`;
  paintList();
  if (!current) $("tq-entry").replaceChildren(muted("Pick a technique, or follow a \"How to do this instead\" link from a finding."));
}

$("tq-search").addEventListener("input", paintList);
$("tq-show").addEventListener("change", paintList);
