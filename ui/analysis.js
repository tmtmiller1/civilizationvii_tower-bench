import { $, h, api, toast, muted, messageOf } from "./core.js";
import { techniqueLinks } from "./techniques.js";

const SEV = { High: "sev-error", Medium: "sev-warn", Low: "sev-info" };
const VERDICT = { "BLOCKS GAME": "sev-error", "FEATURE DEAD": "sev-warn", MINOR: "sev-info", CLEAN: "ok" };

const conflictRow = (c) => h("div", { class: "issue" },
  h("span", { class: SEV[c.severity] }, c.severity), ` ${c.a} / ${c.b}: ${c.text}`,
  c.proof ? h("span", { class: c.proof.verdict === "CONFIRMED" ? "sev-error" : "muted" }, `  [${c.proof.label}]`) : null,
  c.prove ? h("span", { class: "tq-links" }, `Prove it: tower-bench ${c.prove}`) : null,
  techniqueLinks(c.techniques));

const defectRow = (d) => h("div", { class: "issue" },
  h("span", { class: VERDICT[d.verdict] }, d.verdict), ` ${d.rule}${d.age ? ` (${d.age})` : ""}: ${d.text}`,
  techniqueLinks(d.techniques));

const schemaNote = (r) => (r.schemaNote ? h("p", { class: "sev-warn" }, `Database checks skipped: ${r.schemaNote}`) : null);

async function runConflicts() {
  $("conf-meta").textContent = "reading mod folders...";
  try {
    const r = await api("/api/conflicts");
    const levels = $("conf-level").value === "low" ? ["High", "Medium", "Low"] : ["High", "Medium"];
    const shown = r.conflicts.filter((c) => levels.includes(c.severity));
    const n = (s) => r.conflicts.filter((c) => c.severity === s).length;
    $("conf-meta").textContent = `${r.mods} mod folders, game ${r.gameVersion}: ${n("High")} High, ${n("Medium")} Medium, ${n("Low")} Low. Read from files, not run.`;
    $("conflicts").hidden = false;
    $("conflicts").replaceChildren(...[schemaNote(r), ...(shown.length ? shown.map(conflictRow) : [muted("No conflicts at this level.")])]
      .filter((el) => el !== null));
  } catch (e) { $("conf-meta").textContent = ""; toast(messageOf(e), true); }
}

async function runCheck() {
  const dir = $("dep-dir").value.trim();
  if (!dir) { toast("Point it at a mod folder first.", true); return; }
  $("deploy").replaceChildren(muted("reading the mod against the installed game..."));
  try {
    const r = await api(`/api/check?dir=${encodeURIComponent(dir)}`);
    $("deploy").replaceChildren(...[
      h("p", { class: VERDICT[r.verdict] ?? "" }, `${r.id}: ${r.verdict} on game ${r.gameVersion}`),
      h("p", { class: "note" }, `Read from files, not run; checked against ${r.against} enabled mod(s).`),
      schemaNote(r),
      ...r.defects.map(defectRow),
      r.runtime.unresolved ? h("p", { class: "note" }, `${r.runtime.unresolved} computed run-time path(s) could not be checked.`) : null,
      r.conflicts.length ? h("h3", {}, `Conflicts with the mods the game will load (${r.conflicts.length})`) : null,
      ...r.conflicts.map(conflictRow),
    ].filter((el) => el !== null));
  } catch (e) { toast(messageOf(e), true); }
}

$("conf-run").addEventListener("click", runConflicts);
$("conf-level").addEventListener("change", runConflicts);
$("dep-check").addEventListener("click", runCheck);
