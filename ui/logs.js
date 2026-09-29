import { $, state, h, api, muted } from "./core.js";

const RANK = { noise: 0, info: 1, warn: 2, error: 3 };

function logVisible(l) {
  const min = RANK[$("log-level").value];
  const mod = $("log-mod").value;
  const q = $("log-search").value.toLowerCase();
  return RANK[l.severity] >= min && (!mod || l.mod === mod) && (!q || l.text.toLowerCase().includes(q));
}

function logLine(l) {
  return h("div", { class: `logline sev-${l.severity}` },
    h("span", { class: "file" }, `${l.file}  `), l.text.trim(),
    l.hint ? h("span", { class: "hint" }, l.hint) : null);
}

export function addLogs(lines) {
  for (const l of lines) {
    state.logs.push(l);
    if (l.mod && !state.mods.has(l.mod)) {
      state.mods.add(l.mod);
      $("log-mod").append(h("option", { value: l.mod }, l.mod));
    }
  }
  if (state.logs.length > 4000) state.logs.splice(0, state.logs.length - 4000);
  if (!state.paused) paintLogs();
}

function paintLogs() {
  const vis = state.logs.filter(logVisible).slice(-600);
  $("logs").replaceChildren(...(vis.length ? vis.map(logLine) : [muted("No matching lines.")]));
  $("log-count").textContent = `${vis.length} shown of ${state.logs.length}`;
}

for (const id of ["log-level", "log-mod"]) $(id).addEventListener("change", paintLogs);
$("log-search").addEventListener("input", paintLogs);
$("log-pause").addEventListener("click", () => {
  state.paused = !state.paused;
  $("log-pause").textContent = state.paused ? "Resume" : "Pause";
  if (!state.paused) paintLogs();
});
$("log-clear").addEventListener("click", () => { state.logs = []; paintLogs(); });
api("/api/logs/recent").then(addLogs).catch(() => {});
