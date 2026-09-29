import { $, h, api, toast, muted, isOpen, messageOf } from "./core.js";

/** @type {{ events: any[], paused: boolean, subs: string[] }} */
const bridgeUi = { events: [], paused: false, subs: [] };

function eventRow(e) {
  if (e.gap) return h("div", { class: "logline sev-warn" }, `--- ${e.gap} ---`);
  const names = e.names ? Object.entries(e.names).map(([k, v]) => `${k}=${v}`).join("  ") : "";
  return h("div", { class: "logline" },
    h("span", { class: "file" }, `${e.turn != null ? `turn ${e.turn}  ` : ""}${new Date(e.t).toLocaleTimeString()}  `),
    h("strong", {}, e.name), names ? `  ${names}` : "",
    e.data != null ? h("span", { class: "hint mono" }, JSON.stringify(e.data).slice(0, 400)) : null,
    e.via === "log" ? muted("  (from UI.log)") : null);
}

function paintEvents() {
  const q = $("ev-filter").value.toLowerCase();
  const vis = bridgeUi.events.filter((e) => !q || JSON.stringify(e).toLowerCase().includes(q)).slice(-500).reverse();
  $("ev-stream").replaceChildren(...(vis.length ? vis.map(eventRow)
    : [muted("No events yet. Listen for one, then play or end a turn.")]));
}

function agentNote(a) {
  if (!a) return "";
  if (!a.installed) {
    return "Events are read live over the debugger. Across a reload, anything between the old page and the "
      + "re-attach is missed; the agent (tower-bench agent install) closes that gap.";
  }
  return a.subscriptions?.length
    ? `The agent records ${a.subscriptions.join(", ")} from page load, through reloads, into UI.log.`
    : "The agent is installed but inert.";
}

function paintSubs(st) {
  bridgeUi.subs = st.subscriptions ?? [];
  const stop = (n) => setSubs(bridgeUi.subs.filter((x) => x !== n));
  $("ev-subs").replaceChildren(...bridgeUi.subs.map((n) => h("button", { title: "Stop listening", onclick: () => stop(n) }, `${n}  ×`)));
  $("ev-agent").textContent = agentNote(st.agent);
}

async function setSubs(names) {
  try { paintSubs(await api("/api/bridge/subscribe", { names, log: $("ev-log").checked })); } catch (e) { toast(messageOf(e), true); }
}

export async function loadBridge() {
  try {
    paintSubs(await api("/api/bridge/state"));
    if (!$("dl-events").children.length) {
      $("dl-events").replaceChildren(...(await api("/api/bridge/catalogue")).map((n) => h("option", { value: n })));
    }
    bridgeUi.events = await api("/api/bridge/recent?n=500");
    paintEvents();
  } catch (e) { toast(messageOf(e), true); }
}

function paintIfOpen() {
  if (!bridgeUi.paused && isOpen("events")) paintEvents();
}

export function onGameEvent(e) {
  bridgeUi.events.push(e);
  if (bridgeUi.events.length > 3000) bridgeUi.events.splice(0, 1000);
  paintIfOpen();
}

export function onEventGap(note) {
  bridgeUi.events.push({ gap: note, t: Date.now() });
  paintIfOpen();
}

$("ev-sub").addEventListener("click", () => {
  const n = $("ev-name").value.trim();
  if (n) setSubs([...new Set([...bridgeUi.subs, n])]);
  $("ev-name").value = "";
});
$("ev-name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("ev-sub").click(); });
$("ev-filter").addEventListener("input", paintEvents);
$("ev-pause").addEventListener("click", () => {
  bridgeUi.paused = !bridgeUi.paused;
  $("ev-pause").textContent = bridgeUi.paused ? "Resume" : "Pause";
  if (!bridgeUi.paused) paintEvents();
});
$("ev-clear").addEventListener("click", () => { bridgeUi.events = []; paintEvents(); });
