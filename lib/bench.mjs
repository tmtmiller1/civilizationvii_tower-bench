import { EventEmitter } from "node:events";
import path from "node:path";
import { CdpSession, listTargets } from "./cdp.mjs";
import { applyDeploy, planDeploy } from "./deploy.mjs";
import * as engine from "./engine.mjs";
import { EvidenceLog, localDate } from "./evidence.mjs";
import { EventBridge, agentStatus } from "./events.mjs";
import { readMods } from "./mods.mjs";
import { gameVersion } from "./paths.mjs";
import { WatchStore, violations } from "./watches.mjs";
import { SnapshotStore, describeDiff, diffWorlds } from "./world.mjs";
import { describeRequest, hintsFor, snippetFor, validateRequest } from "./writes.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BenchError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const preview = (v, max = 2000) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > max ? `${s.slice(0, max)}…` : s;
};

export class Bench extends EventEmitter {
  constructor(paths) {
    super();
    this.paths = paths;
    this.cdp = new CdpSession(paths.cdpPort);
    this.evidence = new EvidenceLog(paths.evidence);
    this.version = gameVersion(paths);
    this.armed = false;
    const root = path.dirname(paths.evidence);
    this.snapshots = new SnapshotStore(path.join(root, "snapshots"));
    this.watches = new WatchStore(root);
    this.events = new EventBridge(this.cdp, path.join(root, "events"), {
      agentActive: () => { const a = agentStatus(paths); return a.installed && (a.subscriptions?.length ?? 0) > 0; },
    });
    this.catalogCache = null;
  }

  log(entry) {
    const full = this.evidence.append({ version: this.version, ...entry });
    this.emit("evidence", full);
    return full;
  }

  async status() {
    const base = { version: this.version, armed: this.armed, undo: this.undoable().length, port: this.paths.cdpPort };
    try {
      await listTargets(this.paths.cdpPort, { timeoutMs: 1500 });
      await this.cdp.ensure();
    } catch (e) {
      this.cdp.close();
      return { ...base, connected: false, scope: "offline", reason: e.message };
    }
    const scope = this.cdp.scope;
    const snapshot = scope === "game" ? await this.cdp.call(engine.snapshot).catch(() => null) : null;
    return { ...base, connected: true, scope, url: this.cdp.target.url, snapshot };
  }

  async requireGame() {
    await this.cdp.ensure().catch((e) => { throw new BenchError(`not connected: ${e.message}`, 503); });
    if (this.cdp.scope !== "game") throw new BenchError(`needs a loaded game; the debugger is on the ${this.cdp.scope} page`, 409);
  }

  async catalogs() {
    await this.requireGame();
    // Mods add rows, so the cache is only good for one loaded game.
    if (this.catalogCache?.url !== this.cdp.target.url) {
      this.catalogCache = { url: this.cdp.target.url, data: await this.cdp.call(engine.catalogs, {}, { timeoutMs: 20000 }) };
    }
    return this.catalogCache.data;
  }

  async plot(x, y) {
    await this.requireGame();
    return this.cdp.call(engine.plotInfo, { x, y });
  }

  async cursor() {
    await this.requireGame();
    return this.cdp.call(engine.cursorPlot);
  }

  async turn() {
    return this.cdp.call(() => Game.turn).catch(() => null);
  }

  async eval(code, { depth = 3 } = {}) {
    await this.cdp.ensure().catch((e) => { throw new BenchError(`not connected: ${e.message}`, 503); });
    const t0 = Date.now();
    let value;
    let error = null;
    try {
      value = await this.cdp.call(engine.consoleEval, { code, depth });
    } catch (e) {
      error = e.message;
    }
    this.log({ kind: "eval", scope: this.cdp.scope, request: { code }, result: error ? { error } : { preview: preview(value) }, ms: Date.now() - t0 });
    if (error) throw new BenchError(error);
    return value;
  }

  async sql(sql, { limit = 500 } = {}) {
    await this.requireGame();
    let out;
    try {
      out = await this.cdp.call(engine.runSql, { sql, limit }, { timeoutMs: 30000 });
    } catch (e) {
      this.log({ kind: "sql", request: { sql }, result: { error: e.message } });
      throw new BenchError(e.message);
    }
    this.log({ kind: "sql", request: { sql }, result: { total: out.total, truncated: out.truncated } });
    return out;
  }

  async write(request, { waitMs = 3000, undoOf = null } = {}) {
    const problem = validateRequest(request);
    if (problem) throw new BenchError(problem);
    if (!this.armed) throw new BenchError("writes are disarmed; arm them first (this changes the running game)", 423);
    await this.requireGame();
    const turn = await this.turn();
    const result = await this.cdp.call(engine.performWrite, { ...request, waitMs }, { timeoutMs: waitMs + 15000 });
    const hints = hintsFor(request, result);
    const entry = this.log({ kind: undoOf ? "undo" : "write", turn, request, result, hints, ...(undoOf ? { undoOf } : {}) });
    return { ...result, id: entry.id, ts: entry.ts, hints, snippet: snippetFor(request), description: describeRequest(request) };
  }

  // The undo history is the evidence log itself, so it survives restarts and is shared by the CLI
  // and the server. A write is undoable once it LANDED with an inverse and no landed undo names it.
  undoable(date = localDate()) {
    const entries = this.evidence.read(date);
    const done = new Set(entries
      .filter((e) => e.kind === "undo" && ["LANDED", "ALREADY"].includes(e.result?.verdict))
      .map((e) => e.undoOf));
    // Older entries have no id; their timestamp stands in.
    return entries.filter((e) => e.kind === "write" && ["LANDED", "UNEXPECTED"].includes(e.result?.verdict) && e.result.inverse && !done.has(e.id ?? e.ts));
  }

  async undo() {
    const last = this.undoable().at(-1);
    if (!last) throw new BenchError("nothing to undo today");
    const result = await this.write(last.result.inverse, { undoOf: last.id ?? last.ts });
    return { undid: describeRequest(last.request), ...result };
  }

  async liveWorld() {
    await this.requireGame();
    return this.cdp.call(engine.worldSnapshot, {}, { timeoutMs: 60000 });
  }

  async snapshot(label) {
    const snap = await this.liveWorld();
    const name = this.snapshots.save(label ?? `turn${snap.turn}-${Date.now().toString(36)}`, snap);
    return { label: name, turn: snap.turn, size: `${snap.w}x${snap.h}`, units: snap.units.length, settlements: snap.cities.length };
  }

  async diff(a, b = "now") {
    if (!a) throw new BenchError("which snapshot to diff from?");
    let A;
    let B;
    try {
      A = this.snapshots.load(a);
      B = b === "now" ? null : this.snapshots.load(b);
    } catch (e) {
      throw new BenchError(e.message, 404);
    }
    B ??= await this.liveWorld();
    let diff;
    try { diff = diffWorlds(A, B); } catch (e) { throw new BenchError(e.message); }
    return { diff, text: describeDiff(diff, B) };
  }

  async lint(scope) {
    await this.cdp.ensure().catch((e) => { throw new BenchError(`not connected: ${e.message}`, 503); });
    return this.cdp.call(engine.lintUi, { scope: scope ?? null, max: 20000 }, { timeoutMs: 60000 });
  }

  async sampleWatches({ record = true } = {}) {
    await this.requireGame();
    const defs = this.watches.defs();
    if (!defs.watches.length && !defs.invariants.length) return null;
    const sample = await this.cdp.call(engine.sampleWatches, defs, { timeoutMs: 30000 });
    if (record) this.watches.record(sample);
    for (const v of violations(sample)) {
      this.log({ kind: "invariant", turn: sample.turn, request: { name: v.name }, result: { verdict: "VIOLATED", detail: v.detail } });
    }
    this.emit("sample", sample);
    return sample;
  }

  // Copies a mod's changed files into the copy the game loads, then proves it: a stamp on the page
  // shows whether the page reloaded, and the bytes the game now serves are compared with the source.
  async deploy(srcDir, { yes = false, waitMs = 10000, reload = true } = {}) {
    if (!srcDir) throw new BenchError("which mod folder?");
    let plan;
    try { plan = planDeploy(path.resolve(srcDir), this.paths, readMods(this.paths.modsDb)); } catch (e) { throw new BenchError(e.message); }
    if (plan.refuse || plan.inPlace || !plan.changes.length || !yes) return { plan, applied: false };
    const stamp = Math.random().toString(36).slice(2);
    const connected = await this.cdp.ensure().then(() => this.cdp.call(engine.stampPage, { stamp })).then(() => true, () => false);
    applyDeploy(plan);
    // UIFileWatcher does not reload the page for a changed UIScript (watched 2026-09-26); UI.reloadUI()
    // does, in place, keeping the game's turn. Without it the copied code would sit on disk unused.
    if (reload && connected && this.cdp.scope === "game" && plan.changes.some((c) => c.ui)) {
      await this.cdp.call(() => { UI.reloadUI(); return true; }).catch(() => null);
    }
    const result = { plan, applied: true, connected, reloaded: null, files: plan.changes.map((c) => ({ rel: c.rel, state: c.state, live: c.ui ? "UNCHECKED" : "NEEDS A NEW GAME" })) };
    if (connected) {
      const ui = plan.changes.filter((c) => c.ui);
      let served = {};
      const t0 = Date.now();
      while (Date.now() - t0 < waitMs) {
        await sleep(800);
        const present = await this.cdp.call(engine.stampPresent, { stamp }).catch(() => null);
        if (present === false) result.reloaded = true;
        else if (present === true) result.reloaded = false;
        if (ui.length) served = await this.cdp.call(engine.readServed, { modId: plan.modId, files: ui.map((c) => c.rel) }).catch(() => served);
        if (result.reloaded && ui.every((c) => served[c.rel]?.hash === c.hash)) break;
      }
      for (const f of result.files) {
        const c = plan.changes.find((x) => x.rel === f.rel);
        if (!c.ui) continue;
        const s = served[c.rel];
        f.live = s?.hash === c.hash ? "SERVED" : s?.error ? `UNREADABLE (${s.error})` : s ? "STALE" : "UNREADABLE";
      }
    }
    this.log({ kind: "deploy", request: { srcDir: plan.srcDir, modId: plan.modId }, result: { reloaded: result.reloaded, files: result.files } });
    return result;
  }

  // Copies nothing: compares what the game serves for every declared UI file with the source. The
  // check to run after a mod's own deploy script, or whenever "is my edit live?" is the question.
  async prove(srcDir) {
    if (!srcDir) throw new BenchError("which mod folder?");
    let plan;
    try { plan = planDeploy(path.resolve(srcDir), this.paths, readMods(this.paths.modsDb)); } catch (e) { throw new BenchError(e.message); }
    await this.cdp.ensure().catch((e) => { throw new BenchError(`not connected: ${e.message}`, 503); });
    const served = await this.cdp.call(engine.readServed, { modId: plan.modId, files: plan.uiFiles.map((f) => f.rel) }, { timeoutMs: 30000 });
    const files = plan.uiFiles.map((f) => {
      const s = served[f.rel];
      return { rel: f.rel, live: s?.hash === f.hash ? "SERVED" : s?.error ? `UNREADABLE (${s.error})` : "STALE" };
    });
    const result = { modId: plan.modId, liveLabel: plan.liveLabel ?? null, refuse: plan.refuse ?? null, files };
    this.log({ kind: "prove", request: { srcDir: plan.srcDir, modId: plan.modId }, result: { stale: files.filter((f) => f.live !== "SERVED").map((f) => f.rel), total: files.length } });
    return result;
  }

  close() {
    this.events.stop();
    this.cdp.close();
  }
}
