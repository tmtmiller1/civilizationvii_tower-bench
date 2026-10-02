import { h, api, toast, muted, messageOf, registerTab } from "./core.js";
import { techniqueLinks } from "./techniques.js";

// Game updates: index the installed game, compare two indexes, and list what the update breaks in each mod.
const SEV = { High: "sev-error", Medium: "sev-warn", Low: "sev-info" };

const els = {
  status: h("p", { class: "note" }, ""),
  from: /** @type {HTMLSelectElement} */ (h("select", {})),
  to: /** @type {HTMLSelectElement} */ (h("select", {})),
  mods: /** @type {HTMLInputElement} */ (h("input", { type: "text", value: "enabled",
    placeholder: "enabled, all, or mod folders (comma-separated)" })),
  out: h("div", { class: "stack" }),
};

function fillVersions(indexes) {
  for (const [sel, pick] of [[els.from, indexes.at(-2)], [els.to, indexes.at(-1)]]) {
    sel.replaceChildren(...indexes.map((v) => h("option", { value: v, selected: v === pick }, v)));
  }
}

async function loadIndexes() {
  try {
    const r = await api("/api/game/indexes");
    fillVersions(r.indexes);
    const s = r.status;
    els.status.className = s?.changed ? "sev-warn" : "note";
    els.status.textContent = [`Indexes on file: ${r.indexes.join(", ") || "none"}.`,
      s ? `Installed: ${s.installed}.` : "The installed version cannot be read here.", s?.message ?? ""].join(" ");
  } catch (e) { toast(messageOf(e), true); }
}

async function snapshot() {
  els.out.replaceChildren(muted("indexing the installed game (about a minute on a cold disk)..."));
  try {
    let r;
    try { r = await api("/api/game/snapshot", {}); } catch (e) {
      if (!/--yes/.test(messageOf(e)) || !confirm(`${messageOf(e)}\n\nReplace it?`)) throw e;
      r = await api("/api/game/snapshot", { yes: true });
    }
    els.out.replaceChildren(h("p", {}, `Indexed game ${r.version}: ${r.stats.files} files, ${r.stats.tables} tables, `
      + `${Math.round(r.bytes / 1024)} KB.`), r.schemaNote ? h("p", { class: "sev-warn" }, `No schema: ${r.schemaNote}`) : "");
    await loadIndexes();
  } catch (e) { els.out.replaceChildren(); toast(messageOf(e), true); }
}

const pair = () => `from=${encodeURIComponent(els.from.value)}&to=${encodeURIComponent(els.to.value)}`;

/**
 * A collapsed list, or nothing when it is empty.
 * @param {string} title @param {any[]} items @param {(x: any) => string} [fmt]
 * @returns {HTMLElement | string}
 */
function list(title, items, fmt = (x) => String(x)) {
  if (!items.length) return "";
  return h("details", {}, h("summary", {}, `${title} (${items.length})`),
    h("div", { class: "mono" }, items.slice(0, 300).map((x) => h("div", {}, fmt(x)))));
}

async function diff() {
  els.out.replaceChildren(muted("comparing..."));
  try {
    const d = await api(`/api/game/diff?${pair()}`);
    const fact = (f) => `${f.db}.${f.table}${f.column ? `.${f.column}` : ""}`;
    const s = d.schema.available ? d.schema : null;
    els.out.replaceChildren(h("div", {}, h("h3", {}, `Game ${d.from} to ${d.to}`),
      list("Files moved or renamed", d.files.moved, (m) => `${m.from} -> ${m.to} (${m.how})`),
      list("Files removed", d.files.removed), list("Files added", d.files.added), list("Files changed", d.files.changed),
      list("Exports lost", d.exports.filter((e) => e.removed.length), (e) => `${e.file}: ${e.removed.join(", ")}`),
      list("Components removed", [...d.components.legacy.removed, ...d.components.registry.removed]),
      list("Components added", [...d.components.legacy.added, ...d.components.registry.added]),
      s ? [list("Tables removed", s.tablesRemoved, fact), list("Tables added", s.tablesAdded, fact),
        list("Columns removed", s.columnsRemoved, fact), list("Columns now required", s.nowRequired, fact),
        list("Effect types removed", d.effectTypes.removed)] : h("p", { class: "sev-warn" }, `Schema not compared: ${d.schema.note}`)));
  } catch (e) { els.out.replaceChildren(); toast(messageOf(e), true); }
}

const findingRow = (f) => h("div", { class: "issue" },
  h("span", { class: SEV[f.severity] }, f.severity), ` ${f.text}`,
  h("div", { class: "mono" }, `was ${f.was}`), h("div", { class: "mono" }, `now ${f.now}`),
  h("div", {}, `Fix: ${f.fix}`), f.files?.length ? h("div", { class: "muted" }, `in ${f.files.slice(0, 3).join(", ")}`) : null,
  techniqueLinks(f.techniques));

async function impact() {
  els.out.replaceChildren(muted("reading mod folders..."));
  try {
    const r = await api(`/api/game/impact?${pair()}&mods=${encodeURIComponent(els.mods.value.trim() || "enabled")}`);
    els.out.replaceChildren(h("div", {},
      h("p", {}, `Game ${r.from} to ${r.to}: ${r.affected} of ${r.checked} mod(s) affected. Read from files, not run.`),
      r.schemaNote ? h("p", { class: "sev-warn" }, `Database not compared: ${r.schemaNote}`) : null,
      r.failed.map((f) => h("p", { class: "sev-warn" }, `Could not read ${f.folder}: ${f.error}`)),
      r.mods.length ? r.mods.map((m) => h("div", { class: "card" }, h("h3", {}, `${m.name} (${m.id})`),
        h("p", { class: "muted mono" }, m.folder), m.findings.map(findingRow)))
        : muted("Nothing these mods use changed.")));
  } catch (e) { els.out.replaceChildren(); toast(messageOf(e), true); }
}

registerTab({
  id: "patch",
  label: "Game updates",
  build: () => [
    h("div", { class: "card" }, h("h2", {}, "Game updates"),
      h("p", { class: "note" }, "Index the game before and after an update, then see which mods the update breaks. "
        + "The first launch after an update loads no mods; launch once more to get them back."),
      els.status,
      h("div", { class: "row" }, h("button", { onclick: snapshot }, "Snapshot installed game"),
        h("label", {}, "from ", els.from), h("label", {}, "to ", els.to),
        h("button", { onclick: diff }, "What changed"), els.mods, h("button", { class: "primary", onclick: impact }, "Which mods break"))),
    els.out,
  ],
  load: loadIndexes,
});
