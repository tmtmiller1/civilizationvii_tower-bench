import { h, api, toast, muted, messageOf, registerTab } from "./core.js";
import { techniqueLinks } from "./techniques.js";

// "My mod does not work" for one folder, and crash triage for the newest (or a listed) crash report.
const VERDICT = { OK: "ok", PROBLEM: "sev-error", SKIPPED: "muted" };

const input = (attrs) => /** @type {HTMLInputElement} */ (h("input", attrs));

const els = {
  dir: input({ type: "text", placeholder: "path to the mod folder you edit", size: 60 }),
  all: input({ type: "checkbox" }),
  offline: input({ type: "checkbox" }),
  doctor: h("div", { class: "stack" }),
  crashes: /** @type {HTMLSelectElement} */ (h("select", {})),
  crash: h("div", { class: "stack" }),
};

const local = (iso) => (iso ? new Date(iso).toLocaleString() : "?");

function stepRow(s) {
  return h("div", { class: "issue" },
    h("span", { class: VERDICT[s.verdict] ?? "" }, s.verdict.padEnd(8)), ` ${s.title}: ${s.summary}`,
    (s.notes ?? []).map((n) => h("div", { class: "note" }, n)),
    s.verdict === "PROBLEM" && s.next ? h("div", {}, h("strong", {}, "Next: "), h("span", { class: "mono" }, s.next)) : null,
    techniqueLinks(s.techniques));
}

async function runDoctor() {
  const dir = els.dir.value.trim();
  if (!dir) { toast("Point it at a mod folder first.", true); return; }
  els.doctor.replaceChildren(muted("running the checks (the pre-flight read takes a few seconds)..."));
  const q = `dir=${encodeURIComponent(dir)}${els.all.checked ? "&all=1" : ""}${els.offline.checked ? "&offline=1" : ""}`;
  try {
    const r = await api(`/api/doctor?${q}`);
    const cause = r.steps.find((s) => s.id === r.cause);
    els.doctor.replaceChildren(
      h("p", {}, `${r.modId}; game ${r.connected ? "connected" : "not connected"}`),
      ...r.steps.map(stepRow),
      h("p", { class: cause ? "sev-error" : "ok" }, cause ? `First cause: ${cause.title}.` : "No cause found by these checks."));
  } catch (e) { els.doctor.replaceChildren(); toast(messageOf(e), true); }
}

const pre = (lines) => h("pre", { class: "snippet" }, lines.join("\n"));
const block = (title, lines, empty) => [h("h3", {}, title), lines.length ? pre(lines) : muted(empty)];

function contextView(x) {
  if (x.logs.run === "later") {
    return [h("p", { class: "note" }, "Log sections left out: the logs are from a later run.")];
  }
  const from = x.logs.run === "crash" ? "" : " (not dated to this crash)";
  return [
    ...block(`UI.log, last lines${from}`, x.uiTail, "Empty or missing."),
    ...block("Bench breadcrumbs", x.breadcrumbs, "None."),
    ...block("Mods the run applied", x.applied ? [x.applied.map((m) => m.id).join(", ") || "no user mods"] : [],
      "No Target Mods block in Modding.log."),
    ...block("AI logs, last rows", x.ai.flatMap((a) => [`${a.file}: ${a.header}`, ...a.last.map((l) => `  ${l}`)]),
      "No AI rows (AI verbose logging off, or no AI turn ran)."),
    ...block("Renderer.log errors", x.renderer, "None."),
  ];
}

function crashView(r) {
  if (!r.supported || !r.crash) return [muted(r.note)];
  const c = r.crash;
  const ex = [c.exception.type, c.exception.signal, c.exception.subtype].filter(Boolean).join(" ");
  return [
    h("p", {}, `${local(c.time)}: ${ex}; thread ${c.thread.index} "${c.thread.name}"; game ${c.version} (${c.build})`),
    h("p", { class: "mono" }, `signature ${c.signature ?? "none"}`),
    h("p", {}, r.repeats.count > 1 ? `Seen ${r.repeats.count} times.` : "First time this signature is seen."),
    pre(c.frames.map((f, i) => `${String(i).padStart(2)}  ${f.image.padEnd(28)} ${f.offset}${f.symbol ? `  ${f.symbol}` : ""}`)),
    r.warnings.map((w) => h("p", { class: "sev-warn" }, `Warning: ${w}`)),
    ...contextView(r.context),
    h("h3", {}, "Enabled mods (the next launch)"), h("p", { class: "mono" }, r.context.enabled.join(", ") || "none"),
    h("p", {}, h("strong", {}, "Next: "), r.next ? h("span", { class: "mono" }, r.next)
      : "no user mods are enabled, so the crash reproduces on the base game"),
  ];
}

async function triage() {
  els.crash.replaceChildren(muted("reading the crash report and logs..."));
  try {
    const r = await api(`/api/crash${els.crashes.value ? `?incident=${encodeURIComponent(els.crashes.value)}` : ""}`);
    els.crash.replaceChildren(...crashView(r).flat());
  } catch (e) { els.crash.replaceChildren(); toast(messageOf(e), true); }
}

async function loadCrashes() {
  try {
    const r = await api("/api/crash/list");
    if (!r.supported) { els.crash.replaceChildren(muted(r.note)); return; }
    els.crashes.replaceChildren(h("option", { value: "" }, "newest"),
      ...r.reports.map((c) => h("option", { value: c.incident ?? "" },
        `${local(c.time)}  ${c.thread.name}  seen ${c.repeats}x`)));
  } catch (e) { toast(messageOf(e), true); }
}

registerTab({
  id: "doctor",
  label: "Doctor",
  build: () => [
    h("div", { class: "card" }, h("h2", {}, "My mod does not work"),
      h("p", { class: "note" }, "Checks in order: which copy the game loads, pre-flight defects, whether the edit is live, "
        + "log lines about the mod, what the running game applied, conflicts. Stops at the first cause."),
      h("div", { class: "row" }, els.dir, h("label", {}, els.all, " every step"),
        h("label", {}, els.offline, " leave the game alone"), h("button", { class: "primary", onclick: runDoctor }, "Diagnose")),
      els.doctor),
    h("div", { class: "card" }, h("h2", {}, "Crash triage"),
      h("p", { class: "note" }, "Reads the crash report and the logs the run left, before any theory. "
        + "A crash isolates by switching mods on and off: the last line is the bisect command."),
      h("div", { class: "row" }, els.crashes, h("button", { class: "primary", onclick: triage }, "Triage")),
      els.crash),
  ],
  load: loadCrashes,
});
