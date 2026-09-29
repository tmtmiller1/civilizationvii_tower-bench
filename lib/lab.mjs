// Hands-free game sessions for tests that must not touch the player's own game: back up everything
// a test game writes, start a Play Now game over CDP (no probe mod, no registry change), roll turns
// without Autoplay, quit, and put every backed-up file and registry flag back.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CdpSession, listTargets, scopeOf } from "./cdp.mjs";

const APP_ID = 1295660;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROBE_LIKE = /probe|repro|harness|-test$/i;

export function gamePid() {
  const r = spawnSync("pgrep", ["-x", "CivilizationVII"], { encoding: "utf8" });
  const first = r.stdout.trim().split("\n")[0];
  return first ? Number(first) : null;
}

export function crashReports() {
  const dir = path.join(os.homedir(), "Library", "Logs", "DiagnosticReports");
  try {
    return fs.readdirSync(dir).filter((f) => /^CivilizationVII.*\.ips$/.test(f)).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function sql(db, statement, { json = false, readonly = false } = {}) {
  const args = [...(readonly ? ["-readonly"] : []), ...(json ? ["-json"] : []), db, statement];
  const out = execFileSync("sqlite3", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return json ? (out.trim() ? JSON.parse(out) : []) : out;
}

export function registryRows(db) {
  return sql(db, "SELECT m.ModRowId AS row, m.ModId AS id, m.Disabled AS disabled, s.Path AS path "
    + "FROM Mods m JOIN ScannedFiles s USING (ScannedFileRowId)", { json: true, readonly: true });
}

// Before a launch: the game must be closed, no other harness may be mid-run (two runners restoring
// each other's registry snapshots once left every user mod disabled), and enabled probe mods are
// reported because they load into every game.
export function preflight(paths) {
  const problems = [];
  const warnings = [];
  if (gamePid()) problems.push("the game is running; quit it first (a lab run starts its own game)");
  const ps = spawnSync("ps", ["-Ao", "args"], { encoding: "utf8" }).stdout.split("\n");
  const runners = ps.filter((l) => /run-(probe|repro|modtest|hs|promo)|cdh-|eep-/.test(l) && !/grep/.test(l));
  if (runners.length) problems.push(`another harness is running: ${runners[0].slice(0, 120)}`);
  const probes = registryRows(paths.modsDb).filter((r) => !r.disabled && PROBE_LIKE.test(r.id));
  if (probes.length) warnings.push(`enabled probe mods load into this run too: ${probes.map((r) => r.id).join(", ")}`);
  return { problems, warnings };
}

const BACKUP_FILES = ["Mods.sqlite", "LocalStorage.sqlite", "HallofFame.sqlite"];

const isOfficial = (p) => /\/Resources\/(DLC|Base)\//.test(p.replaceAll("\\", "/"));

// The mods a bisection can switch: enabled, not shipped with the game. Keyed by the path of the live
// copy, because row ids change whenever the game re-scans a mod.
export function candidateMods(db) {
  // The bench's own agent is the measuring instrument, never a suspect.
  return registryRows(db).filter((r) => !r.disabled && !isOfficial(r.path) && r.id !== "tower-bench-agent")
    .map((r) => ({ id: r.id, path: r.path }));
}

// Switches exactly the candidates in `enabledIds` on and the other candidates off. Only valid while
// the game is closed; `restore` puts the player's flags back afterwards.
export function applyModSet(db, candidates, enabledIds) {
  if (gamePid()) throw new Error("the game is running; the registry can only change while it is closed");
  const on = new Set(enabledIds);
  const q = (s) => `'${s.replaceAll("'", "''")}'`;
  const stmts = candidates.map((c) => `UPDATE Mods SET Disabled = ${on.has(c.id) ? 0 : 1} WHERE ScannedFileRowId = (SELECT ScannedFileRowId FROM ScannedFiles WHERE Path = ${q(c.path)});`);
  sql(db, `BEGIN; ${stmts.join(" ")} COMMIT;`);
}

export class Lab {
  // `pid` finds the running game; tests pass their own so the real game on the machine cannot affect them.
  constructor(paths, { pid = gamePid } = {}) {
    this.paths = paths;
    this.pid = pid;
    this.root = path.join(path.dirname(paths.evidence), "runs");
    this.currentFile = path.join(this.root, "current.json");
    this.cdp = new CdpSession(paths.cdpPort);
  }

  get current() {
    try { return JSON.parse(fs.readFileSync(this.currentFile, "utf8")); } catch { return null; }
  }

  setCurrent(run) {
    fs.mkdirSync(this.root, { recursive: true });
    if (run) fs.writeFileSync(this.currentFile, JSON.stringify(run, null, 2));
    else fs.rmSync(this.currentFile, { force: true });
  }

  get lastStop() {
    try { return Number(fs.readFileSync(path.join(this.root, "last-stop"), "utf8")); } catch { return null; }
  }

  markStopped() {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(path.join(this.root, "last-stop"), String(Date.now()));
  }

  backup(dir) {
    const b = path.join(dir, "backup");
    fs.mkdirSync(b, { recursive: true });
    const u = this.paths.user;
    for (const f of BACKUP_FILES) {
      const src = path.join(u, f);
      // .backup gives a consistent copy even if something still holds the database open.
      if (fs.existsSync(src)) execFileSync("sqlite3", [src, `.backup '${path.join(b, f).replaceAll("'", "''")}'`]);
    }
    for (const f of fs.readdirSync(u).filter((n) => /Options.*\.txt$/.test(n))) fs.copyFileSync(path.join(u, f), path.join(b, f));
    const auto = path.join(u, "Saves", "Single", "auto");
    if (fs.existsSync(auto)) fs.cpSync(auto, path.join(b, "auto"), { recursive: true, preserveTimestamps: true });
    const rows = registryRows(this.paths.modsDb);
    fs.writeFileSync(path.join(b, "registry.json"), JSON.stringify(rows));
    fs.writeFileSync(path.join(b, "ips-before.json"), JSON.stringify(crashReports()));
    return { files: fs.readdirSync(b), registryRows: rows.length };
  }

  // Puts the player's state back. Nothing is deleted: whatever the test game wrote is moved into the
  // run folder, so a restore can be inspected or undone by hand.
  restore(dir) {
    if (this.pid()) throw new Error("the game is still running; quit it before restoring");
    const b = path.join(dir, "backup");
    const lab = path.join(dir, "written-by-test-game");
    fs.mkdirSync(lab, { recursive: true });
    const u = this.paths.user;
    const report = { moved: [], restored: [], registry: [] };

    const auto = path.join(u, "Saves", "Single", "auto");
    if (fs.existsSync(path.join(b, "auto"))) {
      if (fs.existsSync(auto)) { fs.renameSync(auto, path.join(lab, "auto")); report.moved.push("Saves/Single/auto"); }
      fs.cpSync(path.join(b, "auto"), auto, { recursive: true, preserveTimestamps: true });
      report.restored.push("Saves/Single/auto");
    }
    for (const f of [...BACKUP_FILES.filter((n) => n !== "Mods.sqlite"), ...fs.readdirSync(b).filter((n) => /Options.*\.txt$/.test(n))]) {
      if (!fs.existsSync(path.join(b, f))) continue;
      const live = path.join(u, f);
      if (fs.existsSync(live)) { fs.copyFileSync(live, path.join(lab, f)); report.moved.push(f); }
      fs.copyFileSync(path.join(b, f), live);
      report.restored.push(f);
    }

    // The registry is restored flag by flag, keyed by path. The game re-registers mods whose files
    // changed as new rows, so row ids are not stable and a whole-file copy would drop real updates.
    const before = new Map(JSON.parse(fs.readFileSync(path.join(b, "registry.json"), "utf8")).map((r) => [r.path, r]));
    const updates = [];
    for (const row of registryRows(this.paths.modsDb)) {
      const was = before.get(row.path);
      if (!was) {
        report.registry.push({ path: row.path, id: row.id, note: "new since the backup; left as the game set it" });
        continue;
      }
      if ((was.disabled ?? null) !== (row.disabled ?? null)) {
        updates.push(`UPDATE Mods SET Disabled = ${was.disabled === null ? "NULL" : Number(was.disabled)} WHERE ModRowId = ${Number(row.row)};`);
        report.registry.push({ path: row.path, id: row.id, from: row.disabled, to: was.disabled });
      }
    }
    if (updates.length) sql(this.paths.modsDb, `BEGIN; ${updates.join(" ")} COMMIT;`);

    const ipsBefore = new Set(JSON.parse(fs.readFileSync(path.join(b, "ips-before.json"), "utf8")));
    report.crashReports = crashReports().filter((f) => !ipsBefore.has(f));
    for (const f of report.crashReports) fs.copyFileSync(f, path.join(dir, path.basename(f)));
    return report;
  }

  async waitFor(what, test, timeoutMs, stepMs = 1000) {
    const t0 = Date.now();
    for (;;) {
      try { const v = await test(); if (v) return v; } catch { /* not ready yet */ }
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`);
      await sleep(stepMs);
    }
  }

  async scope() {
    const targets = await listTargets(this.paths.cdpPort, { timeoutMs: 1500 });
    return targets.some((t) => scopeOf(t) === "game") ? "game" : targets.some((t) => scopeOf(t) === "shell") ? "shell" : "other";
  }

  // Play Now over CDP from the main-menu page, with optional seeds and start age, then presses
  // Begin Game. Seeded Play Now games are deterministic, which makes them the cheap A/B.
  async startNewGame({ seed, age, log = () => {} } = {}) {
    if (this.pid()) throw new Error("the game is already running");
    const last = this.lastStop;
    if (last && Date.now() - last < 15000) await sleep(15000 - (Date.now() - last)); // Steam ignores a relaunch sooner than this
    execFileSync("open", [`steam://rungameid/${APP_ID}`]);
    log("launch requested through Steam");
    const pid = await this.waitFor("the game process", () => this.pid(), 120000, 2000);
    log(`game process ${pid}`);
    await this.waitFor("the main menu", async () => (await this.scope()) === "shell", 240000, 2000);
    await this.cdp.ensure();
    await this.waitFor("the main menu scripts", () => this.cdp.call(() => typeof Configuration.editGame === "function" && typeof engine.call === "function"), 60000);
    await sleep(5000); // the menu runs its own save query on load; let it settle
    const setup = await this.cdp.call(({ seed, age }) => {
      const out = {};
      Configuration.editGame().reset(GameModeTypes.SINGLEPLAYER);
      if (age) { Configuration.editGame().setStartAgeType(age); out.age = age; }
      if (seed != null) {
        Configuration.editMap().setMapSeed(seed);
        Configuration.editGame().setGameSeed(seed);
        out.mapSeed = Configuration.getMap().mapSeed;
        out.gameSeed = Configuration.getGame().gameSeed;
      }
      engine.call("startGame");
      return out;
    }, { seed: seed ?? null, age: age ?? null });
    log(`Play Now started ${JSON.stringify(setup)}`);
    this.cdp.close();
    await this.waitFor("the game to load", async () => (await this.scope()) === "game", 360000, 2000);
    await this.cdp.ensure();
    // Nothing gameplay-side lands until Begin Game is pressed; its handler is UI.notifyUIReady().
    await this.waitFor("Begin Game", () => this.cdp.call(() => { UI.notifyUIReady(); return UI.getGameLoadingState() === 8; }), 240000, 1000);
    const turn = await this.cdp.call(() => Game.turn);
    log(`game started, turn ${turn}`);
    return { pid, setup, turn };
  }

  // Ends turns the way that leaves the economy clean: send the turn anyway, never Autoplay.
  async endTurns(n, { timeoutMs = 180000, log = () => {} } = {}) {
    const rolled = [];
    for (let i = 0; i < n; i++) {
      await this.cdp.ensure();
      const from = await this.cdp.call(() => Game.turn);
      const t0 = Date.now();
      let blocker = null;
      let nextNudge = 0;
      for (;;) {
        if (Date.now() >= nextNudge) {
          blocker = await this.cdp.call(() => {
            const pid = GameContext.localPlayerID;
            let name = null;
            try {
              const type = Game.Notifications.getEndTurnBlockingType(pid);
              const id = type ? Game.Notifications.findEndTurnBlocking(pid, type) : null;
              if (id) name = Game.Notifications.getTypeName(Game.Notifications.find(id).Type);
              // Recurring and not clearable by dismiss alone; CONSIDER_ASSIGN_RESOURCE lets the turn pass.
              if (name === "NOTIFICATION_ASSIGN_NEW_RESOURCES") {
                Game.Notifications.dismiss(id);
                Game.PlayerOperations.sendRequest(pid, "CONSIDER_ASSIGN_RESOURCE", {});
              }
            } catch { /* no blocker API; send anyway */ }
            UI.Player.deselectAllUnits();
            GameContext.sendTurnComplete();
            return name;
          }).catch(() => null);
          nextNudge = Date.now() + 15000;
        }
        await sleep(1500);
        const now = await this.cdp.call(() => Game.turn).catch(() => null);
        if (now != null && now > from) { rolled.push({ from, to: now, ms: Date.now() - t0, blocker }); log(`turn ${from} -> ${now}`); break; }
        if (!this.pid()) throw new Error(`the game exited during turn ${from}`);
        if (Date.now() - t0 > timeoutMs) throw new Error(`turn ${from} did not end within ${timeoutMs / 1000} s${blocker ? ` (blocked by ${blocker})` : ""}`);
      }
    }
    return rolled;
  }

  async quit({ log = () => {} } = {}) {
    const pid = this.pid();
    this.cdp.close();
    if (!pid) return { wasRunning: false };
    spawnSync("kill", ["-TERM", String(pid)]);
    try {
      await this.waitFor("the game to exit", () => !this.pid(), 20000, 1000);
    } catch {
      spawnSync("kill", ["-KILL", String(pid)]);
      await this.waitFor("the game to exit after SIGKILL", () => !this.pid(), 15000, 1000);
      log("the game ignored SIGTERM and was killed");
    }
    this.markStopped();
    return { wasRunning: true, pid };
  }
}
