import { isOpen } from "./core.js";
import { refreshStatus } from "./status.js";
import { drawMap } from "./map-canvas.js";
import "./map.js";
import "./console.js";
import { loadMods } from "./mods.js";
import { addLogs } from "./logs.js";
import { loadEvidence } from "./evidence.js";
import { loadSnaps } from "./world.js";
import { loadWatches } from "./watches.js";
import "./deploy.js";
import "./lint.js";
import { loadBridge, onGameEvent, onEventGap } from "./events.js";

const TAB_LOADERS = {
  mods: () => loadMods(),
  evidence: () => loadEvidence(),
  world: () => loadSnaps(),
  watches: () => loadWatches(),
  events: () => loadBridge(),
  map: () => drawMap(),
};

/** @type {NodeListOf<HTMLElement>} */
const tabButtons = document.querySelectorAll("nav button");
for (const b of tabButtons) {
  b.addEventListener("click", () => {
    const tab = b.dataset.tab ?? "";
    for (const o of tabButtons) o.setAttribute("aria-selected", String(o === b));
    for (const s of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("main section"))) {
      s.hidden = s.id !== `tab-${tab}`;
    }
    TAB_LOADERS[tab]?.();
    try { localStorage.setItem("tb-tab", tab); } catch {}
  });
}

const events = new EventSource("/api/events");
events.addEventListener("game-event", (e) => onGameEvent(JSON.parse(e.data)));
events.addEventListener("event-gap", (e) => onEventGap(JSON.parse(e.data).note));
events.addEventListener("sample", (e) => { if (isOpen("watches")) loadWatches(JSON.parse(e.data)); });
events.addEventListener("log", (e) => addLogs(JSON.parse(e.data)));
events.addEventListener("evidence", () => { if (isOpen("evidence")) loadEvidence(); });

// Restored last, once everything the tab handlers call is defined.
try {
  const t = localStorage.getItem("tb-tab");
  if (t) /** @type {HTMLElement | null} */ (document.querySelector(`nav button[data-tab="${t}"]`))?.click();
} catch {}
refreshStatus();
setInterval(refreshStatus, 3000);
