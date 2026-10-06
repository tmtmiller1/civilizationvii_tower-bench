// Everything exported here runs INSIDE the game's UI context. CdpSession.call serialises each
// function with toString(), so each one must be self-contained: no imports and no outer references.

export function snapshot() {
  /** @type {(f: () => any, d?: any) => any} */
  const safe = (f, d = null) => { try { return f(); } catch { return d; } };
  const players = safe(() => Players.getAliveIds(), []).map((id) => {
    const p = Players.get(id);
    return {
      id,
      name: safe(() => Locale.compose(p.name), String(id)),
      civ: safe(() => Locale.compose(p.civilizationFullName), ""),
      major: !!safe(() => p.isMajor),
      independent: !!safe(() => p.isIndependent),
      human: !!safe(() => p.isHuman),
    };
  });
  const sel = safe(() => UI.Player.getHeadSelectedUnit());
  const unit = sel ? safe(() => Units.get(sel)) : null;
  // An anchor for unattended runs, where nobody selects a unit.
  const ownIds = safe(() => Players.get(GameContext.localPlayerID).Units.getUnitIds(), []) || [];
  const own = ownIds.length ? safe(() => Units.get(ownIds[0])) : null;
  return {
    firstUnit: own ? {
      type: safe(() => GameInfo.Units.lookup(own.type)?.UnitType),
      x: own.location.x,
      y: own.location.y,
    } : null,
    turn: safe(() => Game.turn),
    age: safe(() => GameInfo.Ages.lookup(Game.age)?.AgeType),
    localPlayer: safe(() => GameContext.localPlayerID),
    map: { width: safe(() => GameplayMap.getGridWidth()), height: safe(() => GameplayMap.getGridHeight()) },
    players,
    selectedUnit: unit ? {
      owner: sel.owner,
      id: sel.id,
      type: safe(() => GameInfo.Units.lookup(unit.type)?.UnitType),
      x: unit.location.x,
      y: unit.location.y,
    } : null,
  };
}

// The flags the game's own UI reads to tell a multiplayer game (network or hotseat) from a single-player one.
export function multiplayerFlags() {
  const g = Configuration.getGame();
  return { any: g.isAnyMultiplayer, network: g.isNetworkMultiplayer, hotseat: g.isHotseat };
}

export async function cursorPlot() {
  // Held in a variable so the type checker does not try to resolve a module that exists only in the game.
  const specifier = "fs://game/core/ui/input/plot-cursor.js";
  try {
    const m = await import(specifier);
    const c = m.PlotCursor?.plotCursorCoords;
    return c ? { x: c.x, y: c.y } : null;
  } catch {
    return null;
  }
}

export function catalogs() {
  const rows = (table, key) => {
    const out = [];
    for (const r of GameInfo[table]) {
      let name = r[key];
      try { if (r.Name) name = Locale.compose(r.Name); } catch { /* keep the type name */ }
      out.push({ type: r[key], name });
    }
    return out;
  };
  return {
    units: rows("Units", "UnitType"),
    terrains: rows("Terrains", "TerrainType"),
    features: rows("Features", "FeatureType"),
    resources: rows("Resources", "ResourceType"),
  };
}

export function plotInfo({ x, y }) {
  /** @type {(f: () => any, d?: any) => any} */
  const safe = (f, d = null) => { try { return f(); } catch { return d; } };
  const type = (table, key, v) => safe(() => GameInfo[table].lookup(v)?.[key] ?? null);
  if (!safe(() => GameplayMap.isValidLocation({ x, y }), false)) return { valid: false, x, y };
  // MapCities.getCity names the city that owns the plot; only its centre plot holds the settlement.
  const owning = safe(() => MapCities.getCity(x, y));
  const isCentre = () => {
    const owningCity = owning ? safe(() => Cities.get(owning)) : null;
    return owningCity && owningCity.location?.x === x && owningCity.location?.y === y;
  };
  const atCentre = isCentre();
  const describe = (c) => ({ owner: c.owner, id: c.id, name: safe(() => Locale.compose(Cities.get(c).name)) });
  const unitsHere = () => (safe(() => MapUnits.getUnits(x, y), []) || []).map((id) => ({
    owner: id.owner,
    id: id.id,
    type: type("Units", "UnitType", safe(() => Units.get(id)?.type)),
  }));
  return {
    valid: true,
    x,
    y,
    terrain: type("Terrains", "TerrainType", safe(() => GameplayMap.getTerrainType(x, y))),
    feature: type("Features", "FeatureType", safe(() => GameplayMap.getFeatureType(x, y))),
    resource: type("Resources", "ResourceType", safe(() => GameplayMap.getResourceType(x, y))),
    biome: type("Biomes", "BiomeType", safe(() => GameplayMap.getBiomeType(x, y))),
    owner: safe(() => GameplayMap.getOwner(x, y)),
    city: atCentre ? describe(owning) : null,
    owningCity: owning && !atCentre ? describe(owning) : null,
    units: unitsHere(),
  };
}

export function runSql({ sql, limit }) {
  const rows = Database.query("gameplay", sql) ?? [];
  const out = [];
  for (let i = 0; i < rows.length && i < limit; i++) {
    const row = {};
    for (const [k, v] of Object.entries(rows[i])) if (k !== "$index") row[k] = v;
    out.push(row);
  }
  return { rows: out, total: rows.length, truncated: rows.length > limit };
}

// Evaluates console input. Engine objects serialise to {} through JSON, which hides the API, so
// objects are described instead: their own values plus the method names on their prototype chain.
export async function consoleEval({ code, depth }) {
  const seen = new Set();
  const SCALARS = {
    number: (v) => v, string: (v) => v, boolean: (v) => v, bigint: (v) => `${v}n`, symbol: (v) => String(v),
    function: (v) => `[function ${v.name || "anonymous"}]`,
  };
  const describe = (v, d) => {
    if (v === null || v === undefined) return null;
    const scalar = SCALARS[typeof v];
    if (scalar) return scalar(v);
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v)) return describeArray(v, d);
    return d <= 0 ? "[object]" : describeObject(v, d);
  };
  const describeArray = (v, d) => {
    if (d <= 0) return `[array(${v.length})]`;
    const a = v.slice(0, 200).map((x) => describe(x, d - 1));
    if (v.length > 200) a.push(`... ${v.length - 200} more`);
    return a;
  };
  const put = (out, v, k, d) => { try { out[k] = describe(v[k], d - 1); } catch (e) { out[k] = `[throws ${e}]`; } };
  // Methods are listed by name; getters are read, since engine objects expose most state through them.
  const walkPrototypes = (v, d, out) => {
    const methods = new Set();
    for (let p = Object.getPrototypeOf(v); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const k of Object.getOwnPropertyNames(p)) {
        if (k === "constructor") continue;
        const desc = Object.getOwnPropertyDescriptor(p, k);
        if (desc && typeof desc.value === "function") methods.add(`${k}()`);
        else if (desc && desc.get) put(out, v, k, d);
      }
    }
    return methods;
  };
  const describeObject = (v, d) => {
    const out = {};
    for (const k of Object.keys(v).slice(0, 200)) put(out, v, k, d);
    const methods = walkPrototypes(v, d, out);
    if (methods.size) out["__methods"] = [...methods].sort();
    return out;
  };
  let value;
  try {
    value = await (0, eval)(`(async () => (${code}))()`);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    value = await (0, eval)(`(async () => { ${code} })()`);
  }
  return describe(value, depth);
}

// The whole map in one call, compact: per-plot type indexes with name tables, plus units, cities and
// per-player totals. Two snapshots diff into "what changed" (lib/world.mjs).
export function worldSnapshot() {
  /** @type {(f: () => any, d?: any) => any} */
  const safe = (f, d = null) => { try { return f(); } catch { return d; } };
  const [w, h] = [GameplayMap.getGridWidth(), GameplayMap.getGridHeight()];
  const names = (table, key) => {
    const out = [];
    for (const r of GameInfo[table]) out[r.$index] = r[key];
    return out;
  };
  const [t, f, r, o] = [0, 1, 2, 3].map(() => new Array(w * h));
  const units = [];
  const cities = [];
  const addUnits = (i, x, y) => {
    for (const id of safe(() => MapUnits.getUnits(x, y), []) || []) {
      const u = safe(() => Units.get(id));
      units.push({ i, owner: id.owner, id: id.id, type: safe(() => GameInfo.Units.lookup(u.type)?.UnitType) });
    }
  };
  // MapCities.getCity answers for every plot a city owns, not only its centre (watched 2026-09-26).
  const addCity = (i, x, y) => {
    const c = safe(() => MapCities.getCity(x, y));
    const city = c ? safe(() => Cities.get(c)) : null;
    if (!city || city.location?.x !== x || city.location?.y !== y) return;
    const name = safe(() => Locale.compose(city.name));
    const pop = safe(() => city.population);
    cities.push({ i, owner: c.owner, id: c.id, name, pop, town: !!safe(() => city.isTown) });
  };
  const readPlot = (i, x, y) => {
    t[i] = safe(() => GameplayMap.getTerrainType(x, y), -1);
    f[i] = safe(() => GameplayMap.getFeatureType(x, y), -1);
    r[i] = safe(() => GameplayMap.getResourceType(x, y), -1);
    o[i] = safe(() => GameplayMap.getOwner(x, y), -1);
    addUnits(i, x, y);
    addCity(i, x, y);
  };
  for (let i = 0; i < w * h; i++) readPlot(i, i % w, Math.floor(i / w));
  // Which way rows shift and which way "north" runs, read from the engine rather than assumed.
  const northeast = (y) => GameplayMap.getAdjacentPlotLocation({ x: 4, y }, DirectionTypes.DIRECTION_NORTHEAST);
  const neEven = safe(() => northeast(4));
  const neOdd = safe(() => northeast(5));
  const players = safe(() => Players.getAliveIds(), []).map((id) => {
    const p = Players.get(id);
    const gold = safe(() => Math.round(p.Treasury.goldBalance));
    return { id, name: safe(() => Locale.compose(p.name), String(id)), major: !!safe(() => p.isMajor), gold };
  });
  return {
    turn: safe(() => Game.turn),
    w, h,
    layout: neEven && neOdd ? { oddRowShift: neOdd.x - 4 === 1, northDy: neEven.y - 4 } : null,
    t, f, r, o, units, cities, players,
    names: { terrains: names("Terrains", "TerrainType"), features: names("Features", "FeatureType"), resources: names("Resources", "ResourceType") },
  };
}

// Evaluates named watch expressions and invariants in one round trip. An invariant passes when it
// returns true; anything else (false, a string, a thrown error) is a violation and is reported as-is.
export async function sampleWatches({ watches, invariants }) {
  const run = async (expr) => {
    try { return { value: await (0, eval)(`(async () => (${expr}))()`) }; } catch (e) { return { error: String(e) }; }
  };
  const out = { turn: (() => { try { return Game.turn; } catch { return null; } })(), watches: {}, invariants: {} };
  for (const w of watches) {
    const r = await run(w.expr);
    out.watches[w.name] = r.error ? { error: r.error } : { value: JSON.parse(JSON.stringify(r.value ?? null)) };
  }
  for (const v of invariants) {
    const r = await run(v.expr);
    out.invariants[v.name] = r.error
      ? { ok: false, detail: `threw ${r.error}` }
      : { ok: r.value === true, detail: r.value === true ? null : JSON.stringify(r.value) };
  }
  return out;
}

// Lints the live UI for GameFace failures that have broken real mods, as GameFace actually reports them
// (watched 2026-09-26): italic text lays out at zero height, an unset border colour reads "initial", and an
// unknown data-l10n-id tag is shown raw. CSS grid is not checked here: GameFace strips display:grid from the
// style and computes "block", so only the UI.log signature ("near text: 1fr") can catch it.
export function lintUi({ scope, max }) {
  const root = scope ? document.querySelector(scope) : document.body;
  if (!root) return { error: `no element matches ${scope}` };
  const LOC = /\b(?:LOC_[A-Z0-9_]+|[A-Z][A-Z0-9]{1,}(?:_[A-Z0-9]+)+)\b/;
  const issues = [];
  let visited = 0;
  const classes = (e) => (typeof e.className === "string" && e.className.trim()
    ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
  const pathOf = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
      parts.unshift(e.tagName.toLowerCase() + (e.id ? `#${e.id}` : "") + classes(e));
    }
    return parts.join(" > ");
  };
  const add = (rule, el, detail) => { if (issues.length < 400) issues.push({ rule, path: pathOf(el), detail }); };
  const ownText = (el) => [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join(" ").trim();
  const checkStyle = (el, cs, rect, text) => {
    // Not gated on being visible: collapsing to nothing is the symptom.
    if (text && cs.fontStyle === "italic") {
      add("italic", el, `italic text renders blank in GameFace (this element measures ${Math.round(rect.width)}x${Math.round(rect.height)}); slant it with transform: skewX instead`);
    }
    const bw = parseFloat(cs.borderTopWidth) || 0;
    if (bw > 0 && cs.borderTopStyle !== "none" && /^(initial|currentcolor)$/i.test(cs.borderTopColor)) {
      add("border-color", el, "the border colour never resolved (it reads \"" + cs.borderTopColor + "\"): a border-color shorthand, or one set through a variable, was dropped; set the four border-*-color longhands");
    }
    if (bw > 0 && bw < 1) add("subpixel-border", el, `border width ${bw}px can drop an edge under transform: scale`);
  };
  const checkText = (el, cs, rect, text) => {
    const shown = rect.width > 0 && rect.height > 0 && cs.opacity !== "0";
    const m = shown && text ? text.match(LOC) : null;
    if (!m) return;
    const tag = el.getAttribute("data-l10n-id");
    add("unresolved-text", el, tag && text.includes(tag)
      ? `data-l10n-id="${tag}" did not resolve, so the engine shows the tag itself`
      : `visible text shows ${m[0]}; a LOC tag or engine type name reached the screen`);
  };
  const walk = (el) => {
    if (visited++ > max) return;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const rect = el.getBoundingClientRect();
    const text = ownText(el);
    checkStyle(el, cs, rect, text);
    checkText(el, cs, rect, text);
    for (const c of el.children) walk(c);
  };
  walk(root);
  return { visited, truncated: visited > max, issues };
}

/**
 * @param {{ op?: string, names?: string[], since?: number, expect?: string | null, log?: boolean,
 *   capacity?: number, pin?: boolean }} [options]
 */
export function bridge({ op = "info", names, since = 0, expect = null, log, capacity = 5000, pin = false } = {}) {
  const g = globalThis;
  /** @type {(f: () => any, d?: any) => any} */
  const safe = (f, d = null) => { try { return f(); } catch { return d; } };
  // Payload ids made readable: a city's name, a unit's type, a player's name. Player ids are
  // resolved through Players.get only, since a bad id into other engine calls can crash the game.
  const readable = (key, v) => {
    if (v && typeof v === "object" && "owner" in v && "id" in v) {
      if (/city/i.test(key)) return safe(() => Locale.compose(Cities.get(v).name));
      if (/unit/i.test(key)) return safe(() => GameInfo.Units.lookup(Units.get(v).type)?.UnitType);
      return null;
    }
    if (Number.isInteger(v) && v >= 0 && /player|owner/i.test(key)) {
      return safe(() => { const p = Players.get(v); return p ? Locale.compose(p.name) : null; });
    }
    return null;
  };
  const namesIn = (payload) => {
    const named = {};
    if (payload && typeof payload === "object") {
      for (const [k, v] of Object.entries(payload)) { const r = readable(k, v); if (r) named[k] = r; }
    }
    return Object.keys(named).length ? { names: named } : {};
  };
  const create = () => {
    const b = {
      id: Math.random().toString(36).slice(2, 10),
      loadedAt: Date.now(),
      seq: 0,
      buf: /** @type {{ seq: number }[]} */ ([]),
      subs: new Map(),
      pinned: new Set(),
      capacity,
      log: !!log,
      agent: false,
      push(name, payload) {
        let data;
        try { data = JSON.parse(JSON.stringify(payload ?? null)); } catch { data = String(payload); }
        const named = namesIn(payload);
        const e = { bid: b.id, seq: ++b.seq, t: Date.now(), turn: safe(() => Game.turn), name, data, ...named };
        b.buf.push(e);
        if (b.buf.length > b.capacity) b.buf.splice(0, b.buf.length - b.capacity);
        // UI.log clips lines near 1,000 characters; the bench recovers bid/seq/name from a clipped line.
        if (b.log) { try { console.error(`[TB-EVENT] ${JSON.stringify(e).slice(0, 990)}`); } catch { /* keep going */ } }
      },
      sync(list) {
        // The agent's own list is pinned: a live session can add to it but never remove it.
        const want = new Set([...list, ...b.pinned]);
        for (const [n, h] of b.subs) {
          if (want.has(n)) continue;
          try { engine.off(n, h); } catch { /* already gone */ }
          b.subs.delete(n);
        }
        for (const n of want) {
          if (b.subs.has(n)) continue;
          const h = (p) => b.push(n, p);
          try { engine.on(n, h); b.subs.set(n, h); } catch { /* unknown event name */ }
        }
      },
      info() {
        const subs = [...b.subs.keys()];
        return { id: b.id, seq: b.seq, loadedAt: b.loadedAt, subs, pinned: [...b.pinned], log: b.log, agent: b.agent };
      },
    };
    g.__towerBenchBridge = b;
    // The page is about to go (reload, age transition, quit). Say so where it outlives the page.
    try { engine.on("BeforeUnload", () => { try { console.error(`[TB-BRIDGE] ${b.id} unload seq=${b.seq}`); } catch { /* page closing */ } }); } catch { /* no engine */ }
  };
  const configure = (b) => {
    if (pin) {
      b.agent = true;
      b.log = true;
      b.pinned = new Set(names ?? []);
    } else if (log !== undefined && !b.agent) {
      b.log = !!log; // the agent always logs, so its record survives the page
    }
  };
  const drain = (b) => {
    // A different page id means the page was replaced: everything this page recorded is new.
    const from = expect && expect === b.id ? since : 0;
    const first = b.buf.length ? b.buf[0].seq : b.seq + 1;
    const events = b.buf.filter((e) => e.seq > from).slice(0, 2000);
    return { ...b.info(), dropped: from < first - 1 ? first - 1 - from : 0, events };
  };
  if (!g.__towerBenchBridge) create();
  const b = g.__towerBenchBridge;
  configure(b);
  if (Array.isArray(names)) b.sync(names);
  return op === "drain" ? drain(b) : b.info();
}

// Deploy proof, page side. A stamp on the page global survives only if the page did NOT reload.
export function stampPage({ stamp }) {
  globalThis.__towerBenchStamp = stamp;
  return true;
}

export function stampPresent({ stamp }) {
  return globalThis.__towerBenchStamp === stamp;
}

// Reads files the way the game serves them. GameFace has no fetch() (watched 2026-09-26: "fetch is not
// defined"); XMLHttpRequest works for fs://game/<mod id>/<file>, declared or not (watched 2026-10-03).
export async function readServed({ modId, files }) {
  const fnv1a = (text) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16);
  };
  const get = (url) => {
    if (typeof XMLHttpRequest === "undefined") {
      return fetch(url).then(async (res) => ({ status: res.status, ok: res.ok, text: res.ok ? await res.text() : "" }));
    }
    return new Promise((resolve) => {
      const x = new XMLHttpRequest();
      const timer = setTimeout(() => resolve({ status: 0, ok: false, text: "", error: "timed out" }), 5000);
      x.onload = () => { clearTimeout(timer); resolve({ status: x.status, ok: x.status >= 200 && x.status < 300, text: x.responseText || "" }); };
      x.onerror = () => { clearTimeout(timer); resolve({ status: x.status, ok: false, text: "", error: "request failed" }); };
      x.open("GET", url);
      x.send();
    });
  };
  const out = {};
  for (const rel of files) {
    try {
      const r = await get(`fs://game/${modId}/${rel}`);
      out[rel] = r.ok ? { hash: fnv1a(r.text) } : { error: r.error ?? `HTTP ${r.status}` };
    } catch (e) {
      out[rel] = { error: String(e) };
    }
  }
  return out;
}

export { performWrite } from "./engine-write.mjs";
