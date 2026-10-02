import { h, api, toast, muted, messageOf, registerTab, state } from "./core.js";

// Game-state actions for testing. Each button sends one request through /api/do, which goes through the
// bench's verified write: refused while writes are disarmed, re-read until observed, logged as evidence.

/** @type {Record<string, HTMLInputElement | HTMLSelectElement>} */
const el = {};
/** @type {HTMLElement} */
let result;

const field = (id, attrs = {}) => {
  el[id] = /** @type {HTMLInputElement} */ (h("input", { id: `do-${id}`, ...attrs }));
  return el[id];
};
const num = (id) => Number(el[id].value);
const plotOrId = (v) => {
  const m = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/.exec(v);
  if (m) return { x: Number(m[1]), y: Number(m[2]) };
  return v.trim() === "" ? {} : { id: Number(v) };
};

// The target fields: the player every action names, and the unit or city it acts on.
const player = () => Number(el.player.value);
function unitArgs() {
  const t = plotOrId(el.unit.value);
  return "id" in t ? { player: player(), unit: t.id } : { player: player(), ...t };
}
function cityArgs() {
  const t = plotOrId(el.city.value);
  return "id" in t ? { player: player(), city: t.id } : { player: player(), ...t };
}
const plotArgs = () => ({ x: num("x"), y: num("y") });

/** @type {Record<string, () => { op: string, args: any }>} */
const REQUESTS = {
  gold: () => ({ op: "player.yield", args: { player: player(), yield: "YIELD_GOLD", amount: num("amount") } }),
  influence: () => ({ op: "player.yield", args: { player: player(), yield: "YIELD_DIPLOMACY", amount: num("amount") } }),
  happiness: () => ({ op: "player.yield", args: { player: player(), yield: "YIELD_HAPPINESS", amount: num("amount") } }),
  science: () => ({ op: "player.yield", args: { player: player(), yield: "YIELD_SCIENCE", amount: num("amount") } }),
  culture: () => ({ op: "player.yield", args: { player: player(), yield: "YIELD_CULTURE", amount: num("amount") } }),
  celebrate: () => ({ op: "player.celebrate", args: { player: player() } }),
  attribute: () => ({ op: "player.attribute", args: { player: player(), amount: num("amount") } }),
  heal: () => ({ op: "unit.heal", args: unitArgs() }),
  damage: () => ({ op: "unit.damage", args: { ...unitArgs(), amount: num("amount") } }),
  xp: () => ({ op: "unit.xp", args: { ...unitArgs(), amount: num("amount") } }),
  xpSet: () => ({ op: "unit.xp", args: { ...unitArgs(), to: num("amount") } }),
  moves: () => ({ op: "unit.moves", args: unitArgs() }),
  promote: () => ({ op: "unit.promote", args: { ...unitArgs(), promotion: el.promotion.value.trim(), discipline: el.discipline.value.trim() } }),
  move: () => ({ op: "unit.move", args: { player: player(), unit: num("unit"), toX: num("x"), toY: num("y") } }),
  kill: () => ({ op: "unit.kill", args: unitArgs() }),
  production: () => ({ op: "city.production", args: { ...cityArgs(), amount: num("amount") } }),
  complete: () => ({ op: "city.complete", args: cityArgs() }),
  grow: () => ({ op: "city.grow", args: cityArgs() }),
  tech: () => ({ op: "progress.complete", args: { player: player(), tree: "tech" } }),
  civic: () => ({ op: "progress.complete", args: { player: player(), tree: "civic" } }),
  unlock: () => ({ op: "progress.grant", args: { player: player(), tree: el.tree.value, node: el.node.value.trim() } }),
  revealPlot: () => ({ op: "map.reveal", args: { player: player(), ...plotArgs() } }),
  revealAll: () => ({ op: "map.reveal", args: { player: player() } }),
  own: () => ({ op: "map.owner", args: { player: player(), city: num("city"), ...plotArgs() } }),
};

/** @type {Map<string, HTMLButtonElement>} */
const buttons = new Map();

function actionButton(key, label) {
  const b = /** @type {HTMLButtonElement} */ (h("button", { "data-write": "", onclick: () => runAction(key, b) }, label));
  b.disabled = !state.armed;
  buttons.set(key, b);
  return b;
}

async function runAction(key, button) {
  button.disabled = true;
  try {
    showResult(await api("/api/do", REQUESTS[key]()));
  } catch (e) {
    toast(messageOf(e), true);
  } finally {
    button.disabled = !state.armed;
  }
}

function timingText(r) {
  if (r.verdict === "LANDED") return `landed in ${r.landedMs} ms`;
  return r.verdict === "NO EFFECT" ? `nothing changed in ${r.waitedMs} ms` : "";
}

const shown = (v) => JSON.stringify(v, null, 1)?.replace(/\n\s*/g, " ") ?? "none";

function undoNote(r) {
  if (!["LANDED", "UNEXPECTED"].includes(r.verdict)) return null;
  if (r.inverse) return h("p", { class: "note" }, "Undo (in the header) reverses this.");
  return h("p", { class: "note sev-warn" }, "Not undoable: Undo skips it and reverts the previous undoable write instead.");
}

function snippetKids(snippet) {
  const onclick = () => navigator.clipboard.writeText(snippet).then(() => toast("Copied."), () => toast("Copy failed.", true));
  return [h("div", { class: "row", style: "margin-top:6px" }, h("button", { onclick }, "Copy as mod code")),
    h("pre", { class: "snippet" }, snippet)];
}

function showResult(r) {
  const kids = [h("div", { class: "row" }, h("span", { class: `verdict v-${r.verdict.replace(/\s/g, "")}` }, r.verdict),
    h("span", {}, r.description ?? ""), muted(timingText(r)))];
  if (r.reason) kids.push(h("p", { class: "note" }, r.reason));
  if (r.sent) {
    kids.push(h("p", { class: "note mono" }, `before ${shown(r.before)}`), h("p", { class: "note mono" }, `after ${shown(r.after)}`));
  }
  const note = undoNote(r);
  if (note) kids.push(note);
  for (const hint of r.hints ?? []) kids.push(h("p", { class: "note" }, hint));
  if (r.snippet) kids.push(...snippetKids(r.snippet));
  result.replaceChildren(...kids);
}

const group = (title, ...rows) => h("div", { class: "card" }, h("h3", {}, title), ...rows);
const row = (...kids) => h("div", { class: "row", style: "margin-bottom:6px" }, ...kids);

function useSelected() {
  const s = state.status?.snapshot?.selectedUnit;
  if (!s) return toast("No unit is selected in game.", true);
  el.player.value = String(s.owner);
  el.unit.value = String(s.id);
  return toast(`Target: ${s.type} ${s.owner}:${s.id} at (${s.x}, ${s.y}).`);
}

function targetCard() {
  el.player = /** @type {HTMLSelectElement} */ (h("select", { id: "do-player" }));
  return group("Target",
    row(h("label", {}, "player ", el.player), h("label", {}, "amount ", field("amount", { class: "num", type: "number", value: "100" }))),
    row(h("label", {}, "unit ", field("unit", { placeholder: "id or x,y", style: "width:110px" })),
      h("button", { onclick: useSelected }, "Selected unit"),
      h("label", {}, "city ", field("city", { placeholder: "id or x,y", style: "width:110px" }))),
    row(h("label", {}, "plot x ", field("x", { class: "num", type: "number", value: "0" })),
      h("label", {}, "y ", field("y", { class: "num", type: "number", value: "0" }))),
    h("p", { class: "note" }, "Requests go out as the local player naming the target; an unknown player is refused "
      + "before anything is sent."));
}

function actionCards() {
  el.tree = /** @type {HTMLSelectElement} */ (h("select", {}, h("option", { value: "tech" }, "tech"), h("option", { value: "civic" }, "civic")));
  return [
    group("Player", row(actionButton("gold", "Gold"), actionButton("influence", "Influence"),
      actionButton("happiness", "Celebration meter"), actionButton("science", "Science"), actionButton("culture", "Culture")),
    row(actionButton("celebrate", "Fill celebration meter"), actionButton("attribute", "Attribute points")),
    h("p", { class: "note" }, "Each grants the amount. Food and Production have no player pool, so they are not offered.")),
    group("Units", row(actionButton("heal", "Heal"), actionButton("damage", "Damage"), actionButton("xp", "Add XP"),
      actionButton("xpSet", "Set XP"), actionButton("moves", "Restore moves"), actionButton("kill", "Kill")),
    row(actionButton("move", "Move to plot (recreates)"), field("promotion", { placeholder: "PROMOTION_...", class: "mono" }),
      field("discipline", { placeholder: "DISCIPLINE_...", class: "mono" }), actionButton("promote", "Promote"))),
    group("Cities", row(actionButton("production", "Add production"), actionButton("complete", "Complete production"),
      actionButton("grow", "Add population"))),
    group("Progress", row(actionButton("tech", "Complete current tech"), actionButton("civic", "Complete current civic")),
      row(el.tree, field("node", { placeholder: "NODE_TECH_...", class: "mono", style: "width:240px" }),
        actionButton("unlock", "Research it"))),
    group("Map", row(actionButton("revealPlot", "Reveal plot"), actionButton("revealAll", "Reveal whole map"),
      actionButton("own", "Give plot to city"))),
  ];
}

function build() {
  result = h("div", { class: "card", id: "do-result" }, muted("Arm writes, choose a target, then an action."));
  return [h("div", { class: "grid2" }, h("div", {}, targetCard(), ...actionCards()), result)];
}

function fillPlayers() {
  const g = state.status?.snapshot;
  if (!g) return;
  const keep = el.player.value;
  el.player.replaceChildren(...g.players.map((p) => h("option", { value: p.id },
    `${p.id} ${p.name}${p.id === g.localPlayer ? " (you)" : ""}`)));
  el.player.value = keep || String(g.localPlayer);
}

async function load() {
  fillPlayers();
  for (const b of buttons.values()) b.disabled = !state.armed || state.status?.scope !== "game";
  try {
    const { actions } = await api("/api/do/list");
    const undoFor = Object.fromEntries(actions.map((a) => [a.op, a.undo]));
    for (const [key, b] of buttons) b.title = `Undo: ${undoFor[REQUESTS[key]().op] ?? "unknown"}`;
  } catch (e) { toast(messageOf(e), true); }
}

registerTab({ id: "actions", label: "Actions", build, load });
