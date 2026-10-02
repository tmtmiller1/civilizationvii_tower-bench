import { TAB_REGISTRY, isOpen } from "./core.js";
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
import { loadTechniques, openTechnique } from "./techniques.js";
import "./registry.js";
import "./analysis.js";
import "./dbdiff.js";
import "./doctor.js";
import "./cheats.js";
import "./patch.js";
import "./cost.js";
import "./release.js";
import "./nightly.js";

const TAB_LOADERS = {
  mods: () => loadMods(),
  evidence: () => loadEvidence(),
  world: () => loadSnaps(),
  watches: () => loadWatches(),
  events: () => loadBridge(),
  map: () => drawMap(),
  techniques: () => loadTechniques(),
};

// Delegated, so tabs that feature modules add with registerTab switch like the built-in ones.
/** @type {HTMLElement} */ (document.querySelector("nav")).addEventListener("click", (e) => {
  const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest("button[data-tab]"));
  if (!b) return;
  const tab = b.dataset.tab ?? "";
  for (const o of document.querySelectorAll("nav button")) o.setAttribute("aria-selected", String(o === b));
  for (const s of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("main section"))) {
    s.hidden = s.id !== `tab-${tab}`;
  }
  (TAB_LOADERS[tab] ?? TAB_REGISTRY.get(tab))?.();
  try { localStorage.setItem("tb-tab", tab); } catch {}
});

const events = new EventSource("/api/events");
events.addEventListener("game-event", (e) => onGameEvent(JSON.parse(e.data)));
events.addEventListener("event-gap", (e) => onEventGap(JSON.parse(e.data).note));
events.addEventListener("sample", (e) => { if (isOpen("watches")) loadWatches(JSON.parse(e.data)); });
events.addEventListener("log", (e) => addLogs(JSON.parse(e.data)));
events.addEventListener("evidence", () => { if (isOpen("evidence")) loadEvidence(); });

// Restored last, once everything the tab handlers call is defined. A #technique/<id> link opens that entry.
const deepLink = location.hash.match(/^#technique\/([\w-]+)$/)?.[1];
if (deepLink) openTechnique(deepLink);
else try {
  const t = localStorage.getItem("tb-tab");
  if (t) /** @type {HTMLElement | null} */ (document.querySelector(`nav button[data-tab="${t}"]`))?.click();
} catch {}
refreshStatus();
setInterval(refreshStatus, 3000);
