// Page-side functions for sim, fuzz and arena. Each runs INSIDE the game through bench.cdp.call, which
// serialises it with toString(), so each is self-contained: no imports and no outer references.

// Per-player figures for one moment: yields per turn, treasury, settlements and population, units, researched
// techs and civics, and legacy-path points (the age's victory progress). Techs, civics and legacy points are
// read for major players only: independents have none and there can be dozens of them.
export function playerNumbers() {
  /** @type {(f: () => any, d?: any) => any} */
  const safe = (f, d = null) => { try { return f(); } catch { return d; } };
  const round = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
  const YIELDS = { gold: "YIELD_GOLD", science: "YIELD_SCIENCE", culture: "YIELD_CULTURE", food: "YIELD_FOOD",
    production: "YIELD_PRODUCTION", happiness: "YIELD_HAPPINESS", influence: "YIELD_DIPLOMACY" };
  const nodes = safe(() => [...GameInfo.ProgressionTreeNodes].map((r) => r.ProgressionTreeNodeType), []);
  const legacyPaths = safe(() => [...GameInfo.LegacyPaths].filter((d) => d.EnabledByDefault)
    .map((d) => d.LegacyPathType), []);
  const counted = (tree) => nodes.reduce((n, t) => n + (safe(() => tree.isNodeUnlocked(t)) ? 1 : 0), 0);
  const typeName = (table, key, v) => safe(() => GameInfo[table].lookup(v)?.[key]);
  const progress = (p) => {
    const legacy = {};
    for (const lp of legacyPaths) legacy[lp] = round(safe(() => p.LegacyPaths.getScore(lp)));
    const score = Object.values(legacy).reduce((s, v) => s + (v ?? 0), 0);
    return { techs: counted(p.Techs), civics: counted(p.Culture), legacy, score };
  };
  const one = (id) => {
    const p = Players.get(id);
    const cities = safe(() => p.Cities.getCities(), []) || [];
    const yields = {};
    for (const [k, y] of Object.entries(YIELDS)) yields[k] = round(safe(() => p.Stats.getNetYield(YieldTypes[y])));
    const base = {
      id, major: !!safe(() => p.isMajor), human: !!safe(() => p.isHuman),
      civ: typeName("Civilizations", "CivilizationType", safe(() => p.civilizationType)),
      leader: typeName("Leaders", "LeaderType", safe(() => p.leaderType)),
      gold: round(safe(() => p.Treasury.goldBalance)),
      influence: round(safe(() => p.DiplomacyTreasury.diplomacyBalance)),
      yields, cities: cities.length, towns: cities.filter((c) => safe(() => c.isTown)).length,
      pop: cities.reduce((n, c) => n + (safe(() => c.population) ?? 0), 0),
      units: (safe(() => p.Units.getUnitIds(), []) || []).length,
    };
    return base.major ? { ...base, ...progress(p) } : base;
  };
  return {
    turn: safe(() => Game.turn),
    local: safe(() => GameContext.localPlayerID),
    observer: safe(() => GameContext.localObserverID),
    players: (safe(() => Players.getAliveIds(), []) || []).map(one),
    victories: safe(() => JSON.parse(JSON.stringify(Game.VictoryManager.getVictories() ?? null))),
  };
}

// Counts uncaught script errors and unhandled promise rejections on this page from the first call on. The
// listener lives on the page, so a reload starts a fresh count; `since` is the total already seen.
export function pageErrors({ since = 0 } = {}) {
  const g = /** @type {any} */ (globalThis);
  if (!g.__tbSimErrors) {
    const store = { total: 0, list: /** @type {any[]} */ ([]) };
    const add = (e) => {
      store.total += 1;
      store.list.push({ n: store.total, ...e });
      if (store.list.length > 200) store.list.shift();
    };
    window.addEventListener("error", (ev) => add({ message: String(ev.message), file: String(ev.filename ?? ""),
      line: ev.lineno ?? null }));
    window.addEventListener("unhandledrejection", (ev) => add({
      message: String(ev.reason?.stack ?? ev.reason), file: "", line: null }));
    g.__tbSimErrors = store;
  }
  const s = g.__tbSimErrors;
  const from = since > s.total ? 0 : since;
  return { total: s.total, reset: since > s.total, errors: s.list.filter((e) => e.n > from) };
}

// What the fuzz generator may target right now: units and settlements of every living player, with places.
export function fuzzTargets({ maxUnits = 60 } = {}) {
  /** @type {(f: () => any, d?: any) => any} */
  const safe = (f, d = null) => { try { return f(); } catch { return d; } };
  const players = [];
  const units = [];
  const cities = [];
  for (const id of safe(() => Players.getAliveIds(), []) || []) {
    const p = Players.get(id);
    players.push({ id, major: !!safe(() => p.isMajor), human: !!safe(() => p.isHuman),
      independent: !!safe(() => p.isIndependent) });
    for (const u of (safe(() => p.Units.getUnits(), []) || []).slice(0, maxUnits)) {
      units.push({ owner: id, id: safe(() => u.id.id), x: safe(() => u.location.x), y: safe(() => u.location.y),
        type: safe(() => GameInfo.Units.lookup(u.type)?.UnitType) });
    }
    for (const c of safe(() => p.Cities.getCities(), []) || []) {
      cities.push({ owner: id, id: safe(() => c.id.id), x: safe(() => c.location.x), y: safe(() => c.location.y),
        town: !!safe(() => c.isTown) });
    }
  }
  return {
    turn: safe(() => Game.turn), local: safe(() => GameContext.localPlayerID),
    w: safe(() => GameplayMap.getGridWidth()), h: safe(() => GameplayMap.getGridHeight()),
    players, units: units.filter((u) => u.id != null && u.x != null), cities: cities.filter((c) => c.id != null),
  };
}
