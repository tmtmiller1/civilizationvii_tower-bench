import { h, api, toast, muted, headRow, messageOf, registerTab } from "./core.js";

// Which of a mod's functions and branches ran: V8 precise coverage over CDP (changes no file), or counting
// copies of the mod's JS written into the live copy. Either read is saved and reported here.

const input = (attrs) => /** @type {HTMLInputElement} */ (h("input", attrs));

const els = {
  dir: input({ type: "text", placeholder: "path to the mod folder you edit", size: 60 }),
  reload: input({ type: "checkbox" }),
  log: input({ type: "checkbox" }),
  out: h("div", { class: "stack" }),
  reads: /** @type {HTMLSelectElement} */ (h("select", {})),
  report: h("div", { class: "stack" }),
};

const dir = () => els.dir.value.trim();
const frac = (x) => `${x.hit}/${x.total}`;
const pre = (v) => h("pre", { class: "snippet" }, typeof v === "string" ? v : JSON.stringify(v, null, 2));

async function run(label, fn, needDir = true) {
  if (needDir && !dir()) { toast("Point it at a mod folder first.", true); return; }
  els.out.replaceChildren(muted(`${label}...`));
  try {
    const r = await fn();
    els.out.replaceChildren(pre(r));
    await loadReads();
  } catch (e) { els.out.replaceChildren(); toast(messageOf(e), true); }
}

function showProbe(r) {
  els.out.replaceChildren(
    h("p", { class: r.verdict === "PROFILER ANSWERS" ? "ok" : "sev-error" }, `${r.verdict} (debugger on the ${r.scope} page)`),
    ...r.steps.map((s) => h("div", { class: "mono" }, `${s.method}: ${s.ok ? "answered" : `ERROR ${s.error}`}`,
      s.ok && s.answer ? h("div", { class: "note" }, JSON.stringify(s.answer).slice(0, 600)) : null)),
    h("p", { class: "note" }, `/json/protocol Profiler: ${r.protocol.commands?.join(", ") ?? r.protocol.error}`));
}

async function probe() {
  els.out.replaceChildren(muted("asking the debugger..."));
  try { showProbe(await api("/api/coverage/probe", {})); } catch (e) { els.out.replaceChildren(); toast(messageOf(e), true); }
}

async function instrument() {
  if (!dir()) { toast("Point it at a mod folder first.", true); return; }
  try {
    const plan = await api(`/api/coverage/plan?dir=${encodeURIComponent(dir())}`);
    const n = plan.files.filter((f) => !f.skipped).length;
    const ok = window.confirm(`Write counting copies of ${n} file(s) into ${plan.liveDir} and reload the UI? `
      + "Restore puts the plain source back.");
    if (ok) await run("instrumenting", () => api("/api/coverage/instrument", { dir: dir() }));
  } catch (e) { toast(messageOf(e), true); }
}

function fileRows(s) {
  return s.files.map((f) => h("tr", {},
    h("td", {}, f.rel, f.note ? h("div", { class: "note" }, f.note) : null),
    h("td", { class: "num" }, frac(f.functions)), h("td", { class: "num" }, frac(f.blocks)),
    h("td", {}, f.ran === false ? h("span", { class: "sev-warn" }, "never loaded") : f.ran ? "yes" : "?")));
}

function showReport(s) {
  const never = s.neverRan.map((u) => h("div", { class: "mono" }, `${u.rel}:${u.line}  ${u.name}`));
  els.report.replaceChildren(
    h("p", {}, `${s.modId}, ${s.route === "cdp" ? "V8 precise coverage" : "counting copies"}, read ${new Date(s.at).toLocaleString()}: `
      + `functions ${frac(s.total.functions)}, blocks ${frac(s.total.blocks)}`),
    ...s.notes.map((n) => h("p", { class: "note" }, n)),
    h("table", {}, headRow(["File", "Functions", "Blocks", "Loaded"]), h("tbody", {}, fileRows(s))),
    h("h3", {}, `Never ran (${s.neverRan.length})`),
    never.length ? never : muted("Every function ran at least once."),
    h("details", {}, h("summary", {}, "Markdown"), pre(s.markdown)));
}

async function loadReads() {
  try {
    const names = await api("/api/coverage/reads");
    els.reads.replaceChildren(...names.map((n) => h("option", { value: n }, n)));
    if (names.length) await openReport(names[0]);
    else els.report.replaceChildren(muted("No coverage read saved yet."));
  } catch (e) { toast(messageOf(e), true); }
}

async function openReport(name) {
  try { showReport(await api(`/api/coverage/report?name=${encodeURIComponent(name)}`)); } catch (e) { toast(messageOf(e), true); }
}

const button = (label, onclick, cls) => h("button", { class: cls, onclick }, label);

registerTab({
  id: "coverage",
  label: "Coverage",
  build: () => [
    h("div", { class: "card" },
      h("h2", {}, "Coverage"),
      h("p", { class: "note" }, "Which of a mod's functions and branches ran in this session. CDP route: V8 precise "
        + "coverage, no file changed; probe first. Counting route: copies of the mod's JS that count each function "
        + "and if/else/case/catch block, written into the live copy (never the source or a Workshop copy)."),
      h("div", { class: "row" }, els.dir),
      h("div", { class: "row" },
        button("Probe the Profiler", probe),
        button("Start CDP coverage", () => run("starting", () => api("/api/coverage/cdp/start", { reload: els.reload.checked }), false)),
        h("label", {}, els.reload, " reload the UI after starting"),
        button("Take CDP coverage", () => run("taking", () => api("/api/coverage/cdp/take", { dir: dir(), stop: true })), "primary")),
      h("div", { class: "row" },
        button("Instrument", instrument),
        button("Read counters", () => run("reading", () => api("/api/coverage/read", { log: els.log.checked }), false), "primary"),
        h("label", {}, els.log, " from the newest UI.log dump"),
        button("Dump to UI.log", () => run("dumping", () => api("/api/coverage/dump", {}), false)),
        button("Restore plain source", () => {
          if (window.confirm("Put the plain source back over the counting copies and reload the UI?")) {
            run("restoring", () => api("/api/coverage/restore", { dir: dir() }));
          }
        })),
      els.out),
    h("div", { class: "card" },
      h("h2", {}, "Report"),
      h("div", { class: "row" }, els.reads, button("Open", () => openReport(els.reads.value))),
      els.report),
  ],
  load: loadReads,
});
