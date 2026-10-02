// API atlas tab: search the engine API atlas and read one member: kind, arity, where it was seen live, how
// the game's scripts use it, its declared signature and the findings about it.
import { h, api, toast, muted, headRow, messageOf, registerTab } from "./core.js";

const els = {
  query: /** @type {HTMLInputElement} */ (h("input", { placeholder: "member or text, e.g. sendRequest", style: "flex:1" })),
  info: h("p", { class: "note" }, muted("Loading...")),
  list: h("div", { class: "tq-list" }, muted("Search for a member.")),
  detail: h("div", { class: "tq-detail" }, muted("Pick a member to see it.")),
  live: /** @type {HTMLInputElement} */ (h("input", { type: "checkbox" })),
};

// Existing verdict colours, one per badge.
const BADGE_CLASS = { LIVE: "v-LANDED", USED: "v-ALREADY", DOCUMENTED: "v-REFUSED", WATCHED: "v-NOEFFECT" };
const badges = (list) => (list ?? []).map((b) => [h("span", { class: `verdict ${BADGE_CLASS[b] ?? ""}` }, b), " "]);
const table = (cols, rows) => h("table", {}, headRow(cols), h("tbody", {}, rows));

async function loadInfo() {
  try {
    const all = await api("/api/atlas/list");
    els.info.replaceChildren(all.length
      ? `Atlases saved: ${all.map((a) => `${a.version} (built ${a.mtime.slice(0, 16).replace("T", " ")})`).join(", ")}. `
        + "Badges: LIVE seen on a running page, USED by the game's scripts, DOCUMENTED in declarations, WATCHED by a finding."
      : muted("No atlas yet. Build one from the installed game; add a live crawl when the game is running."));
  } catch (e) { els.info.replaceChildren(muted(messageOf(e))); }
}

function resultItem(r) {
  return h("div", { class: "tq-item", onclick: () => show(r.path) },
    h("code", {}, r.path), " ", muted(`${r.kind}${r.arity !== null ? `/${r.arity}` : ""}${r.uses ? `, ${r.uses} uses` : ""}`),
    h("div", {}, badges(r.badges)));
}

async function search() {
  const q = els.query.value.trim();
  if (!q) return;
  els.list.replaceChildren(muted("Searching..."));
  try {
    const r = await api(`/api/atlas/search?q=${encodeURIComponent(q)}&limit=100`);
    els.list.replaceChildren(h("p", { class: "note" }, `${r.total} match(es)${r.total > r.results.length ? `, first ${r.results.length}` : ""}`),
      ...r.results.map(resultItem));
    if (r.results.length === 1 || r.results[0]?.path.toLowerCase() === q.toLowerCase()) show(r.results[0].path);
  } catch (e) { els.list.replaceChildren(muted(messageOf(e))); }
}

function liveRows(m) {
  const scopes = Object.entries(m.live);
  if (!scopes.length) return muted("Not seen live: no crawl of a page that has it, or not crawled yet.");
  return table(["Page", "Kind", "Detail"], scopes.map(([scope, r]) => h("tr", {}, h("td", {}, scope), h("td", {}, r.kind),
    h("td", {}, h("code", {}, JSON.stringify({ ...r, kind: undefined }))))));
}

function usageBlock(u) {
  if (!u) return muted("Not used by the game's scripts.");
  const args = Object.entries(u.args).map(([n, c]) => `${n} arg(s) x${c}`).join(", ");
  return h("div", {}, h("p", {}, `Used ${u.count} time(s) in ${u.files} file(s)${args ? `; called with ${args}` : ""}.`),
    h("ul", {}, u.examples.map((e) => h("li", {}, h("code", {}, e)))));
}

function verdictBlock(list) {
  if (!list.length) return muted("No findings name it.");
  return h("ul", {}, list.map((v) => h("li", {}, h("span", { class: `verdict ${v.level === "watched" ? "v-NOEFFECT" : "v-REFUSED"}` },
    v.level ?? "?"), " ", v.date ? `${v.date} ` : "", v.claim, v.role === "mention" ? muted(" (mentioned, not the subject)") : "")));
}

function childList(children) {
  if (!children.length) return h("span", {});
  return h("div", {}, h("h4", {}, `Members (${children.length})`), h("div", {}, children.map((c) => [
    h("a", { href: "#", onclick: (e) => { e.preventDefault(); show(c.path); } }, c.path.split(".").at(-1)), " "])));
}

function memberView(r) {
  const m = r.member;
  const head = m
    ? [h("h3", { class: "tq-title" }, h("code", {}, m.path)), h("p", {}, `${m.kind}${m.arity !== null ? `, arity ${m.arity}` : ""} `, badges(m.badges))]
    : [h("h3", { class: "tq-title" }, h("code", {}, r.root.name)), h("p", {}, `${r.root.members} member(s), used ${r.root.used} time(s)`)];
  if (!m) return [...head, childList(r.children)];
  return [...head,
    h("h4", {}, "Live"), liveRows(m),
    h("h4", {}, "Declared"), m.sdk ? h("code", {}, m.sdk.signature) : muted("Not in the declarations the atlas was built with."),
    h("h4", {}, "Used by the game"), usageBlock(m.usage),
    h("h4", {}, "Findings"), verdictBlock(r.verdicts),
    childList(r.children)];
}

async function show(name) {
  els.detail.replaceChildren(muted("Reading..."));
  try {
    const r = await api(`/api/atlas/show?member=${encodeURIComponent(name)}`);
    els.detail.replaceChildren(...(r ? memberView(r) : [muted(`"${name}" is not in the atlas.`)]));
  } catch (e) { els.detail.replaceChildren(muted(messageOf(e))); }
}

async function build() {
  toast(els.live.checked ? "Reading the game's scripts and crawling the page..." : "Reading the game's scripts...");
  try {
    const r = await api("/api/atlas/build", { live: els.live.checked });
    const s = r.summary;
    toast(`Atlas for ${s.gameVersion}: ${s.members} members (LIVE ${s.live}, USED ${s.used}, DOCUMENTED ${s.documented}, WATCHED ${s.watched})`);
    loadInfo();
  } catch (e) { toast(messageOf(e), true); }
}

registerTab({
  id: "atlas",
  label: "API atlas",
  build: () => h("div", { class: "stack" },
    h("div", { class: "card" }, els.info,
      h("div", { class: "row" }, h("button", { onclick: build }, "Build atlas"),
        h("label", {}, els.live, " with a live crawl of the connected page (read-only)"))),
    h("div", { class: "card" },
      h("div", { class: "row" }, els.query, h("button", { class: "primary", onclick: search }, "Search")),
      h("div", { class: "row tq-wrap", style: "margin-top:8px" }, els.list, els.detail))),
  load: () => {
    loadInfo();
    els.query.onkeydown = (e) => { if (e.key === "Enter") search(); };
  },
});
