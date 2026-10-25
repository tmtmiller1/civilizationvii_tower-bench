// Making lab games quicker to run: game setup values set at Play Now, quick-play option files written
// before launch, a pop-up closer, and a turn driver that runs inside the game page.
import fs from "node:fs";
import path from "node:path";

// Each value is a setup parameter as the game's own setup screen names it (core/config/SetupParameters.xml).
// "fast" keeps an idle test player alive and gets to the age's end sooner; it changes the game, so a run
// that repeats an earlier default-setup baseline shouldn't use it. Difficulty is the game-level option: a
// PlayerDifficulty set at Play Now reads back on the setup screen but the game still starts at Prince.
export const SETUP_PRESETS = {
  fast: {
    game: {
      AgeLength: "AGE_LENGTH_ABBREVIATED", IndependentHostility: "INDEPENDENT_HOSTILITY_FRIENDLY",
      Difficulty: "DIFFICULTY_SETTLER",
    },
    player: {},
  },
};

const PLAYER_PARAMS = new Set(["PlayerDifficulty", "PlayerLeader", "PlayerCivilization"]);

// "fast", "fast,MapSize=MAPSIZE_TINY" or "AgeLength=AGE_LENGTH_ABBREVIATED,...".
export function parseSetup(spec) {
  const setup = { game: {}, player: {} };
  if (!spec) return null;
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq < 0) {
      const preset = SETUP_PRESETS[part];
      if (!preset) throw new Error(`unknown setup preset "${part}" (known: ${Object.keys(SETUP_PRESETS).join(", ")})`);
      Object.assign(setup.game, preset.game);
      Object.assign(setup.player, preset.player);
      continue;
    }
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!/^[A-Za-z][A-Za-z-]*$/.test(key) || !value) throw new Error(`bad setup value "${part}"`);
    (PLAYER_PARAMS.has(key) ? setup.player : setup.game)[key] = value;
  }
  return setup;
}

// Option-file keys that slow a scripted game down. The lab backs up every *Options*.txt before this runs and
// puts them back at lab stop.
export const QUICK_OPTIONS = {
  "UserOptions.txt": { QuickCombat: "1", QuickMovement: "1", PlayHistoricMomentAnimation: "0" },
  "TutorialOptions.txt": { SkipEraWelcomeTutorial: "1", TutorialLevel: "0" },
};

// Sets `key value` on the line that holds the key, commented out or not. A key the file doesn't list is
// reported rather than added, since the section it belongs in isn't known.
export function setOptionKeys(text, keys) {
  const changed = [];
  const missing = [];
  let out = text;
  for (const [key, value] of Object.entries(keys)) {
    const re = new RegExp(`^;?${key}[ \\t].*$`, "m");
    const m = out.match(re);
    if (!m) {
      missing.push(key);
      continue;
    }
    const line = `${key} ${value}`;
    if (m[0] !== line) {
      out = out.replace(re, line);
      changed.push(line);
    }
  }
  return { text: out, changed, missing };
}

export function applyQuickOptions(userDir) {
  const report = [];
  for (const [file, keys] of Object.entries(QUICK_OPTIONS)) {
    const p = path.join(userDir, file);
    if (!fs.existsSync(p)) {
      report.push(`${file}: not found`);
      continue;
    }
    const r = setOptionKeys(fs.readFileSync(p, "utf8"), keys);
    if (r.changed.length) fs.writeFileSync(p, r.text);
    report.push(`${file}: ${r.changed.length ? r.changed.join(", ") : "already set"}${r.missing.length ? `; not in the file: ${r.missing.join(", ")}` : ""}`);
  }
  return report;
}

// --- In-page functions. Each runs inside the game through CdpSession.call, so it must be self-contained.

// What the running game took, read from its configuration rather than the setup screen. A value comes back
// as its name or as the name's hash. Parameters without a known configuration key are reported unchecked.
export function pageSetupCheck({ setup }) {
  const keys = {
    AgeLength: ["getGame", "AgeLength"], IndependentHostility: ["getGame", "IndependentHostility"],
    Difficulty: ["getGame", "Handicap"], GameSpeeds: ["getGame", "SpeedType"], MapSize: ["getMap", "SizeType"],
  };
  const out = {};
  for (const [k, want] of Object.entries({ ...setup?.game, ...setup?.player })) {
    const where = keys[k];
    if (!where) { out[k] = "unchecked"; continue; }
    let got;
    try { got = Configuration[where[0]]().getValue(where[1]); } catch { got = null; }
    out[k] = got === want || got === Database.makeHash(want) ? "ok" : `got ${got}`;
  }
  return out;
}

// Closes what the game has queued or showing: display-queue pop-ups (tech and civic, narrative, unlocks,
// advisor warnings, dialogs) and screens pushed on the ContextManager. Returns what it closed, by name.
// The page has no ContextManager global; like the queue, it's reached through its module.
export async function pagePopups({ action, keep, queueModule, contextModule }) {
  const { DisplayQueueManager: q } = await import(queueModule);
  const { ContextManager: cm } = await import(contextModule);
  const keepSet = new Set(keep);
  const describe = (r) => r.category + (r.id != null ? `#${r.id}` : "");
  const tag = (s) => s.tagName.toLowerCase();
  const screens = () => [...cm.screens].map(tag);
  const popScreens = (closed) => {
    for (let i = 0; i < 20 && !cm.isEmpty; i++) {
      const s = cm.getCurrentTarget();
      if (!s || keepSet.has(tag(s))) return;
      closed.push(tag(s));
      cm.pop(s);
    }
  };
  const actions = {
    list: () => ({
      active: q.activeDisplays.map(describe), queued: q.findAll(() => true).map(describe),
      screens: screens(), suspended: q.isSuspended(),
    }),
    suspend: () => { q.suspend(); return { suspended: q.isSuspended() }; },
    resume: () => { if (q.isSuspended()) q.resume(); return { suspended: q.isSuspended() }; },
    clear: () => {
      const closed = q.closeMatching((r) => !keepSet.has(r.category)).map(describe);
      popScreens(closed);
      if (UI.getGameLoadingState() !== 8) { UI.notifyUIReady(); closed.push("loading curtain"); }
      return { closed };
    },
  };
  return (actions[action] ?? actions.clear)();
}

// One-turn Autoplay re-armed from inside the page as soon as the local player's turn has settled, so the
// mods' local-turn work runs every turn (multi-turn Autoplay skips it) without a shell round trip per turn.
// Readings go to window.__benchDrive.log, which "lab drive" copies to drive.log in the run folder. Every
// field of `cfg` is filled in by the caller.
export async function pageDriveStart(cfg) {
  const w = /** @type {any} */ (window);
  if (w.__benchDrive?.timer) clearInterval(w.__benchDrive.timer);
  let q = null;
  try { q = (await import(cfg.queueModule)).DisplayQueueManager; } catch { /* no queue: pop-ups stay */ }
  const keepSet = new Set(cfg.keep);
  const now = Date.now();
  /** @type {any} */
  const d = {
    turns: cfg.turns, startedAt: now, startTurn: Game.turn, done: 0, state: "running", reason: null, timer: null,
    log: [], closed: {}, lastTurn: Game.turn, turnSeenAt: now, armedTurn: null, armedAt: 0, msPerTurn: null,
  };
  const h = {
    note(line) {
      d.log.push(`${new Date().toISOString().slice(11, 19)} turn ${Game.turn} ${line}`);
      if (d.log.length > 400) d.log.shift();
    },
    stop(state, reason) {
      clearInterval(d.timer);
      d.timer = null;
      try { Autoplay.setActive(false); } catch { /* already off */ }
      Object.assign(d, { state, reason });
      h.note(`${state}: ${reason}`);
    },
    sample() {
      if (!cfg.sample) return;
      let r;
      try { r = (0, eval)(cfg.sample); } catch (e) { r = `sample threw: ${e instanceof Error ? e.message : e}`; }
      h.note(typeof r === "string" ? r : JSON.stringify(r));
    },
    clearPopups() {
      if (!cfg.popups || !q) return;
      for (const r of q.closeMatching((x) => !keepSet.has(x.category))) {
        d.closed[r.category] = (d.closed[r.category] ?? 0) + 1;
      }
    },
    arm(t) {
      h.clearPopups();
      Autoplay.setTurns(1);
      Autoplay.setReturnAsPlayer(GameContext.localPlayerID);
      Autoplay.setObserveAsPlayer(GameContext.localPlayerID);
      Autoplay.setActive(true);
      Object.assign(d, { armedTurn: Game.turn, armedAt: t });
    },
    // Still on the turn armed last: Autoplay running, or ended with the turn not yet moved on.
    waiting(t) {
      if (!Autoplay.isActive && (d.armedTurn === null || Game.turn !== d.armedTurn)) return false;
      const secs = Math.round(cfg.stuckMs / 1000);
      if (t - d.armedAt > cfg.stuckMs) h.stop("stuck", `turn ${Game.turn} didn't advance in ${secs} s`);
      return true;
    },
    // Within cfg.stopBeforeAgeEnd points of the age's maximum: the reason to stop, or null to go on.
    nearAgeEnd() {
      if (cfg.stopBeforeAgeEnd == null) return null;
      const m = Game.AgeProgressManager;
      const cur = m.getCurrentAgeProgressionPoints();
      const max = m.getMaxAgeProgressionPoints();
      if (max - cur > cfg.stopBeforeAgeEnd) return null;
      return `age progress ${cur} of ${max}, within ${cfg.stopBeforeAgeEnd} of the age's end`;
    },
    finishTurn(t) {
      if (d.armedTurn === null) return;
      d.done++;
      d.msPerTurn = Math.round((t - d.startedAt) / d.done);
      if (d.done % cfg.every === 0) h.sample();
    },
    tick() {
      if (UI.getGameLoadingState() !== 8) { UI.notifyUIReady(); return; }
      const t = Date.now();
      if (Game.turn !== d.lastTurn) Object.assign(d, { lastTurn: Game.turn, turnSeenAt: t });
      if (h.waiting(t) || t - d.turnSeenAt < cfg.settleMs || d.armedTurn === Game.turn) return;
      h.finishTurn(t);
      if (!Players.get(GameContext.localPlayerID)?.isAlive) return h.stop("ended", "the local player is out");
      if (d.done >= d.turns) return h.stop("done", `${d.done} turns, ${d.msPerTurn} ms a turn`);
      const near = h.nearAgeEnd();
      if (near) return h.stop("near the age's end", near);
      h.arm(t);
    },
  };
  w.__benchDrive = d;
  h.note(`driving ${cfg.turns} turns, a reading every ${cfg.every}, settle ${cfg.settleMs} ms`);
  h.sample();
  const guarded = () => { try { h.tick(); } catch (e) { h.stop("error", e instanceof Error ? e.message : String(e)); } };
  d.timer = setInterval(guarded, 250);
  return { startTurn: d.startTurn };
}

// The game's display queue and screen stack, which the page functions import by these paths.
export const QUEUE_MODULE = "/core/ui/context-manager/display-queue-manager.js";
export const CONTEXT_MODULE = "/core/ui/context-manager/context-manager.js";

// Applies setup values on the main-menu page after Play Now's reset and before startGame.
export function pageApplySetup({ setup }) {
  for (const [k, v] of Object.entries(setup.game ?? {})) GameSetup.setGameParameterValue(k, v);
  for (const [k, v] of Object.entries(setup.player ?? {})) GameSetup.setPlayerParameterValue(0, k, v);
  return { ...setup.game, ...setup.player };
}

// Presses Begin Game or clears a new age's curtain; true once the game takes input.
export function pageReady() {
  if (UI.getGameLoadingState() !== 8) UI.notifyUIReady();
  return UI.getGameLoadingState() === 8;
}

// The turn, the age by name and the age's progress points.
export function pageAgeProgress() {
  let ageType = String(Game.age);
  try { ageType = GameInfo.Ages.lookup(Game.age)?.AgeType ?? ageType; } catch { /* keep the raw value */ }
  const m = Game.AgeProgressManager;
  return {
    turn: Game.turn, age: Game.age, ageType,
    points: m.getCurrentAgeProgressionPoints(), max: m.getMaxAgeProgressionPoints(),
  };
}

// What a player sees between the last turn of an age and the next age's first turn: the end-of-age screens on the
// game page (the endgame cinematic, then the victories screen with its Exit button), the civ select on the main-menu
// page, and the new age's loading curtain. With `press`, it takes the step a screen waits for, by the call its own
// button makes: "exit" is the victories screen's Exit, engine.call("exitToMainMenu"), refused unless the age is over;
// "civ" chooses a civ on the civ select (`civ` when it's offered and unlocked, else the historical choice, else the
// first unlocked one) and starts the next age through the screen's own startGame.
export async function pageAgeScreens({ queueModule, contextModule, press, civ }) {
  const read = (f) => { try { return f(); } catch { return null; } };
  const where = String(read(() => location.pathname));
  /** @type {[string, RegExp][]} */
  const pages = [["shell", /root-shell\.html$/], ["game", /root-game\.html$/]];
  const page = pages.find(([, re]) => re.test(where))?.[0];
  const load = (m, name) => import(m).then((x) => x[name]).catch(() => null);
  const cm = await load(contextModule, "ContextManager");
  const q = await load(queueModule, "DisplayQueueManager");
  const stack = [...(cm?.screens ?? [])];
  const tag = (s) => s.tagName.toLowerCase();
  const ageOver = page === "game" && read(() => !!Game.AgeProgressManager.isAgeOver);
  const exit = () => {
    if (ageOver !== true) return { refused: "the age isn't over on this page" };
    engine.call("exitToMainMenu");
    return { pressed: "exitToMainMenu (the Exit button)" };
  };
  const pickCiv = (c) => {
    const open = (c.civData ?? []).filter((x) => !x.isLocked);
    return open.find((x) => x.civID === civ) ?? open.find((x) => x.isHistoricalChoice) ?? open[0];
  };
  const chooseCiv = () => {
    const el = stack.find((s) => tag(s) === "age-transition-civ-select");
    const c = el && (el.maybeComponent ?? el.component);
    const pick = c && pickCiv(c);
    if (!pick) return { refused: c ? "no unlocked civ on the civ select" : "the civ select isn't up" };
    c.selectedCivInfo = pick;
    c.startGame();
    const note = civ && pick.civID !== civ ? `; ${civ} isn't offered unlocked` : "";
    return { pressed: `startGame with ${pick.civID} (the Choose button)${note}` };
  };
  /** @type {Record<string, () => object>} */
  const steps = { exit, civ: chooseCiv, none: () => ({}) };
  const screens = stack.map(tag).filter((t) => t !== "mouse-guard")
    .concat([...(q?.activeDisplays ?? [])].map((r) => `queue ${r.category}`));
  return {
    page: page ?? "other", screens, loading: read(() => UI.getGameLoadingState()), ageOver, pressed: null,
    refused: null, ...steps[press ?? "none"](),
  };
}

export function pageDriveStatus({ since = 0 }) {
  const d = /** @type {any} */ (window).__benchDrive;
  if (!d) return null;
  return {
    state: d.state, reason: d.reason, done: d.done, turns: d.turns, turn: Game.turn, msPerTurn: d.msPerTurn,
    closed: d.closed, lines: d.log.slice(since), logLength: d.log.length,
  };
}

export function pageDriveStop() {
  const d = /** @type {any} */ (window).__benchDrive;
  if (!d) return null;
  if (d.timer) clearInterval(d.timer);
  d.timer = null;
  try { Autoplay.setActive(false); } catch { /* already off */ }
  if (d.state === "running") d.state = "stopped";
  return { state: d.state, done: d.done };
}
