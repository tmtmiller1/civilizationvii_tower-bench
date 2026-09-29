import { $, h, api, toast, headRow, messageOf } from "./core.js";

const depDir = () => $("dep-dir").value.trim();

function liveClass(live) {
  if (live === "SERVED") return "ok";
  return /STALE|UNREADABLE/.test(live) ? "error" : "muted";
}

function reloadNote(r) {
  if (!r.connected) return "Copied. The game is not running, so nothing could be proven live yet.";
  if (r.reloaded) return "The page reloaded after the copy, so the SERVED files are now the running code.";
  if (r.reloaded === false) {
    return "The page did NOT reload: the new files are on disk but the old code is still running. "
      + "Reload was off, or no game is loaded.";
  }
  return "Could not tell whether the page reloaded.";
}

function planHeader(p) {
  const kids = [h("p", {}, `${p.modId}: the game loads ${p.liveLabel}`), h("p", { class: "muted mono" }, p.liveDir)];
  if (p.ownDeploy) {
    kids.push(h("p", { class: "sev-info" }, `This mod has its own deploy (${p.ownDeploy}). Prefer it, since it can ship `
      + "files the modinfo does not declare, such as images. Then use Prove live."));
  }
  if (p.inPlace) kids.push(h("p", {}, "That folder is the live copy itself, so edits there are already on disk."));
  for (const m of p.missing ?? []) kids.push(h("p", { class: "sev-warn" }, `declared in the modinfo but missing from the source: ${m}`));
  return kids;
}

function fileTable(files) {
  return h("table", {}, headRow(["file", "change", "in game"]),
    h("tbody", {}, files.map((f) => h("tr", {}, h("td", {}, f.rel), h("td", {}, f.state),
      h("td", { class: liveClass(f.live) }, f.live)))));
}

function planKids(r) {
  const p = r.plan;
  const kids = planHeader(p);
  const files = r.files ?? (p.changes ?? []).map((c) => ({ rel: c.rel, state: c.state, live: r.applied ? "" : "to copy" }));
  if (files.length) kids.push(fileTable(files));
  else if (!p.inPlace) kids.push(h("p", { class: "ok" }, "The live copy already matches the source."));
  if (r.applied) kids.push(h("p", {}, reloadNote(r)));
  return kids;
}

function renderPlan(r) {
  const p = r.plan;
  $("deploy").replaceChildren(...(p.refuse ? [h("p", { class: "error" }, p.refuse)] : planKids(r)));
  $("dep-go").disabled = !!p.refuse || p.inPlace || !(p.changes ?? []).length || r.applied;
}

function renderProof(r) {
  const stale = r.files.filter((f) => f.live !== "SERVED").length;
  const summary = stale ? `${stale} of ${r.files.length} UI file(s) differ from what the game serves.`
    : `All ${r.files.length} UI file(s) are what the game serves.`;
  $("deploy").replaceChildren(
    h("p", { class: stale ? "error" : "ok" }, summary),
    r.refuse ? h("p", { class: "sev-warn" }, r.refuse) : null,
    h("table", {}, h("tbody", {}, r.files.map((f) => h("tr", {}, h("td", {}, f.rel),
      h("td", { class: f.live === "SERVED" ? "ok" : "error" }, f.live))))));
}

$("dep-plan").addEventListener("click", async () => {
  try { renderPlan(await api(`/api/deploy?dir=${encodeURIComponent(depDir())}`)); } catch (e) { toast(messageOf(e), true); }
  try { localStorage.setItem("tb-dep-dir", depDir()); } catch {}
});
$("dep-go").addEventListener("click", async () => {
  $("dep-go").disabled = true;
  $("deploy").append(h("p", { class: "muted" }, "copying and watching the game..."));
  try { renderPlan(await api("/api/deploy", { dir: depDir() })); } catch (e) { toast(messageOf(e), true); }
});
$("dep-prove").addEventListener("click", async () => {
  try { renderProof(await api(`/api/prove?dir=${encodeURIComponent(depDir())}`)); } catch (e) { toast(messageOf(e), true); }
});
try { $("dep-dir").value = localStorage.getItem("tb-dep-dir") ?? ""; } catch {}
