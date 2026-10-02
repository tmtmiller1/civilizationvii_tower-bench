import { h, api, toast, muted, messageOf, registerTab } from "./core.js";
import { techniqueLinks } from "./techniques.js";

// Before a release: the release check on a folder and its zip, and the localization lint.
const STATUS = { FAIL: "sev-error", WARN: "sev-warn", PASS: "ok", INFO: "sev-info" };
const SEVERITY = { error: "sev-error", warn: "sev-warn", info: "sev-info" };

const input = (attrs) => /** @type {HTMLInputElement} */ (h("input", { type: "text", size: 60, ...attrs }));

const els = {
  dir: input({ placeholder: "the mod folder you ship (for example its dist/ folder)" }),
  zip: input({ placeholder: "optional: the release zip, checked against the folder" }),
  against: input({ placeholder: "optional: the last release's zip or folder" }),
  release: h("div", { class: "stack" }),
  l10n: h("div", { class: "stack" }),
  scope: input({ placeholder: "optional CSS selector to limit the walk", size: 30 }),
};

const checkRow = (c) => h("div", { class: "issue" },
  h("span", { class: STATUS[c.status] ?? "" }, c.status), ` ${c.check}: ${c.text}`,
  c.fix && (c.status === "FAIL" || c.status === "WARN") ? h("div", { class: "note" }, `Fix: ${c.fix}`) : null,
  techniqueLinks(c.techniques));

async function runRelease() {
  const [dir, zip, against] = [els.dir, els.zip, els.against].map((e) => e.value.trim());
  if (!dir && !zip) { toast("Point it at a mod folder or a zip first.", true); return; }
  els.release.replaceChildren(muted("reading the package (the pre-flight read takes a few seconds)..."));
  const q = new URLSearchParams({ dir, zip, against });
  try {
    const r = await api(`/api/release-check?${q}`);
    els.release.replaceChildren(
      h("p", { class: STATUS[r.verdict] }, `${r.id} ${r.version ?? "(no version)"}: ${r.verdict}`),
      h("p", { class: "note" }, `${r.package.kind} ${r.package.path}, ${r.package.files} files. Read from files, not run.`),
      ...r.checks.map(checkRow));
  } catch (e) { els.release.replaceChildren(); toast(messageOf(e), true); }
}

const findingRow = (f) => h("div", { class: "issue" },
  h("span", { class: SEVERITY[f.severity] ?? "" }, f.severity), ` ${f.rule}: ${f.text}`, techniqueLinks(f.techniques));

async function runL10n() {
  const dir = els.dir.value.trim();
  if (!dir) { toast("Point it at a mod folder first.", true); return; }
  els.l10n.replaceChildren(muted("reading the mod's text against the installed game..."));
  try {
    const r = await api(`/api/l10n?dir=${encodeURIComponent(dir)}`);
    els.l10n.replaceChildren(
      h("p", {}, `${r.id}: ${r.used} tag(s) used, ${r.english} defined in English${r.gameVersion ? `; base game ${r.gameVersion}` : "; base game not read"}`),
      h("p", { class: "note mono" }, r.languages.map((l) => `${l.lang} ${l.tags} (-${l.missing} +${l.extra})`).join("  ")),
      ...(r.findings.length ? r.findings.map(findingRow) : [h("span", { class: "ok" }, "No localization findings.")]));
  } catch (e) { els.l10n.replaceChildren(); toast(messageOf(e), true); }
}

async function runLive() {
  els.l10n.replaceChildren(muted("walking the live UI..."));
  try {
    const r = await api(`/api/l10n/live?scope=${encodeURIComponent(els.scope.value.trim())}`);
    els.l10n.replaceChildren(
      h("p", {}, `${r.issues.length} issue(s) in ${r.visited} element(s); page language ${r.lang ?? "(none)"}`),
      ...(r.issues.length ? r.issues.map((i) => h("div", { class: "issue" }, h("span", { class: "sev-warn" }, i.rule), ` ${i.path}: ${i.detail}`))
        : [h("span", { class: "ok" }, "No boxed text on this screen.")]));
  } catch (e) { els.l10n.replaceChildren(); toast(messageOf(e), true); }
}

registerTab({
  id: "release",
  label: "Release",
  build: () => h("div", { class: "stack" },
    h("div", { class: "card stack" },
      h("h3", {}, "Release check"),
      h("p", { class: "note" }, "Catches the slips that ship a broken release: version not raised, stale zip, missing or stray files, dev leftovers, a nested copy of the mod, probes left on, names that do not resolve, a Steam .vdf that uploads the wrong folder."),
      h("label", {}, "Mod folder ", els.dir), h("label", {}, "Zip ", els.zip), h("label", {}, "Against ", els.against),
      h("div", { class: "row" },
        h("button", { class: "primary", onclick: runRelease }, "Check release"),
        h("button", { onclick: runL10n }, "Check localization")),
      els.release),
    h("div", { class: "card stack" },
      h("h3", {}, "Localization"),
      h("div", { class: "row" }, els.scope, h("button", { onclick: runLive }, "Find boxed text on screen")),
      h("p", { class: "note" }, "The on-screen walk reads the running UI (not watched yet); the lint reads files."),
      els.l10n)),
});
