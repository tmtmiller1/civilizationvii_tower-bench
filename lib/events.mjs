import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import * as engine from "./engine.mjs";
import { canvasCounter } from "./engine-canvas.mjs";
import { localDate } from "./evidence.mjs";

export const AGENT_ID = "tower-bench-agent";

// The 269 gameplay events the engine declares. UI events (UnitSelectionChanged, BeforeUnload and
// the like) are valid too; they just are not in this table.
export function eventCatalogue(paths) {
  const file = paths.install && path.join(paths.install, "Contents", "Resources", "Base", "modules", "core", "data", "gamecore-events.xml");
  try {
    return [...fs.readFileSync(file, "utf8").matchAll(/<Row\s+Name="([^"]+)"/g)].map((m) => m[1]).sort();
  } catch {
    return [];
  }
}

// Reads an event back from a UI.log line the bridge wrote. A line clipped at the log's ~1,000
// characters still yields its identity, which is all de-duplication needs.
export function parseLogEvent(line) {
  const i = line.indexOf("[TB-EVENT] ");
  if (i < 0) return null;
  const raw = line.slice(i + 11).trim();
  try {
    return JSON.parse(raw);
  } catch {
    const bid = raw.match(/"bid":"([^"]+)"/)?.[1];
    const seq = Number(raw.match(/"seq":(\d+)/)?.[1]);
    const name = raw.match(/"name":"([^"]+)"/)?.[1];
    return bid && seq && name ? { bid, seq, name, clipped: true } : null;
  }
}

export function describeEvent(e) {
  const names = e.names ? Object.entries(e.names).map(([k, v]) => `${k}=${v}`).join(" ") : "";
  const data = e.data === undefined ? "" : JSON.stringify(e.data);
  return `${e.turn != null ? `[turn ${e.turn}] ` : ""}${e.name}${names ? `  ${names}` : ""}${data && data !== "null" ? `  ${data.slice(0, 300)}` : ""}`;
}

export function compileMatch(match) {
  if (!match) return () => true;
  // Recipes are the user's own test code, evaluated here the way a probe script would be.
  return new Function("e", `return (${match});`);
}

export class EventBridge extends EventEmitter {
  // agentActive: whether the agent is installed with events to record. Asked of the files, not the
  // page, because the bench's poll can reach a new page a moment before the agent's script runs.
  constructor(cdp, dir, { agentActive = /** @type {() => boolean} */ (() => false) } = {}) {
    super();
    this.cdp = cdp;
    this.dir = dir;
    this.agentActive = agentActive;
    this.wanted = new Set();
    this.log = false;
    this.page = null;
    this.since = 0;
    this.seen = new Set();
    this.history = [];
    this.timer = null;
    this.busy = false;
  }

  get subscriptions() {
    return [...this.wanted];
  }

  state() {
    return {
      subscriptions: this.subscriptions, log: this.log, page: this.page, polling: !!this.timer,
      received: this.history.length,
    };
  }

  async set(names, /** @type {{ log?: boolean }} */ { log } = {}) {
    this.wanted = new Set(names);
    if (log !== undefined) this.log = !!log;
    await this.cdp.ensure();
    const info = await this.cdp.call(engine.bridge, { op: "sync", names: this.subscriptions, log: this.log });
    if (this.page && info.id !== this.page) this.gap(info);
    this.page ??= info.id;
    if (this.wanted.size) this.start(); else this.stop();
    return info;
  }

  gap(info) {
    const g = {
      at: new Date().toISOString(),
      from: this.page,
      to: info.id,
      note: info.agent || this.agentActive()
        ? "the page reloaded. The agent records on every page and writes each event to UI.log, which serve reads back, so nothing is lost"
        : "the page reloaded; events between the old page's last read and this re-attach were not seen (install the agent to close this)",
    };
    this.emit("gap", g);
    this.record({ gap: g });
  }

  accept(e, via) {
    if (!e?.bid || !e.seq) return false;
    const key = `${e.bid}:${e.seq}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 50000) this.seen = new Set([...this.seen].slice(-25000));
    const full = { ...e, via };
    this.history.push(full);
    if (this.history.length > 20000) this.history.splice(0, 10000);
    this.record(full);
    this.emit("event", full);
    return true;
  }

  // Also fed from the log tail: with log on (always, in the agent) UI.log holds every event, so one
  // recorded just before a reload or a crash is not lost with the page.
  ingestLogLine(text) {
    const e = parseLogEvent(text);
    return e ? this.accept(e, "log") : false;
  }

  record(obj) {
    if (!this.dir) return;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(path.join(this.dir, `${localDate()}.jsonl`), JSON.stringify(obj) + "\n");
  }

  async poll() {
    if (this.busy || !this.wanted.size) return;
    this.busy = true;
    try {
      await this.cdp.ensure();
      if (this.cdp.scope === "offline") return;
      for (let round = 0; round < 10; round++) {
        const r = await this.cdp.call(engine.bridge, {
          op: "drain", names: this.subscriptions, since: this.since, expect: this.page, log: this.log,
        });
        if (this.ingestDrain(r) < 2000) break;
      }
    } catch {
      /* the page is mid-reload or the game is busy; the next tick re-attaches */
    } finally {
      this.busy = false;
    }
  }

  ingestDrain(r) {
    const changed = this.page && r.id !== this.page;
    if (changed) this.gap(r);
    if (changed || !this.page) this.since = 0;
    this.page = r.id;
    if (r.dropped) this.emit("dropped", { count: r.dropped, page: r.id });
    for (const e of r.events) this.accept(e, "live");
    if (r.events.length) this.since = r.events.at(-1).seq;
    return r.events.length;
  }

  start(intervalMs = 600) {
    if (!this.timer) this.timer = setInterval(() => this.poll(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Resolves with the first event at or after history index `from` that matches, or, with
  // none: true, succeeds only if no match arrives before the timeout.
  waitFor({ event, match, timeoutMs = 60000, none = false, from = 0 }) {
    const test = compileMatch(match);
    const hit = (e) => e.name === event && (() => { try { return !!test(e); } catch { return false; } })();
    const found = (event, index) => ({ ok: !none, event, index });
    const quiet = () => (none
      ? { ok: true, index: this.history.length }
      : { ok: false, timedOut: true, index: this.history.length });
    return new Promise((resolve) => {
      const idx = this.history.findIndex((e, i) => i >= from && hit(e));
      if (idx >= 0) return resolve(found(this.history[idx], idx));
      const onEvent = (e) => {
        if (!hit(e)) return;
        cleanup();
        resolve(found(e, this.history.lastIndexOf(e)));
      };
      const timer = setTimeout(() => { cleanup(); resolve(quiet()); }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.off("event", onEvent); };
      this.on("event", onEvent);
    });
  }
}

// The agent: the bridge as a permanent UIScript, so events are recorded from page load and through
// reloads and age transitions, and written to UI.log so a crash does not take them with it. It is
// inert while its list is empty, which matters because an installed mod loads into every game.
export function agentModinfo() {
  return `<?xml version="1.0" encoding="utf-8"?>
<Mod id="${AGENT_ID}" version="1" xmlns="ModInfo">
    <Properties>
        <Name>Tower Bench Agent (dev)</Name>
        <Description>Development tool. Records chosen engine events from page load for tower-bench. Does nothing while its event list is empty. Not for release.</Description>
        <Authors>Tower</Authors>
        <Package>TowerBenchAgent</Package>
        <PackageSortIndex>9999</PackageSortIndex>
        <Version>0.1.0</Version>
        <AffectsSavedGames>0</AffectsSavedGames>
    </Properties>
    <Dependencies>
        <Mod id="base-standard" title="LOC_MODULE_BASE_STANDARD_NAME" />
    </Dependencies>
    <ActionCriteria>
        <Criteria id="always"><AlwaysMet></AlwaysMet></Criteria>
    </ActionCriteria>
    <ActionGroups>
        <ActionGroup id="tower-bench-agent-game" scope="game" criteria="always">
            <Properties><LoadOrder>1</LoadOrder></Properties>
            <Actions>
                <UIScripts><Item>ui/agent-game.js</Item></UIScripts>
            </Actions>
        </ActionGroup>
    </ActionGroups>
</Mod>
`;
}

export function agentScript(names, canvas = false) {
  return `// Tower Bench agent, generated by tools/tower-bench ("agent set" rewrites this file).
// Records the events below from page load, through reloads and age transitions, into UI.log, and with
// COUNT_CANVAS counts canvas paint calls from page load. Inert while the list is empty and counting is off.
const SUBSCRIBE = ${JSON.stringify(names)};
const COUNT_CANVAS = ${canvas ? "true" : "false"};
const bridge = ${engine.bridge.toString()};
const canvasCounter = ${canvasCounter.toString()};
if (SUBSCRIBE.length) {
  const info = bridge({ op: "sync", names: SUBSCRIBE, pin: true });
  console.error(\`[TB-BRIDGE] \${info.id} agent attached at load, subscribed to \${SUBSCRIBE.join(", ")}\`);
}
if (COUNT_CANVAS) canvasCounter({ op: "install", logEvery: 1000 });
`;
}

export function agentStatus(paths) {
  const dir = path.join(paths.userMods, AGENT_ID);
  const script = path.join(dir, "ui", "agent-game.js");
  if (!fs.existsSync(script)) return { installed: false, dir };
  const src = fs.readFileSync(script, "utf8");
  const m = src.match(/^const SUBSCRIBE = (\[.*\]);$/m);
  return { installed: true, dir, subscriptions: m ? JSON.parse(m[1]) : null, canvas: /^const COUNT_CANVAS = true;$/m.test(src) };
}

// Writes only inside the agent's own folder. The game registers a new mod at its next launch.
export function writeAgent(paths, names, canvas = agentStatus(paths).canvas ?? false) {
  const dir = path.join(paths.userMods, AGENT_ID);
  fs.mkdirSync(path.join(dir, "ui"), { recursive: true });
  fs.writeFileSync(path.join(dir, `${AGENT_ID}.modinfo`), agentModinfo());
  fs.writeFileSync(path.join(dir, "ui", "agent-game.js"), agentScript(names, canvas));
  return dir;
}
