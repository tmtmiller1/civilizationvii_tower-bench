/* global Game, UI */
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

// Database.query runs whatever it is given against the live gameplay database, so the console keeps to
// one read-only statement. A guard against slips, not a sandbox: the JS console can do anything.
const WRITE_WORDS = /\b(insert|update|delete|replace|drop|alter|create|attach|detach|vacuum|reindex|pragma)\b/i;
export function readOnlyRefusal(sql) {
  const text = String(sql ?? "").trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(text)) return "the SQL console runs SELECT (or WITH ... SELECT) only";
  const code = text.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "''");
  if (code.includes(";")) return "one statement at a time";
  if (/^with\b/i.test(text) && WRITE_WORDS.test(code)) return "the SQL console is read-only";
  return null;
}

export class BenchError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const messageOf = (e) => (e instanceof Error ? e.message : String(e));

const preview = (v, max = 2000) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > max ? `${s.slice(0, max)}...` : s;
};

function agentRecording(paths) {
  const a = agentStatus(paths);
  return a.installed && (a.subscriptions?.length ?? 0) > 0;
}

// deploy and prove disagree on a file the page returned nothing for, so each passes its own verdict.
function liveState(served, hash, absent) {
  if (served?.hash === hash) return "SERVED";
  if (served?.error) return `UNREADABLE (${served.error})`;
  return served ? "STALE" : absent;
}

const pendingChanges = (plan) => (plan.refuse || plan.inPlace ? [] : plan.changes ?? []);

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
    this.events = new EventBridge(this.cdp, path.join(root, "events"), { agentActive: () => agentRecording(paths) });
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
      return { ...base, connected: false, scope: "offline", reason: messageOf(e) };
    }
    const scope = this.cdp.scope;
    const snapshot = scope === "game" ? await this.cdp.call(engine.snapshot).catch(() => null) : null;
    return { ...base, connected: true, scope, url: this.cdp.target.url, snapshot };
  }

  async requireConnection() {
    await this.cdp.ensure().catch((e) => { throw new BenchError(`not connected: ${e.message}`, 503); });
  }

  async requireGame() {
    await this.requireConnection();
    if (this.cdp.scope !== "game") {
      throw new BenchError(`needs a loaded game; the debugger is on the ${this.cdp.scope} page`, 409);
    }
  }

  async catalogs() {
    await this.requireGame();
    // Mods add rows, so the cache is only good for one loaded game.
    let cache = this.catalogCache;
    if (cache?.url !== this.cdp.target.url) {
      cache = { url: this.cdp.target.url, data: await this.cdp.call(engine.catalogs, {}, { timeoutMs: 20000 }) };
      this.catalogCache = cache;
    }
    return cache.data;
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
    await this.requireConnection();
    const t0 = Date.now();
    let value;
    let error = null;
    try {
      value = await this.cdp.call(engine.consoleEval, { code, depth });
    } catch (e) {
      error = messageOf(e);
    }
    const result = error ? { error } : { preview: preview(value) };
    this.log({ kind: "eval", scope: this.cdp.scope, request: { code }, result, ms: Date.now() - t0 });
    if (error) throw new BenchError(error);
    return value;
  }

  async sql(sql, { limit = 500 } = {}) {
    const refused = readOnlyRefusal(sql);
    if (refused) throw new BenchError(refused);
    await this.requireGame();
    let out;
    try {
      out = await this.cdp.call(engine.runSql, { sql, limit }, { timeoutMs: 30000 });
    } catch (e) {
      this.log({ kind: "sql", request: { sql }, result: { error: messageOf(e) } });
      throw new BenchError(messageOf(e));
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
    const kind = undoOf ? "undo" : "write";
    const entry = this.log({ kind, turn, request, result, hints, ...(undoOf ? { undoOf } : {}) });
    return {
      ...result, id: entry.id, ts: entry.ts, hints, snippet: snippetFor(request), description: describeRequest(request),
    };
  }

  // The undo history is the evidence log itself, so it survives restarts and is shared by the CLI
  // and the server. A write is undoable once it LANDED with an inverse and no landed undo names it.
  undoable(date = localDate()) {
    const entries = this.evidence.read(date);
    const done = new Set(entries
      .filter((e) => e.kind === "undo" && ["LANDED", "ALREADY"].includes(e.result?.verdict))
      .map((e) => e.undoOf));
    // Older entries have no id; their timestamp stands in.
    return entries.filter((e) => e.kind === "write" && ["LANDED", "UNEXPECTED"].includes(e.result?.verdict)
      && e.result.inverse && !done.has(e.id ?? e.ts));
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
      throw new BenchError(messageOf(e), 404);
    }
    B ??= await this.liveWorld();
    let diff;
    try { diff = diffWorlds(A, B); } catch (e) { throw new BenchError(messageOf(e)); }
    return { diff, text: describeDiff(diff, B) };
  }

  async lint(scope) {
    await this.requireConnection();
    return this.cdp.call(engine.lintUi, { scope: scope ?? null, max: 20000 }, { timeoutMs: 60000 });
  }

  async sampleWatches({ record = true } = {}) {
    await this.requireGame();
    const defs = this.watches.defs();
    if (!defs.watches.length && !defs.invariants.length) return null;
    const sample = await this.cdp.call(engine.sampleWatches, defs, { timeoutMs: 30000 });
    if (record) this.watches.record(sample);
    for (const v of violations(sample)) {
      const result = { verdict: "VIOLATED", detail: v.detail };
      this.log({ kind: "invariant", turn: sample.turn, request: { name: v.name }, result });
    }
    this.emit("sample", sample);
    return sample;
  }

  planFor(srcDir) {
    if (!srcDir) throw new BenchError("which mod folder?");
    try {
      return planDeploy(path.resolve(srcDir), this.paths, readMods(this.paths.modsDb));
    } catch (e) {
      throw new BenchError(messageOf(e));
    }
  }

  // Copies a mod's changed files into the copy the game loads, then proves it: a stamp on the page
  // shows whether the page reloaded, and the bytes the game now serves are compared with the source.
  async deploy(srcDir, { yes = false, waitMs = 10000, reload = true } = {}) {
    const plan = this.planFor(srcDir);
    const changes = pendingChanges(plan);
    if (!changes.length || !yes) return { plan, applied: false };
    const stamp = Math.random().toString(36).slice(2);
    const connected = await this.cdp.ensure().then(() => this.cdp.call(engine.stampPage, { stamp }))
      .then(() => true, () => false);
    applyDeploy(plan);
    const files = changes.map((c) => ({ rel: c.rel, state: c.state, live: c.ui ? "UNCHECKED" : "NEEDS A NEW GAME" }));
    const reloaded = connected
      ? await this.confirmDeployed(plan.modId, changes, stamp, { reload, waitMs, files })
      : null;
    const result = { plan, applied: true, connected, reloaded, files };
    this.log({ kind: "deploy", request: { srcDir: plan.srcDir, modId: plan.modId }, result: { reloaded, files } });
    return result;
  }

  async confirmDeployed(modId, changes, stamp, { reload, waitMs, files }) {
    const ui = changes.filter((c) => c.ui);
    // UIFileWatcher does not reload the page for a changed UIScript (watched 2026-09-26); UI.reloadUI()
    // does, in place, keeping the game's turn. Without it the copied code would sit on disk unused.
    if (reload && this.cdp.scope === "game" && ui.length) {
      await this.cdp.call(() => { UI.reloadUI(); return true; }).catch(() => null);
    }
    const { reloaded, served } = await this.pollServed(modId, ui, stamp, waitMs);
    for (const f of files) {
      const c = ui.find((x) => x.rel === f.rel);
      if (c) f.live = liveState(served[c.rel], c.hash, "UNREADABLE");
    }
    return reloaded;
  }

  async pollServed(modId, ui, stamp, waitMs) {
    /** @type {boolean | null} */
    let reloaded = null;
    let served = {};
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      await sleep(800);
      const present = await this.cdp.call(engine.stampPresent, { stamp }).catch(() => null);
      if (typeof present === "boolean") reloaded = !present;
      if (ui.length) {
        served = await this.cdp.call(engine.readServed, { modId, files: ui.map((c) => c.rel) }).catch(() => served);
      }
      if (reloaded && ui.every((c) => served[c.rel]?.hash === c.hash)) break;
    }
    return { reloaded, served };
  }

  // Copies nothing: compares what the game serves for every declared UI file with the source. The
  // check to run after a mod's own deploy script, or whenever "is my edit live?" is the question.
  async prove(srcDir) {
    const plan = this.planFor(srcDir);
    await this.requireConnection();
    const args = { modId: plan.modId, files: plan.uiFiles.map((f) => f.rel) };
    const served = await this.cdp.call(engine.readServed, args, { timeoutMs: 30000 });
    const files = plan.uiFiles.map((f) => ({ rel: f.rel, live: liveState(served[f.rel], f.hash, "STALE") }));
    const result = { modId: plan.modId, liveLabel: plan.liveLabel ?? null, refuse: plan.refuse ?? null, files };
    const stale = files.filter((f) => f.live !== "SERVED").map((f) => f.rel);
    this.log({ kind: "prove", request: { srcDir: plan.srcDir, modId: plan.modId }, result: { stale, total: files.length } });
    return result;
  }

  close() {
    this.events.stop();
    this.cdp.close();
  }
}
