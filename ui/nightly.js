import { h, api, toast, muted, messageOf, headRow, registerTab } from "./core.js";

// Overnight regression runs: the suite, the last reports with what newly fails or was fixed, and the schedule.
const VERDICT = { PASS: "sev-info", FAIL: "sev-warn", "BROKE-BY-UPDATE": "sev-error" };

const els = {
  suite: h("div", {}),
  schedule: h("div", {}),
  reports: h("div", {}),
  detail: h("div", { class: "stack" }),
};

function suiteView(s) {
  if (s.error) return h("p", { class: "sev-warn" }, `Suite: ${s.error}`);
  return h("div", {}, h("p", { class: "muted mono" }, s.file),
    h("p", {}, `${s.mods.length} mod(s); a save written in the last ${s.quietMinutes} minute(s) stops the run.`),
    h("table", {}, headRow(["Mod folder", "Recipes", "Checks"]),
      h("tbody", {}, s.mods.map((m) => h("tr", {}, h("td", { class: "mono" }, m.folder), h("td", {}, String(m.recipes)),
        h("td", {}, m.checks.join(", ")))))));
}

function scheduleView(s) {
  if (s.supported === false) return h("p", { class: "note" }, `${s.note}. "nightly schedule" prints the line to add.`);
  if (!s.installed) {
    return h("p", { class: "note" }, s.note ?? "Not scheduled. Install it with: tower-bench nightly schedule --at 03:00 --yes");
  }
  return h("div", {}, h("p", {}, `Daily at ${s.at}; ${s.loaded ? "loaded in launchd" : "file present but NOT loaded"}.`),
    h("p", { class: "muted mono" }, s.file), s.log ? h("p", { class: "muted mono" }, `log: ${s.log}`) : null);
}

const counts = (x) => (x.summary ? `${x.summary.pass} pass, ${x.summary.fail} fail, ${x.summary.broke} broke by update` : "unreadable");
const names = (list) => (list?.length ? list.join(", ") : "none");

function gameText(g) {
  if (!g) return "";
  if (!g.updated) return g.installed ?? "?";
  return g.previous ? `${g.previous} -> ${g.installed}` : `${g.installed} (baseline)`;
}

function reportsView(list) {
  if (!list.length) return muted("No nightly reports yet. Run: tower-bench nightly run");
  return h("table", {}, headRow(["Started", "Game", "Result", "Newly failing", "Fixed", ""]),
    h("tbody", {}, list.map((x) => h("tr", {},
      h("td", {}, new Date(x.startedAt).toLocaleString()),
      h("td", {}, gameText(x.game)),
      h("td", {}, counts(x), x.stopped ? h("div", { class: "sev-warn", title: x.stopped }, "stopped early") : null),
      h("td", { class: x.compare?.newlyFailing?.length ? "sev-error" : "" }, names(x.compare?.newlyFailing)),
      h("td", {}, names(x.compare?.fixed)),
      h("td", {}, h("button", { onclick: () => openReport(x.file) }, "Open"))))));
}

const runLine = (r) => h("div", { class: "mono" },
  `${r.passed ? "passed" : "FAILED"} ${r.name ?? r.recipe}`,
  r.crash?.crash?.signature ? ` (crash ${r.crash.crash.signature}; next: ${r.crash.next ?? "bisect"})` : "");

const modCard = (m) => h("div", { class: "card" },
  h("h3", {}, h("span", { class: VERDICT[m.verdict] ?? "" }, m.verdict), ` ${m.id ?? m.folder.split(/[\\/]/).pop()}`),
  h("p", { class: "muted mono" }, m.folder),
  m.reasons.map((why) => h("div", {}, why)), m.runs.map(runLine),
  m.notRun?.length ? h("div", { class: "sev-warn" }, `${m.notRun.length} recipe(s) not run tonight`) : null);

async function openReport(file) {
  els.detail.replaceChildren(muted("reading the report..."));
  try {
    const r = await api(`/api/nightly/report?file=${encodeURIComponent(file)}`);
    els.detail.replaceChildren(h("h3", {}, `Nightly ${new Date(r.startedAt).toLocaleString()}`),
      r.stopped ? h("p", { class: "sev-warn" }, `Stopped early: ${r.stopped}`) : "",
      h("p", { class: "muted mono" }, r.files?.html ?? ""), ...r.mods.map(modCard));
  } catch (e) { els.detail.replaceChildren(); toast(messageOf(e), true); }
}

async function load() {
  try {
    const r = await api("/api/nightly");
    els.suite.replaceChildren(suiteView(r.suite));
    els.schedule.replaceChildren(scheduleView(r.schedule));
    els.reports.replaceChildren(reportsView(r.reports));
  } catch (e) { toast(messageOf(e), true); }
}

registerTab({
  id: "nightly",
  label: "Nightly",
  build: () => [
    h("div", { class: "card" }, h("h2", {}, "Nightly"),
      h("p", { class: "note" }, "A regression run over the suite's mods: on a new game version it indexes the "
        + "game and lists what the update breaks, then checks each mod from files and runs its recipes in seeded lab "
        + "games, restoring everything after each. Runs from the terminal or the schedule, never from this page."),
      h("button", { onclick: load }, "Refresh")),
    h("div", { class: "card" }, h("h3", {}, "Suite"), els.suite),
    h("div", { class: "card" }, h("h3", {}, "Schedule"), els.schedule),
    h("div", { class: "card" }, h("h3", {}, "Reports"), els.reports),
    els.detail,
  ],
  load,
});
