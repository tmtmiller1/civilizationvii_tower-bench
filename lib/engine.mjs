// Everything exported here runs INSIDE the game's UI context. CdpSession.call serialises each
// function with toString(), so each one must be self-contained: no imports and no outer references.

export function snapshot() {
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

export async function cursorPlot() {
  try {
    const m = await import("fs://game/core/ui/input/plot-cursor.js");
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
  const safe = (f, d = null) => { try { return f(); } catch { return d; } };
  const type = (table, key, v) => safe(() => GameInfo[table].lookup(v)?.[key] ?? null);
  if (!safe(() => GameplayMap.isValidLocation({ x, y }), false)) return { valid: false, x, y };
  // MapCities.getCity names the city that owns the plot; only its centre plot holds the settlement.
  const owning = safe(() => MapCities.getCity(x, y));
  const owningCity = owning ? safe(() => Cities.get(owning)) : null;
  const atCentre = owningCity && owningCity.location?.x === x && owningCity.location?.y === y;
  const describe = (c) => ({ owner: c.owner, id: c.id, name: safe(() => Locale.compose(Cities.get(c).name)) });
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
    units: (safe(() => MapUnits.getUnits(x, y), []) || []).map((id) => ({
      owner: id.owner,
      id: id.id,
      type: type("Units", "UnitType", safe(() => Units.get(id)?.type)),
    })),
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
  const describe = (v, d, seen) => {
    if (v === null || v === undefined) return v ?? null;
    const t = typeof v;
    if (t === "number" || t === "string" || t === "boolean") return v;
    if (t === "bigint") return `${v}n`;
    if (t === "function") return `[function ${v.name || "anonymous"}]`;
    if (t !== "object") return String(v);
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v)) {
      if (d <= 0) return `[array(${v.length})]`;
      const a = v.slice(0, 200).map((x) => describe(x, d - 1, seen));
      if (v.length > 200) a.push(`... ${v.length - 200} more`);
      return a;
    }
    if (d <= 0) return "[object]";
    const out = {};
    for (const k of Object.keys(v).slice(0, 200)) {
      try { out[k] = describe(v[k], d - 1, seen); } catch (e) { out[k] = `[throws ${e}]`; }
    }
    const methods = new Set();
    for (let p = Object.getPrototypeOf(v); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const k of Object.getOwnPropertyNames(p)) {
        if (k === "constructor") continue;
        const desc = Object.getOwnPropertyDescriptor(p, k);
        if (desc && typeof desc.value === "function") methods.add(`${k}()`);
        else if (desc && desc.get) {
          try { out[k] = describe(v[k], d - 1, seen); } catch (e) { out[k] = `[throws ${e}]`; }
        }
      }
    }
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
  return describe(value, depth, new Set());
}

// The whole map in one call, compact: per-plot type indexes with name tables, plus units, cities and
// per-player totals. Two snapshots diff into "what changed" (lib/world.mjs).
export function worldSnapshot() {
  const safe = (f, d = null) => { try { return f(); } catch { return d; } };
  const w = GameplayMap.getGridWidth();
  const h = GameplayMap.getGridHeight();
  const n = w * h;
  const names = (table, key) => { const out = []; for (const r of GameInfo[table]) out[r.$index] = r[key]; return out; };
  const t = new Array(n); const f = new Array(n); const r = new Array(n); const o = new Array(n);
  const units = [];
  const cities = [];
  for (let i = 0; i < n; i++) {
    const x = i % w; const y = Math.floor(i / w);
    t[i] = safe(() => GameplayMap.getTerrainType(x, y), -1);
    f[i] = safe(() => GameplayMap.getFeatureType(x, y), -1);
    r[i] = safe(() => GameplayMap.getResourceType(x, y), -1);
    o[i] = safe(() => GameplayMap.getOwner(x, y), -1);
    for (const id of safe(() => MapUnits.getUnits(x, y), []) || []) {
      const u = safe(() => Units.get(id));
      units.push({ i, owner: id.owner, id: id.id, type: safe(() => GameInfo.Units.lookup(u.type)?.UnitType) });
    }
    // MapCities.getCity answers for every plot a city owns, not only its centre (watched 2026-09-26).
    const c = safe(() => MapCities.getCity(x, y));
    const city = c ? safe(() => Cities.get(c)) : null;
    if (city && city.location?.x === x && city.location?.y === y) {
      cities.push({ i, owner: c.owner, id: c.id, name: safe(() => Locale.compose(city.name)), pop: safe(() => city.population), town: !!safe(() => city.isTown) });
    }
  }
  // Which way rows shift and which way "north" runs, read from the engine rather than assumed.
  const probe = (y) => safe(() => GameplayMap.getAdjacentPlotLocation({ x: 4, y }, DirectionTypes.DIRECTION_NORTHEAST));
  const neEven = probe(4); const neOdd = probe(5);
  const players = safe(() => Players.getAliveIds(), []).map((id) => {
    const p = Players.get(id);
    return {
      id,
      name: safe(() => Locale.compose(p.name), String(id)),
      major: !!safe(() => p.isMajor),
      gold: safe(() => Math.round(p.Treasury.goldBalance)),
    };
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
    out.invariants[v.name] = r.error ? { ok: false, detail: `threw ${r.error}` } : { ok: r.value === true, detail: r.value === true ? null : JSON.stringify(r.value) };
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
  const pathOf = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
      const cls = typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
      parts.unshift(e.tagName.toLowerCase() + (e.id ? `#${e.id}` : "") + cls);
    }
    return parts.join(" > ");
  };
  const add = (rule, el, detail) => { if (issues.length < 400) issues.push({ rule, path: pathOf(el), detail }); };
  const ownText = (el) => [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join(" ").trim();
  const walk = (el) => {
    if (visited++ > max) return;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const rect = el.getBoundingClientRect();
    const shown = rect.width > 0 && rect.height > 0 && cs.opacity !== "0";
    const text = ownText(el);
    // Not gated on being visible: collapsing to nothing is the symptom.
    if (text && cs.fontStyle === "italic") {
      add("italic", el, `italic text renders blank in GameFace (this element measures ${Math.round(rect.width)}x${Math.round(rect.height)}); slant it with transform: skewX instead`);
    }
    const bw = parseFloat(cs.borderTopWidth) || 0;
    if (bw > 0 && cs.borderTopStyle !== "none" && /^(initial|currentcolor)$/i.test(cs.borderTopColor)) {
      add("border-color", el, "the border colour never resolved (it reads \"" + cs.borderTopColor + "\"): a border-color shorthand, or one set through a variable, was dropped; set the four border-*-color longhands");
    }
    if (bw > 0 && bw < 1) add("subpixel-border", el, `border width ${bw}px can drop an edge under transform: scale`);
    if (shown && text) {
      const m = text.match(LOC);
      if (m) {
        const tag = el.getAttribute("data-l10n-id");
        add("unresolved-text", el, tag && text.includes(tag)
          ? `data-l10n-id="${tag}" did not resolve, so the engine shows the tag itself`
          : `visible text shows ${m[0]}; a LOC tag or engine type name reached the screen`);
      }
    }
    for (const c of el.children) walk(c);
  };
  walk(root);
  return { visited, truncated: visited > max, issues };
}

export function bridge({ op = "info", names, since = 0, expect = null, log, capacity = 5000, pin = false } = {}) {
  const g = globalThis;
  const safe = (f, d = null) => { try { return f(); } catch { return d; } };
  if (!g.__towerBenchBridge) {
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
    const b = {
      id: Math.random().toString(36).slice(2, 10),
      loadedAt: Date.now(),
      seq: 0,
      buf: [],
      subs: new Map(),
      pinned: new Set(),
      capacity,
      log: !!log,
      agent: false,
      push(name, payload) {
        let data;
        try { data = JSON.parse(JSON.stringify(payload ?? null)); } catch { data = String(payload); }
        const named = {};
        if (payload && typeof payload === "object") {
          for (const [k, v] of Object.entries(payload)) { const r = readable(k, v); if (r) named[k] = r; }
        }
        const e = { bid: b.id, seq: ++b.seq, t: Date.now(), turn: safe(() => Game.turn), name, data };
        if (Object.keys(named).length) e.names = named;
        b.buf.push(e);
        if (b.buf.length > b.capacity) b.buf.splice(0, b.buf.length - b.capacity);
        // UI.log clips lines near 1,000 characters; the bench recovers bid/seq/name from a clipped line.
        if (b.log) { try { console.error(`[TB-EVENT] ${JSON.stringify(e).slice(0, 990)}`); } catch { /* keep going */ } }
      },
      sync(list) {
        // The agent's own list is pinned: a live session can add to it but never remove it.
        const want = new Set([...list, ...b.pinned]);
        for (const [n, h] of b.subs) if (!want.has(n)) { try { engine.off(n, h); } catch { /* already gone */ } b.subs.delete(n); }
        for (const n of want) {
          if (b.subs.has(n)) continue;
          const h = (p) => b.push(n, p);
          try { engine.on(n, h); b.subs.set(n, h); } catch { /* unknown event name */ }
        }
      },
      info() {
        return { id: b.id, seq: b.seq, loadedAt: b.loadedAt, subs: [...b.subs.keys()], pinned: [...b.pinned], log: b.log, agent: b.agent };
      },
    };
    g.__towerBenchBridge = b;
    // The page is about to go (reload, age transition, quit). Say so where it outlives the page.
    try { engine.on("BeforeUnload", () => { try { console.error(`[TB-BRIDGE] ${b.id} unload seq=${b.seq}`); } catch { /* page closing */ } }); } catch { /* no engine */ }
  }
  const b = g.__towerBenchBridge;
  if (pin) {
    b.agent = true;
    b.log = true;
    b.pinned = new Set(names ?? []);
  } else if (log !== undefined && !b.agent) {
    b.log = !!log; // the agent always logs, so its record survives the page
  }
  if (Array.isArray(names)) b.sync(names);
  if (op !== "drain") return b.info();
  // A different page id means the page was replaced: everything this page recorded is new.
  const from = expect && expect === b.id ? since : 0;
  const first = b.buf.length ? b.buf[0].seq : b.seq + 1;
  const events = b.buf.filter((e) => e.seq > from).slice(0, 2000);
  return { ...b.info(), dropped: from < first - 1 ? first - 1 - from : 0, events };
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
// defined"); XMLHttpRequest works for fs://game/<mod>/<file>. fs:// only serves files a modinfo declares.
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

// One write, verified. Sends the request, then re-reads the plot until the intended change is
// observed or waitMs passes. The engine's own return value is recorded but never trusted:
// sendRequest is fire-and-forget and canStart checks request shape, not placement.
export async function performWrite({ op, args, waitMs }) {
  const safe = (f, d = null) => { try { return f(); } catch { return d; } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const typeName = (table, key, v) => safe(() => GameInfo[table].lookup(v)?.[key] ?? null);
  const local = GameContext.localPlayerID;
  const loc = { x: args.x, y: args.y };
  const refuse = (reason) => ({ verdict: "REFUSED", reason, sent: false });

  const unitsAt = () => (safe(() => MapUnits.getUnits(loc.x, loc.y), []) || []).map((id) => ({
    owner: id.owner, id: id.id, type: typeName("Units", "UnitType", safe(() => Units.get(id)?.type)),
  }));
  // Only the centre plot holds the settlement; getCity also answers for every plot the city owns, so
  // without this check "remove the town at a territory plot" would destroy the whole city.
  const cityAt = () => {
    const c = safe(() => MapCities.getCity(loc.x, loc.y));
    const l = c ? safe(() => Cities.get(c).location) : null;
    return l && l.x === loc.x && l.y === loc.y ? { owner: c.owner, id: c.id } : null;
  };
  const plot = () => ({
    terrain: typeName("Terrains", "TerrainType", safe(() => GameplayMap.getTerrainType(loc.x, loc.y))),
    feature: typeName("Features", "FeatureType", safe(() => GameplayMap.getFeatureType(loc.x, loc.y))),
    resource: typeName("Resources", "ResourceType", safe(() => GameplayMap.getResourceType(loc.x, loc.y))),
    city: cityAt(),
    units: unitsAt(),
  });
  const withBlock = (f) => {
    const block = typeof WorldBuilder.startBlock === "function";
    if (block) WorldBuilder.startBlock();
    try { return f(); } finally { if (block) WorldBuilder.endBlock(); }
  };
  // An invalid player id passed to some engine calls segfaults the game, so ids are resolved first.
  const playerOk = (id) => Number.isInteger(id) && !!safe(() => Players.get(id));
  const requestAs = (kind, req) => ({
    send: () => Game.PlayerOperations.sendRequest(local, kind, req),
    canStart: () => safe(() => JSON.parse(JSON.stringify(Game.PlayerOperations.canStart(local, kind, req, false)))),
  });

  if (!safe(() => GameplayMap.isValidLocation(loc), false)) return refuse(`(${loc.x}, ${loc.y}) is not on the map`);

  const before = plot();
  let action;
  let landed;
  let inverse = () => null;

  switch (op) {
    case "unit.place": {
      if (!playerOk(args.owner)) return refuse(`player ${args.owner} does not exist`);
      const row = safe(() => GameInfo.Units.lookup(args.type));
      if (!row) return refuse(`unknown unit type ${args.type}`);
      const had = new Set(before.units.map((u) => `${u.owner}:${u.id}`));
      const fresh = () => unitsAt().find((u) => !had.has(`${u.owner}:${u.id}`)
        && u.owner === args.owner && u.type === row.UnitType);
      action = requestAs("CREATE_ELEMENT", { Kind: "UNIT", Type: row.UnitType, Location: loc, Owner: args.owner });
      landed = () => !!fresh();
      inverse = () => {
        const u = fresh();
        return u ? { op: "unit.remove", args: { x: loc.x, y: loc.y, owner: u.owner, id: u.id } } : null;
      };
      break;
    }
    case "unit.remove": {
      const target = before.units.find((u) => (args.id == null || u.id === args.id)
        && (args.owner == null || u.owner === args.owner));
      if (!target) return refuse("no matching unit on that plot");
      action = requestAs("DESTROY_ELEMENT", { Kind: "UNIT", Owner: target.owner, LocalID: target.id });
      landed = () => !unitsAt().some((u) => u.owner === target.owner && u.id === target.id);
      inverse = () => (target.type
        ? { op: "unit.place", args: { x: loc.x, y: loc.y, owner: target.owner, type: target.type } } : null);
      break;
    }
    case "town.place": {
      if (!playerOk(args.owner)) return refuse(`player ${args.owner} does not exist`);
      if (before.city) return refuse("there is already a settlement on that plot");
      action = requestAs("CREATE_ELEMENT", { Kind: "CITY", Location: loc, Owner: args.owner });
      landed = () => cityAt()?.owner === args.owner;
      inverse = () => ({ op: "town.remove", args: { x: loc.x, y: loc.y } });
      break;
    }
    case "town.remove": {
      const c = before.city;
      if (!c) return refuse("no settlement on that plot");
      action = requestAs("DESTROY_ELEMENT", { Kind: "CITY", Owner: c.owner, LocalID: c.id });
      landed = () => !cityAt();
      inverse = () => ({ op: "town.place", args: { x: loc.x, y: loc.y, owner: c.owner } });
      break;
    }
    case "terrain.set": {
      const row = safe(() => GameInfo.Terrains.lookup(args.type));
      if (!row) return refuse(`unknown terrain ${args.type}`);
      action = { send: () => withBlock(() => WorldBuilder.MapPlots.setTerrain(row.$index, loc)) };
      landed = () => plot().terrain === row.TerrainType;
      inverse = () => ({ op: "terrain.set", args: { x: loc.x, y: loc.y, type: before.terrain } });
      break;
    }
    case "feature.set":
    case "resource.set": {
      const isFeature = op === "feature.set";
      const [table, key] = isFeature ? ["Features", "FeatureType"] : ["Resources", "ResourceType"];
      const clear = args.type == null;
      const row = clear ? null : safe(() => GameInfo[table].lookup(args.type));
      if (!clear && !row) return refuse(`unknown ${isFeature ? "feature" : "resource"} ${args.type}`);
      const want = clear ? null : row[key];
      const idx = clear ? (isFeature ? FeatureTypes.NO_FEATURE : ResourceTypes.NO_RESOURCE) : row.$index;
      action = {
        send: () => withBlock(() => (isFeature
          ? WorldBuilder.MapPlots.setFeature(idx, loc)
          : WorldBuilder.MapPlots.setResource(idx, loc, clear ? 0 : (args.amount ?? 1)))),
      };
      landed = () => plot()[isFeature ? "feature" : "resource"] === want;
      const prior = before[isFeature ? "feature" : "resource"];
      inverse = () => ({ op, args: { x: loc.x, y: loc.y, type: prior } });
      break;
    }
    default:
      return refuse(`unknown operation ${op}`);
  }

  if (landed()) return { verdict: "ALREADY", reason: "the plot already has that state; nothing was sent", sent: false, before, after: before };

  const canStart = action.canStart ? action.canStart() : undefined;
  const t0 = Date.now();
  let returned;
  try {
    returned = action.send();
  } catch (e) {
    return { verdict: "THREW", reason: String(e), sent: true, canStart, before, after: plot() };
  }
  let landedMs = null;
  while (Date.now() - t0 < waitMs) {
    if (landed()) { landedMs = Date.now() - t0; break; }
    await sleep(50);
  }
  const after = plot();
  // Not what was asked, but not nothing either: e.g. setFeature with a feature the plot cannot hold
  // clears the existing one. Report it, and record how to put the plot back as it was.
  const changed = !landedMs && JSON.stringify(after) !== JSON.stringify(before);
  const restore = () => {
    if (op === "terrain.set") return { op, args: { x: loc.x, y: loc.y, type: before.terrain } };
    if (op === "feature.set") return { op, args: { x: loc.x, y: loc.y, type: before.feature } };
    if (op === "resource.set") return { op, args: { x: loc.x, y: loc.y, type: before.resource } };
    return null;
  };
  return {
    verdict: landedMs !== null ? "LANDED" : changed ? "UNEXPECTED" : "NO EFFECT",
    landedMs,
    waitedMs: Date.now() - t0,
    sent: true,
    returned: returned === undefined ? null : returned,
    canStart,
    before,
    after,
    inverse: landedMs !== null ? inverse() : changed ? restore() : null,
  };
}
