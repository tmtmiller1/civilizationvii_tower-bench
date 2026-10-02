/** @type {(id: string) => any} */
export const $ = (id) => document.getElementById(id);

/** @type {{ status: any, catalogs: any, armed: boolean, logs: any[], paused: boolean, mods: Set<string>,
 *   history: { lang: string, code: string }[], sel?: { x: number, y: number } }} */
export const state = {
  status: null, catalogs: null, armed: false, logs: [], paused: false, mods: new Set(), history: [],
};

function setAttr(el, k, v) {
  if (k === "class") el.className = v;
  else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
  else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
}

/** @returns {HTMLElement} */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) setAttr(el, k, v);
  // Fully flattened: a list of [separator, link] pairs is a common child.
  for (const kid of kids.flat(Infinity)) {
    if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

export async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Tower-Bench": "1" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

// Registry changes need writes armed and the game closed: it reads the mod list only at launch.
export const registryLocked = () => !state.armed || (state.status?.scope ?? "offline") !== "offline";

export const messageOf = (e) => (e instanceof Error ? e.message : String(e));

let toastTimer;
export function toast(msg, isError) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

export const muted = (text) => h("span", { class: "muted" }, text);
export const errorSpan = (text) => h("span", { class: "error" }, text);

export const headRow = (cols) => h("thead", {}, h("tr", {}, cols.map((c) => h("th", {}, c))));

export function isOpen(tab) {
  return !$(`tab-${tab}`).hidden;
}

/** @type {Map<string, (() => unknown) | undefined>} loaders of tabs that feature modules add themselves */
export const TAB_REGISTRY = new Map();

/**
 * Adds a tab from a feature module, so a new view needs no edit to index.html: a nav button before
 * Evidence, and a section built once by `build`. `load` runs each time the tab is opened.
 * @param {{ id: string, label: string, build: () => HTMLElement | HTMLElement[], load?: () => unknown }} tab
 */
export function registerTab({ id, label, build, load }) {
  const nav = /** @type {HTMLElement} */ (document.querySelector("nav"));
  const button = h("button", { role: "tab", "data-tab": id }, label);
  nav.insertBefore(button, nav.querySelector('button[data-tab="evidence"]'));
  const section = h("section", { id: `tab-${id}`, hidden: true }, build());
  /** @type {HTMLElement} */ (document.querySelector("main")).append(section);
  TAB_REGISTRY.set(id, load);
}
