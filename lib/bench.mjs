/* global Game, UI */
import { EventEmitter } from "node:events";
import { achievementsRefusal } from "./achievements.mjs";
import path from "node:path";
import { CdpSession, listTargets } from "./cdp.mjs";
import { applyDeploy, planDeploy } from "./deploy.mjs";
import * as engine from "./engine.mjs";
import { EvidenceLog, localDate } from "./evidence.mjs";
import { EventBridge, agentStatus } from "./events.mjs";
import fs from "node:fs";
import { gamePid } from "./lab.mjs";
import { modHealth, planModChange, readFlags, readMods, sourceOf, writeFlags } from "./mods.mjs";
import { gameVersion } from "./paths.mjs";
import { WatchStore, violations } from "./watches.mjs";
import { SnapshotStore, describeDiff, diffWorlds } from "./world.mjs";
import { describeRequest, hintsFor, snippetFor, validateRequest } from "./writes.mjs";
import { techniqueIds } from "./techniques.mjs";
import { registryInfo } from "./engine-registry.mjs";
import { compareActive, overridden } from "./registry.mjs";
import { canvasCandidates, canvasCounter, canvasPaint } from "./engine-canvas.mjs";
import { scanGlyphs } from "./engine-l10n.mjs";
import { judgeCandidates, readMetrics, runCanvasStress } from "./canvas.mjs";

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

/** "single", "multi", or null when the engine's answer to multiplayerFlags cannot be read. */
function gameKind(f) {
  const flags = [f?.any, f?.network, f?.hotseat];
  if (flags.some((v) => v === true)) return "multi";
  return flags.every((v) => v === false) ? "single" : null;
}

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
    this.gamePid = gamePid;
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

  // Tower Bench is for single-player test games. A change to a multiplayer game (network or hotseat) is refused, and
  // so is one when the engine cannot say which kind of game it is.
  async refuseMultiplayer() {
    const f = await this.cdp.call(engine.multiplayerFlags).catch((e) => ({ error: messageOf(e) }));
    const kind = gameKind(f);
    if (kind === "single") return;
    const why = kind === "multi" ? "this is a multiplayer game"
      : `cannot tell whether this is a multiplayer game (${f?.error ?? "the engine gave no answer"})`;
    throw new BenchError(`refused: ${why}. Tower Bench changes single-player games only.`, 409);
  }

  // Nor one that can earn achievements: see lib/achievements.mjs.
  async refuseUnlessTestGame() {
    await this.refuseMultiplayer();
    const why = this.achievementsRefusal();
    if (why) throw new BenchError(`refused: ${why}.`, 409);
  }

  achievementsRefusal() {
    return achievementsRefusal(this.paths, { pid: gamePid() });
  }

  async eval(code, { depth = 3 } = {}) {
    await this.requireConnection();
    // The console can change anything, so in a game it is held to the same rule as a write.
    if (this.cdp.scope === "game") await this.refuseUnlessTestGame();
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
    await this.refuseUnlessTestGame();
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
    return entries.filter((e) => ["write", "mods"].includes(e.kind) && ["LANDED", "UNEXPECTED"].includes(e.result?.verdict)
      && e.result.inverse && !done.has(e.id ?? e.ts));
  }

  // The newest landed change today that has not been undone, undoable or not.
  newestChange(date = localDate()) {
    const entries = this.evidence.read(date);
    const done = new Set(entries
      .filter((e) => e.kind === "undo" && ["LANDED", "ALREADY"].includes(e.result?.verdict))
      .map((e) => e.undoOf));
    return entries.filter((e) => ["write", "mods"].includes(e.kind) && ["LANDED", "UNEXPECTED"].includes(e.result?.verdict)
      && !done.has(e.id ?? e.ts)).at(-1) ?? null;
  }

  // Undo reverts the newest change. When that change has no inverse (research completed, a unit promoted), it
  // refuses rather than quietly reverting an older one, unless asked to skip past it.
  async undo({ skip = false } = {}) {
    const last = this.undoable().at(-1);
    if (!skip) this.refuseNotUndoable(last);
    if (!last) throw new BenchError("nothing to undo today");
    const undoOf = last.id ?? last.ts;
    if (last.kind === "mods") return { undid: last.result.description, ...this.setFlags(last.result.inverse, { undoOf }) };
    const result = await this.write(last.result.inverse, { undoOf });
    return { undid: describeRequest(last.request), ...result };
  }

  refuseNotUndoable(last) {
    const newest = this.newestChange();
    if (!newest || newest.result?.inverse) return;
    const older = last ? `; undo with skip reverts the one before it instead: ${describeRequest(last.request)}` : "";
    throw new BenchError(`the newest change today, ${describeRequest(newest.request)}, cannot be undone${older}`, 409);
  }

  // Mods.sqlite is the game's registry, read when it launches, so it is only changed while the game is
  // closed and no lab run is holding a backup of it that its restore would write back.
  registryRefusal() {
    if (!this.armed) return "writes are disarmed; arm them first (this changes which mods the game loads)";
    if (this.gamePid()) return "the game is running; it reads the mod list at launch, so quit it first";
    const labRun = path.join(path.dirname(this.paths.evidence), "runs", "current.json");
    if (fs.existsSync(labRun)) return "a lab run is in progress and will restore the registry; run lab stop first";
    return null;
  }

  // Switches mods on or off in the registry, verified by reading the flags back, logged as evidence and
  // undoable like a map write. Takes effect at the next launch.
  setMods(request) {
    const refused = this.registryRefusal();
    if (refused) throw new BenchError(refused, 423);
    const plan = planModChange(modHealth(readMods(this.paths.modsDb), this.paths), request);
    if (plan.refuse) throw new BenchError(plan.refuse);
    const description = `${request.op} ${request.id}${request.copy ? ` (${request.copy})` : ""}`;
    if (!plan.changes?.length) return this.logMods(request, { verdict: "ALREADY", description, changes: [] });
    return this.setFlags(plan.changes.map((c) => ({ path: c.path, label: c.label, from: c.from, disabled: c.to })),
      { request, description });
  }

  setFlags(flags, { request = { op: "restore" }, description = "restore mod flags", undoOf = null } = {}) {
    if (undoOf) {
      const refused = this.registryRefusal();
      if (refused) throw new BenchError(refused, 423);
    }
    const before = readFlags(this.paths.modsDb, flags.map((f) => f.path));
    writeFlags(this.paths.modsDb, flags);
    const after = readFlags(this.paths.modsDb, flags.map((f) => f.path));
    const norm = (v) => (v === null || v === undefined ? null : Number(v));
    const landed = flags.every((f) => norm(after.get(f.path)) === norm(f.disabled));
    const changes = flags.map((f) => ({
      path: f.path, label: f.label, from: before.get(f.path) ?? null, to: after.get(f.path) ?? null,
    }));
    const inverse = changes.map((c) => ({ path: c.path, label: c.label, disabled: c.from }));
    return this.logMods(request, { verdict: landed ? "LANDED" : "NO EFFECT", description, changes, inverse }, undoOf);
  }

  logMods(request, result, undoOf = null) {
    const entry = this.log({ kind: undoOf ? "undo" : "mods", request, result, ...(undoOf ? { undoOf } : {}) });
    return { ...result, id: entry.id, ts: entry.ts, note: "takes effect the next time the game starts" };
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
    const r = await this.cdp.call(engine.lintUi, { scope: scope ?? null, max: 20000 }, { timeoutMs: 60000 });
    // Text that draws as boxes (a missing glyph, or CJK text under a font list without a CJK face).
    const glyphArgs = { scope: scope ?? null, max: 20000 };
    const glyphs = r?.issues
      ? await this.cdp.call(scanGlyphs, glyphArgs, { timeoutMs: 60000 }).catch(() => null) : null;
    if (glyphs?.issues) r.issues.push(...glyphs.issues);
    for (const i of r?.issues ?? []) i.techniques = techniqueIds(`lint:${i.rule}`);
    return r;
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
      const plan = planDeploy(path.resolve(srcDir), this.paths, readMods(this.paths.modsDb));
      const key = plan.refuseRule ? `deploy:${plan.refuseRule}` : "deploy:reload";
      return { ...plan, techniques: techniqueIds(key) };
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
    const result = {
      modId: plan.modId, liveLabel: plan.liveLabel ?? null, refuse: plan.refuse ?? null,
      techniques: plan.techniques, files,
    };
    const stale = files.filter((f) => f.live !== "SERVED").map((f) => f.rel);
    this.log({ kind: "prove", request: { srcDir: plan.srcDir, modId: plan.modId }, result: { stale, total: files.length } });
    return result;
  }

  // What actually won in the running game: component definitions and registrations, and the mods this
  // game applied against the ones the next launch will load.
  async registry() {
    await this.requireConnection();
    const info = await this.cdp.call(registryInfo, {}, { timeoutMs: 20000 });
    const rows = readMods(this.paths.modsDb);
    const active = info.activeMods
      ? compareActive(info.activeMods, rows, (r) => sourceOf(r.path, this.paths).kind === "official")
      : null;
    return { scope: this.cdp.scope, apis: info.apis, ...overridden(info), active,
      totals: { controls: info.controls?.length ?? null, components: info.components?.length ?? null } };
  }

  // Everything numeric the game exposes that might count the canvas pool: CDP metric domains, then
  // resource-like numbers on the engine's script objects.
  async canvasSample() {
    const sample = { ...(await this.cdp.call(canvasCandidates, {}, { timeoutMs: 20000 })).candidates };
    const domains = {};
    for (const [method, enable] of [["Performance.getMetrics", "Performance.enable"], ["Memory.getDOMCounters", null],
      ["Runtime.getHeapUsage", null]]) {
      try {
        if (enable) await this.cdp.send(enable, {}, 3000);
        const r = await readMetrics(this.cdp, method, 3000);
        Object.assign(sample, r.values);
        domains[method] = r.truncated ? "partial: the game cut the reply short" : true;
      } catch (e) {
        domains[method] = messageOf(e);
      }
    }
    return { sample, domains };
  }

  // Looks for a readable pool counter: sample, wait without painting (the control), sample, paint k calls,
  // sample. A counter moves by about one per call and not during the control.
  async canvasProbe({ k = 1000 } = {}) {
    await this.requireGame();
    const env = await this.cdp.call(canvasCandidates, {});
    const a = await this.canvasSample();
    await this.cdp.call(canvasPaint, { k: 0 });
    await sleep(500);
    const b = await this.canvasSample();
    await this.cdp.call(canvasPaint, { k }, { timeoutMs: 60000 });
    await sleep(500);
    const c = await this.canvasSample();
    const judged = judgeCandidates(a.sample, b.sample, c.sample, k);
    const result = { k, ...judged, candidates: Object.keys(c.sample).length, domains: c.domains,
      canvas2d: env.canvas2d, pixelApi: env.pixelApi };
    this.log({ kind: "canvas-probe", request: { k }, result: { verdict: judged.verdict, candidates: result.candidates } });
    return result;
  }

  async canvasCounter(op = "read") {
    await this.requireGame();
    return this.cdp.call(canvasCounter, { op });
  }

  // The crash test, for lab games only; see runCanvasStress.
  async canvasStress(opts = {}) {
    await this.requireGame();
    const lab = path.join(path.dirname(this.paths.evidence), "runs", "current.json");
    if (!fs.existsSync(lab)) {
      throw new BenchError("canvas stress crashes the game on purpose; run it in a lab game (lab start)", 423);
    }
    const result = await runCanvasStress(this, opts);
    this.log({ kind: "canvas-stress", request: opts, result });
    return result;
  }

  close() {
    this.events.stop();
    this.cdp.close();
  }
}
