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
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
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
