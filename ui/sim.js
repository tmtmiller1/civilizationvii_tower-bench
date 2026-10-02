import { h, api, toast, muted, headRow, messageOf, registerTab, state } from "./core.js";

// Series colours, in a fixed order (validated for the dark surface); text stays in the page's ink.
const HUES = ["#3987e5", "#d95926", "#199e70", "#c98500"];
const SVG = "http://www.w3.org/2000/svg";
const W = 640;
const H = 220;
const PAD = { l: 44, r: 90, t: 12, b: 28 };

/** @type {Record<string, HTMLInputElement | HTMLSelectElement>} */
const el = {};
/** @type {HTMLElement} */ let view;
/** @type {HTMLElement} */ let runs;
/** @type {HTMLElement} */ let jobBox;
/** @type {ReturnType<typeof setTimeout> | undefined} */ let jobTimer;

function s(tag, attrs, ...kids) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) e.setAttribute(k, String(v));
  for (const k of kids) e.append(k);
  return e;
}

const fmt = (v) => (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "-");

function scales(series) {
  const pts = series.flatMap((x) => x.points);
  const xs = pts.map((p) => p.x);
  const ys = pts.flatMap((p) => [p.y, p.lo ?? p.y, p.hi ?? p.y]).filter(Number.isFinite);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs, Math.min(...xs) + 1)];
  const [y0, y1] = [Math.min(0, ...ys), Math.max(1, ...ys)];
  return {
    x: (v) => PAD.l + ((v - x0) / (x1 - x0)) * (W - PAD.l - PAD.r),
    y: (v) => H - PAD.b - ((v - y0) / (y1 - y0)) * (H - PAD.t - PAD.b),
    x0, x1, y0, y1,
  };
}

function axes(sc, xLabel) {
  const ink = "var(--muted)";
  const g = s("g", {});
  for (const v of [sc.y0, (sc.y0 + sc.y1) / 2, sc.y1]) {
    g.append(s("line", { x1: PAD.l, x2: W - PAD.r, y1: sc.y(v), y2: sc.y(v), stroke: "var(--line)", "stroke-width": 1 }));
    g.append(s("text", { x: PAD.l - 6, y: sc.y(v) + 4, "text-anchor": "end", fill: ink, "font-size": 11 }, fmt(v)));
  }
  for (const v of [sc.x0, sc.x1]) {
    g.append(s("text", { x: sc.x(v), y: H - 10, "text-anchor": "middle", fill: ink, "font-size": 11 }, String(v)));
  }
  g.append(s("text", { x: (PAD.l + W - PAD.r) / 2, y: H - 2, "text-anchor": "middle", fill: ink, "font-size": 11 }, xLabel));
  return g;
}

function seriesMarks(sc, x, color) {
  const g = s("g", {});
  const band = x.points.filter((p) => Number.isFinite(p.lo) && Number.isFinite(p.hi));
  if (band.length > 1) {
    const d = [...band.map((p) => `${sc.x(p.x)},${sc.y(p.hi)}`), ...band.reverse().map((p) => `${sc.x(p.x)},${sc.y(p.lo)}`)];
    g.append(s("polygon", { points: d.join(" "), fill: color, opacity: 0.18 }));
  }
  const line = x.points.filter((p) => Number.isFinite(p.y)).map((p) => `${sc.x(p.x)},${sc.y(p.y)}`).join(" ");
  g.append(s("polyline", { points: line, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round" }));
  // Hover: hit targets larger than the line, each with its own tooltip.
  for (const p of x.points.filter((q) => Number.isFinite(q.y))) {
    const tip = `${x.name}, turn ${p.x}: ${fmt(p.y)}${Number.isFinite(p.lo) ? ` [${fmt(p.lo)}, ${fmt(p.hi)}]` : ""}`;
    g.append(s("circle", { cx: sc.x(p.x), cy: sc.y(p.y), r: 6, fill: "transparent" }, s("title", {}, tip)));
  }
  const last = x.points.filter((p) => Number.isFinite(p.y)).at(-1);
  if (last) g.append(s("text", { x: sc.x(last.x) + 6, y: sc.y(last.y) + 4, fill: "var(--ink)", "font-size": 11 }, x.name));
  return g;
}

/** A line chart, one series per entry, with optional interval bands; a legend row above it. */
function lineChart(series, xLabel) {
  const live = series.filter((x) => x.points.length);
  if (!live.length) return muted("No turns to draw.");
  const sc = scales(live);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img", style: "max-width:720px" }, axes(sc, xLabel));
  live.forEach((x, i) => svg.append(seriesMarks(sc, x, HUES[i % HUES.length])));
  const legend = h("div", { class: "row" }, live.map((x, i) => h("span", { class: "muted" },
    h("span", { style: `display:inline-block;width:12px;height:3px;margin-right:4px;vertical-align:middle;background:${HUES[i]}` }),
    x.name)));
  return h("div", {}, legend, svg);
}

function curveChart(curve) {
  const keys = [["plots", "plots"], ["units", "units"], ["cities", "settlements"], ["numbers", "figures"]];
  const points = (k) => curve.filter((c) => c[k] != null).map((c) => ({ x: c.turn, y: c[k] }));
  return lineChart(keys.map(([k, name]) => ({ name, points: points(k) })), "turn");
}

function curveTable(curve) {
  return h("details", {}, h("summary", {}, "as a table"), h("table", {}, headRow(["Turn", "Plots", "Units", "Settlements", "Figures"]),
    h("tbody", {}, curve.map((c) => h("tr", {}, [c.turn, c.plots, c.units, c.cities, c.numbers]
      .map((v) => h("td", { class: "num" }, v ?? "-")))))));
}

function showSim(r) {
  const control = r.control ? `control: ${r.control.verdict} through turn ${r.control.lastTurn} (${r.control.source})` : null;
  view.replaceChildren(
    h("h3", {}, `${r.mod ? `${r.mod}: ` : ""}${r.verdict}`),
    h("p", {}, r.detail), ...(control ? [h("p", { class: "note" }, control)] : []),
    ...(r.first ? [h("div", { class: "card" }, h("h3", {}, `First difference, turn ${r.first.turn}`),
      r.first.lines.map((l) => h("div", { class: "mono" }, l)))] : []),
    h("h3", {}, "Divergence per turn"), curveChart(r.curve ?? []), curveTable(r.curve ?? []));
}

function showFuzz(r) {
  const rows = (r.runs ?? []).map((x) => h("tr", {}, h("td", {}, x.run), h("td", { class: "num" }, x.steps.length),
    h("td", {}, x.failure ? `step ${x.failure.step}: ${x.failure.detail}` : x.error ?? "invariants held")));
  const recipe = r.recipes?.minimal ?? r.recipes?.failing;
  view.replaceChildren(h("h3", {}, `fuzz: ${r.verdict}`),
    h("p", { class: "note" }, `${r.budget.used} of ${r.budget.max} game(s); determinism: ${r.determinism.verdict}`),
    ...(r.shrink ? [h("p", {}, `${r.shrink.status}: ${r.shrink.detail ?? ""}`)] : []),
    ...(recipe ? [h("p", { class: "mono" }, `tower-bench lab run ${recipe}`)] : []),
    h("table", {}, headRow(["Run", "Steps", "Outcome"]), h("tbody", {}, rows)));
}

function effectsTable(effects) {
  return h("table", {}, headRow(["Figure", "On minus off", "95% interval", "Seeds", ""]), h("tbody", {},
    Object.entries(effects).map(([m, e]) => h("tr", {}, h("td", {}, m), h("td", { class: "num" }, fmt(e.est)),
      h("td", { class: "num" }, `[${fmt(e.lo)}, ${fmt(e.hi)}]`), h("td", { class: "num" }, e.pairs),
      h("td", {}, e.significant ? "real" : muted("inside the noise"))))));
}

function arenaCurve(r, metric) {
  const pts = (arm) => (r.arms[arm].curves[metric] ?? []).map((c) => ({ x: c.turn, y: c.est, lo: c.lo, hi: c.hi }));
  return lineChart([{ name: "mod off", points: pts("off") }, { name: "mod on", points: pts("on") }], "turn");
}

function leadTable(arm, rows) {
  return h("div", { class: "card" }, h("h3", {}, `Led at the end, mod ${arm}`), rows.length ? h("table", {},
    headRow(["Leader", "Led", "Games", "Rate", "95% interval"]), h("tbody", {}, rows.slice(0, 10).map((x) => h("tr", {},
      h("td", {}, x.key), h("td", { class: "num" }, x.leads), h("td", { class: "num" }, x.games),
      h("td", { class: "num" }, fmt(x.rate)), h("td", { class: "num" }, `[${fmt(x.lo)}, ${fmt(x.hi)}]`))))) : muted("none"));
}

function showArena(r) {
  const chart = h("div", {});
  const pick = /** @type {HTMLSelectElement} */ (h("select", { onchange: () => chart.replaceChildren(arenaCurve(r, pick.value)) },
    Object.keys(r.effects).map((m) => h("option", { value: m }, m))));
  chart.replaceChildren(arenaCurve(r, pick.value));
  view.replaceChildren(h("h3", {}, `${r.mod}: ${r.seeds.length} seed(s) x ${r.turns} turn(s)`),
    h("p", { class: "note" }, r.caveat),
    h("p", { class: "note" }, `Determinism controls: ${r.determinism.deterministic} of ${r.determinism.seeds} seed(s).`),
    h("h3", {}, "Effect at the last turn (mean over AI majors)"), effectsTable(r.effects),
    h("div", { class: "row" }, h("h3", {}, "Mean per turn, 95% bootstrap band"), pick), chart,
    h("div", { class: "grid2" }, leadTable("off", r.arms.off.leadByLeader), leadTable("on", r.arms.on.leadByLeader)));
}

const SHOW = { "sim-diff": showSim, "sim-repeat": showSim, fuzz: showFuzz, arena: showArena };

async function openRun(name) {
  try {
    const r = await api(`/api/sim/run?name=${encodeURIComponent(name)}`);
    (SHOW[r.kind] ?? showSim)(r);
  } catch (e) { toast(messageOf(e), true); }
}

async function loadRuns() {
  try {
    const list = await api("/api/sim/runs");
    runs.replaceChildren(...(list.length ? list.map((r) => h("div", {},
      h("button", { onclick: () => openRun(r.name) }, r.name), ` ${r.mod ?? ""} `, muted(r.verdict ?? "")))
      : [muted("No sim, fuzz or arena runs yet.")]));
  } catch (e) { toast(messageOf(e), true); }
  pollJob();
}

async function pollJob() {
  clearTimeout(jobTimer);
  let j = null;
  try { j = await api("/api/sim/job"); } catch { /* the server is gone; nothing to show */ }
  if (!j) { jobBox.replaceChildren(); return; }
  const head = j.done ? `${j.kind} finished${j.error ? `: ${j.error}` : ""}` : `${j.kind} running since ${j.startedAt}`;
  jobBox.replaceChildren(h("div", { class: "card" }, h("h3", {}, head),
    j.report ? h("button", { onclick: () => openRun(j.report) }, `open ${j.report}`) : null,
    h("pre", { class: "out" }, j.lines.slice(-12).join("\n"))));
  if (!j.done) jobTimer = setTimeout(pollJob, 3000);
}

const input = (id, attrs) => {
  el[id] = /** @type {HTMLInputElement} */ (h("input", { id: `sim-${id}`, ...attrs }));
  return el[id];
};

async function start() {
  if (!state.armed) { toast("Arm writes first: runs start test games and switch the registry.", true); return; }
  const v = (k) => el[k].value.trim() || undefined;
  const body = { kind: el.kind.value, mod: v("mod"), seed: v("seed"), turns: v("turns"), age: v("age"), runs: v("runs"),
    steps: v("steps"), games: v("games"), seeds: v("seeds"), control: /** @type {HTMLInputElement} */ (el.control).checked };
  try {
    await api("/api/sim/start", body);
    toast(`${body.kind} started; each game is restored afterwards`);
    pollJob();
  } catch (e) { toast(messageOf(e), true); }
}

function form() {
  el.kind = /** @type {HTMLSelectElement} */ (h("select", {}, ["diff", "repeat", "fuzz", "arena"].map((k) => h("option", { value: k }, k))));
  el.control = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox" }));
  return [
    h("div", { class: "row" }, el.kind, input("mod", { placeholder: "mod id (diff, arena)", style: "width:200px" }),
      input("seed", { placeholder: "seed (4242)", style: "width:100px" }), input("turns", { placeholder: "turns", style: "width:80px" }),
      input("age", { placeholder: "AGE_ANTIQUITY", style: "width:140px" })),
    h("div", { class: "row" }, input("runs", { placeholder: "fuzz runs (20)", style: "width:120px" }),
      input("steps", { placeholder: "fuzz steps (15)", style: "width:120px" }),
      input("games", { placeholder: "arena games (10)", style: "width:130px" }),
      input("seeds", { placeholder: "arena seeds a..b", style: "width:130px" }),
      h("label", {}, el.control, " run a determinism control first (diff)"),
      h("button", { class: "primary", onclick: start }, "Start")),
  ];
}

function build() {
  view = h("div", {}, muted("Open a run to see its report."));
  runs = h("div", {}, muted("..."));
  jobBox = h("div", {});
  return [
    h("p", { class: "note" }, "Seeded test games compared turn by turn. diff runs one seed with a mod off and on and finds "
      + "the first turn they differ; repeat runs one seed twice, the determinism control a diff needs before it blames "
      + "the mod. fuzz applies random verified actions and shrinks a failure to a minimal recipe. arena plays many seeds "
      + "off and on and estimates the mod's effect. Starting a run needs writes armed; your saves, settings and registry "
      + "are restored after every game."),
    ...form(), jobBox,
    h("div", { class: "grid2" }, h("div", {}, h("h3", {}, "Saved runs"), runs), view),
  ];
}

registerTab({ id: "simulate", label: "Simulate", build, load: loadRuns });
