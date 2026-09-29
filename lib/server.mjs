/* global Game */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BenchError } from "./bench.mjs";
import { localDate, toMarkdown } from "./evidence.mjs";
import { agentStatus, eventCatalogue } from "./events.mjs";
import { LogTail, readRecent } from "./logs.mjs";
import { modHealth, readMods } from "./mods.mjs";

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");
// The only files served: the page and the scripts beside it, listed once at startup, so no request
// path ever reaches the filesystem.
const UI_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  ...Object.fromEntries(fs.readdirSync(UI_DIR).filter((f) => f.endsWith(".js"))
    .map((f) => [`/${f}`, [f, "text/javascript; charset=utf-8"]])),
};

async function body(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new BenchError("request body is not JSON");
  }
}

function send(res, status, data, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(data) : data);
}

const int = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));

async function subscribe(bench, req) {
  const b = await body(req);
  await bench.events.set(Array.isArray(b.names) ? b.names : [], { log: b.log })
    .catch((e) => { throw new BenchError(`not connected to the game: ${e.message}`, 503); });
  return bench.events.state();
}

function readEvidence(bench, q) {
  const entries = bench.evidence.read(q.get("date") ?? localDate());
  return q.get("format") === "md" ? { markdown: toMarkdown(entries) } : entries;
}

// Each handler is (bench, req, query).
const ROUTES = {
  "GET /api/status": (bench) => bench.status(),
  "GET /api/catalogs": (bench) => bench.catalogs(),
  "GET /api/cursor": (bench) => bench.cursor(),
  "GET /api/plot": (bench, _, q) => bench.plot(int(q.get("x")), int(q.get("y"))),
  "POST /api/eval": async (bench, req) => ({ value: await bench.eval((await body(req)).code ?? "", { depth: 3 }) }),
  "POST /api/sql": async (bench, req) => {
    const b = await body(req);
    return bench.sql(b.sql ?? "", { limit: b.limit ?? 500 });
  },
  "POST /api/write": async (bench, req) => {
    const b = await body(req);
    return bench.write({ op: b.op, args: b.args }, { waitMs: b.waitMs ?? 3000 });
  },
  "POST /api/undo": (bench) => bench.undo(),
  "POST /api/arm": async (bench, req) => {
    bench.armed = !!(await body(req)).armed;
    return { armed: bench.armed };
  },
  "GET /api/mods": (bench) => modHealth(readMods(bench.paths.modsDb), bench.paths),
  "GET /api/logs/recent": (bench, _, q) => readRecent(bench.paths.logs, undefined, int(q.get("bytes")) || 128 * 1024),
  "GET /api/evidence": (bench, _, q) => readEvidence(bench, q),
  "GET /api/world": (bench) => bench.liveWorld(),
  "GET /api/snapshots": (bench) => bench.snapshots.list(),
  "POST /api/snapshot": async (bench, req) => bench.snapshot((await body(req)).label || undefined),
  "GET /api/diff": (bench, _, q) => bench.diff(q.get("a"), q.get("b") || "now"),
  "GET /api/lint": (bench, _, q) => bench.lint(q.get("scope") || null),
  "GET /api/watches": (bench) => ({ ...bench.watches.defs(), series: bench.watches.series() }),
  "POST /api/watches": async (bench, req) => {
    const b = await body(req);
    return bench.watches.add(b.kind, b.name, b.expr);
  },
  "POST /api/watches/remove": async (bench, req) => bench.watches.remove((await body(req)).name),
  "POST /api/watches/sample": (bench) => bench.sampleWatches(),
  "GET /api/deploy": (bench, _, q) => bench.deploy(q.get("dir"), { yes: false }),
  "POST /api/deploy": async (bench, req) => bench.deploy((await body(req)).dir, { yes: true }),
  "GET /api/prove": (bench, _, q) => bench.prove(q.get("dir")),
  "GET /api/bridge/catalogue": (bench) => eventCatalogue(bench.paths),
  "GET /api/bridge/state": (bench) => ({ ...bench.events.state(), agent: agentStatus(bench.paths) }),
  "POST /api/bridge/subscribe": (bench, req) => subscribe(bench, req),
  "GET /api/bridge/recent": (bench, _, q) => bench.events.history.slice(-(int(q.get("n")) || 300)),
};

function createBroadcaster() {
  const clients = new Set();
  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  return { clients, broadcast };
}

function forwardBenchEvents(bench, broadcast) {
  bench.on("evidence", (e) => broadcast("evidence", e));
  bench.events.on("event", (e) => broadcast("game-event", e));
  bench.events.on("gap", (g) => broadcast("event-gap", g));
  bench.events.on("dropped", (d) => broadcast("event-gap", {
    at: new Date().toISOString(), note: `${d.count} event(s) fell out of the page buffer before they were read`,
  }));
}

function startLogTail(bench, { clients, broadcast }) {
  const tail = new LogTail(bench.paths.logs);
  tail.seekToEnd();
  return setInterval(() => {
    const lines = tail.poll();
    for (const l of lines) if (l.text.includes("[TB-EVENT] ")) bench.events.ingestLogLine(l.text);
    if (lines.length && clients.size) broadcast("log", lines);
  }, 700);
}

// Samples watches and invariants once per turn, whether or not a browser is open, so a long
// unattended session still records its series and its invariant violations.
function startSampler(bench, broadcast) {
  let lastTurn = null;
  let sampling = false;
  const tick = async () => {
    await bench.cdp.ensure();
    if (bench.cdp.scope !== "game") return;
    const turn = await bench.cdp.call(() => Game.turn);
    if (turn == null || turn === lastTurn) return;
    lastTurn = turn;
    const s = await bench.sampleWatches();
    if (s) broadcast("sample", s);
  };
  return setInterval(async () => {
    if (sampling) return;
    const defs = bench.watches.defs();
    if (!defs.watches.length && !defs.invariants.length) return;
    sampling = true;
    try {
      await tick();
    } catch { /* game not reachable this tick */ } finally {
      sampling = false;
    }
  }, 5000);
}

// Refuses other hostnames (DNS rebinding) and cross-site writes: a page in your browser must not be
// able to reach the running game through this server.
function refusal(req) {
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "")) return "forbidden host";
  if (req.method === "POST" && req.headers["x-tower-bench"] !== "1") return "missing X-Tower-Bench header";
  // Some GET routes do work in the game (a whole-map read, a lint walk), so a page elsewhere must not be
  // able to trigger them with an <img> tag. Browsers send Sec-Fetch-Site; the CLI and curl do not.
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return "cross-site request";
  return null;
}

function parseUrl(req) {
  try {
    return new URL(req.url ?? "/", `http://${req.headers.host}`);
  } catch {
    return null;
  }
}

function openEventStream(req, res, clients) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  res.write(": connected\n\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
}

async function callRoute(bench, req, res, url) {
  const handler = ROUTES[`${req.method} ${url.pathname}`];
  if (!handler) return send(res, 404, { error: "not found" });
  try {
    return send(res, 200, (await handler(bench, req, url.searchParams)) ?? null);
  } catch (e) {
    // Everything here is a local tool call, so any failure is reported with its message.
    return send(res, e instanceof BenchError ? e.status : 400, { error: e instanceof Error ? e.message : String(e) });
  }
}

function handle(bench, clients, req, res) {
  const refused = refusal(req);
  if (refused) return send(res, 403, { error: refused });
  const url = parseUrl(req);
  if (!url) return send(res, 400, { error: "bad request URL" });
  const file = req.method === "GET" ? UI_FILES[url.pathname] : undefined;
  if (file) return send(res, 200, fs.readFileSync(path.join(UI_DIR, file[0]), "utf8"), file[1]);
  if (req.method === "GET" && url.pathname === "/api/events") return openEventStream(req, res, clients);
  return callRoute(bench, req, res, url);
}

export function startServer(bench, { port = 4380 } = {}) {
  const events = createBroadcaster();
  forwardBenchEvents(bench, events.broadcast);
  const tailTimer = startLogTail(bench, events);
  const samplerTimer = startSampler(bench, events.broadcast);
  const server = http.createServer((req, res) => handle(bench, events.clients, req, res));
  server.on("close", () => { clearInterval(tailTimer); clearInterval(samplerTimer); });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
