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

export function startServer(bench, { port = 4380 } = {}) {
  const clients = new Set();
  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  bench.on("evidence", (e) => broadcast("evidence", e));
  bench.events.on("event", (e) => broadcast("game-event", e));
  bench.events.on("gap", (g) => broadcast("event-gap", g));
  bench.events.on("dropped", (d) => broadcast("event-gap", { at: new Date().toISOString(), note: `${d.count} event(s) fell out of the page buffer before they were read` }));

  const tail = new LogTail(bench.paths.logs);
  tail.seekToEnd();
  const tailTimer = setInterval(() => {
    const lines = tail.poll();
    for (const l of lines) if (l.text.includes("[TB-EVENT] ")) bench.events.ingestLogLine(l.text);
    if (lines.length && clients.size) broadcast("log", lines);
  }, 700);

  const routes = {
    "GET /api/status": () => bench.status(),
    "GET /api/catalogs": () => bench.catalogs(),
    "GET /api/cursor": () => bench.cursor(),
    "GET /api/plot": (_, q) => bench.plot(int(q.get("x")), int(q.get("y"))),
    "POST /api/eval": async (req) => ({ value: await bench.eval((await body(req)).code ?? "", { depth: 3 }) }),
    "POST /api/sql": async (req) => {
      const b = await body(req);
      return bench.sql(b.sql ?? "", { limit: b.limit ?? 500 });
    },
    "POST /api/write": async (req) => {
      const b = await body(req);
      return bench.write({ op: b.op, args: b.args }, { waitMs: b.waitMs ?? 3000 });
    },
    "POST /api/undo": () => bench.undo(),
    "POST /api/arm": async (req) => {
      bench.armed = !!(await body(req)).armed;
      return { armed: bench.armed };
    },
    "GET /api/mods": () => modHealth(readMods(bench.paths.modsDb), bench.paths),
    "GET /api/logs/recent": (_, q) => readRecent(bench.paths.logs, undefined, int(q.get("bytes")) || 128 * 1024),
    "GET /api/evidence": (_, q) => {
      const entries = bench.evidence.read(q.get("date") ?? localDate());
      return q.get("format") === "md" ? { markdown: toMarkdown(entries) } : entries;
    },
    "GET /api/world": () => bench.liveWorld(),
    "GET /api/snapshots": () => bench.snapshots.list(),
    "POST /api/snapshot": async (req) => bench.snapshot((await body(req)).label || undefined),
    "GET /api/diff": (_, q) => bench.diff(q.get("a"), q.get("b") || "now"),
    "GET /api/lint": (_, q) => bench.lint(q.get("scope") || null),
    "GET /api/watches": () => ({ ...bench.watches.defs(), series: bench.watches.series() }),
    "POST /api/watches": async (req) => {
      const b = await body(req);
      return bench.watches.add(b.kind, b.name, b.expr);
    },
    "POST /api/watches/remove": async (req) => bench.watches.remove((await body(req)).name),
    "POST /api/watches/sample": () => bench.sampleWatches(),
    "GET /api/deploy": (_, q) => bench.deploy(q.get("dir"), { yes: false }),
    "POST /api/deploy": async (req) => bench.deploy((await body(req)).dir, { yes: true }),
    "GET /api/prove": (_, q) => bench.prove(q.get("dir")),
    "GET /api/bridge/catalogue": () => eventCatalogue(bench.paths),
    "GET /api/bridge/state": () => ({ ...bench.events.state(), agent: agentStatus(bench.paths) }),
    "POST /api/bridge/subscribe": async (req) => {
      const b = await body(req);
      await bench.events.set(Array.isArray(b.names) ? b.names : [], { log: b.log })
        .catch((e) => { throw new BenchError(`not connected to the game: ${e.message}`, 503); });
      return bench.events.state();
    },
    "GET /api/bridge/recent": (_, q) => bench.events.history.slice(-(int(q.get("n")) || 300)),
  };

  // Samples watches and invariants once per turn, whether or not a browser is open, so a long
  // unattended session still records its series and its invariant violations.
  let lastTurn = null;
  let sampling = false;
  const samplerTimer = setInterval(async () => {
    if (sampling) return;
    const defs = bench.watches.defs();
    if (!defs.watches.length && !defs.invariants.length) return;
    sampling = true;
    try {
      await bench.cdp.ensure();
      if (bench.cdp.scope !== "game") return;
      const turn = await bench.cdp.call(() => Game.turn);
      if (turn == null || turn === lastTurn) return;
      lastTurn = turn;
      const s = await bench.sampleWatches();
      if (s) broadcast("sample", s);
    } catch { /* game not reachable this tick */ } finally {
      sampling = false;
    }
  }, 5000);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    // Refuse other hostnames (DNS rebinding) and cross-site writes: a page in your browser must not
    // be able to reach the running game through this server.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "")) return send(res, 403, { error: "forbidden host" });
    if (req.method === "POST" && req.headers["x-tower-bench"] !== "1") return send(res, 403, { error: "missing X-Tower-Bench header" });

    const file = req.method === "GET" ? UI_FILES[url.pathname] : undefined;
    if (file) return send(res, 200, fs.readFileSync(path.join(UI_DIR, file[0]), "utf8"), file[1]);
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return undefined;
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return send(res, 404, { error: "not found" });
    try {
      return send(res, 200, (await handler(req, url.searchParams)) ?? null);
    } catch (e) {
      // Everything here is a local tool call, so any failure is reported with its message.
      return send(res, e instanceof BenchError ? e.status : 400, { error: e.message });
    }
  });

  server.on("close", () => { clearInterval(tailTimer); clearInterval(samplerTimer); });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
