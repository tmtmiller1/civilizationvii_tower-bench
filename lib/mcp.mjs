// The Model Context Protocol over stdio, with no dependencies: JSON-RPC 2.0, one message per line on
// stdin and stdout. stdout carries protocol messages only; anything else goes to stderr.
//
// Dual-era: a client that opens with `initialize` (2025-11-25 and earlier) gets the handshake it expects,
// and a request carrying `_meta["io.modelcontextprotocol/protocolVersion"]` (2026-07-28) is served on its
// own, with `server/discover` for clients that ask first.
import readline from "node:readline";

export const MODERN_VERSIONS = ["2026-07-28"];
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";

export const ERR = {
  parse: -32700, invalidRequest: -32600, noMethod: -32601, invalidParams: -32602, internal: -32603,
  notFound: -32002, version: -32022,
};

export class RpcError extends Error {
  /** @param {number} code @param {string} message @param {unknown} [data] */
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/**
 * @typedef {{ type: "text", text: string }} TextContent
 * @typedef {{ content: TextContent[], isError?: boolean }} ToolResult
 * @typedef {{ list(): object[], has(name: string): boolean,
 *   call(name: string, args: object): Promise<ToolResult> }} ToolTable
 * @typedef {{ uri: string, mimeType: string, text: string }} ResourceContents
 * @typedef {{ list(): object[], read(uri: string): ResourceContents | null }} ResourceTable
 * @typedef {{ tools: ToolTable, resources: ResourceTable, info: { name: string, version: string },
 *   instructions: string, write: (line: string) => void, log?: (line: string) => void }} ServerOptions
 */

const CAPABILITIES = { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } };

const errorMessage = (id, code, message, data) => ({
  jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) },
});

const isId = (v) => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

/** @type {Record<string, (s: McpServer, params: any) => unknown>} */
const METHODS = {
  initialize: (s, p) => {
    // Answer with the client's version when it is one this server speaks, else the newest handshake version.
    const protocolVersion = LEGACY_VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : LEGACY_VERSIONS[0];
    s.log(`initialize: client ${p.clientInfo?.name ?? "?"} asked ${p.protocolVersion ?? "?"}, using ${protocolVersion}`);
    return { protocolVersion, capabilities: CAPABILITIES, serverInfo: s.info, instructions: s.instructions };
  },
  "server/discover": (s) => ({
    supportedVersions: SUPPORTED_VERSIONS, capabilities: CAPABILITIES,
    _meta: { "io.modelcontextprotocol/serverInfo": s.info }, instructions: s.instructions,
  }),
  ping: () => ({}),
  "tools/list": (s) => ({ tools: s.tools.list() }),
  "tools/call": (s, p) => s.callTool(p),
  "resources/list": (s) => ({ resources: s.resources.list() }),
  "resources/templates/list": () => ({ resourceTemplates: [] }),
  "resources/read": (s, p) => {
    if (typeof p.uri !== "string") throw new RpcError(ERR.invalidParams, "resources/read needs a uri");
    const r = s.resources.read(p.uri);
    if (!r) throw new RpcError(ERR.notFound, "Resource not found", { uri: p.uri });
    return { contents: [r] };
  },
};

export class McpServer {
  /** @param {ServerOptions} opts */
  constructor({ tools, resources, info, instructions, write, log = () => {} }) {
    this.tools = tools;
    this.resources = resources;
    this.info = info;
    this.instructions = instructions;
    this.write = write;
    this.log = log;
    // Tool calls run one at a time: a write arms the bench for its own call only, and two lab
    // operations must never interleave. ping and the listings answer at once.
    /** @type {Promise<unknown>} */
    this.queue = Promise.resolve();
    /** @type {Set<Promise<unknown>>} */
    this.pending = new Set();
  }

  send(msg) {
    this.write(`${JSON.stringify(msg)}\n`);
  }

  /** One line from the client. */
  receive(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.send(errorMessage(null, ERR.parse, "Parse error: the line is not JSON"));
      return;
    }
    const problem = invalid(msg);
    if (problem) {
      this.send(errorMessage(isId(msg?.id) ? msg.id : null, ERR.invalidRequest, `Invalid Request: ${problem}`));
      return;
    }
    if (typeof msg.method !== "string") return; // a response to a request this server never sends
    this.track(this.answer(msg));
  }

  /** @param {Promise<unknown>} p */
  track(p) {
    this.pending.add(p);
    p.finally(() => this.pending.delete(p));
  }

  async answer(msg) {
    const notification = !("id" in msg);
    try {
      const result = await this.dispatch(msg);
      if (!notification) this.send({ jsonrpc: "2.0", id: msg.id, result });
    } catch (e) {
      if (notification) return;
      const rpc = e instanceof RpcError ? e : new RpcError(ERR.internal, `Internal error: ${e instanceof Error ? e.message : e}`);
      this.send(errorMessage(msg.id, rpc.code, rpc.message, rpc.data));
    }
  }

  async dispatch(msg) {
    const params = msg.params ?? {};
    if (typeof params !== "object" || Array.isArray(params)) throw new RpcError(ERR.invalidParams, "params must be an object");
    const requested = params._meta?.[VERSION_KEY];
    if (requested !== undefined && !SUPPORTED_VERSIONS.includes(requested)) {
      throw new RpcError(ERR.version, "Unsupported protocol version", { supported: SUPPORTED_VERSIONS, requested });
    }
    if (msg.method.startsWith("notifications/")) return null;
    if (!Object.hasOwn(METHODS, msg.method)) throw new RpcError(ERR.noMethod, `Method not found: ${msg.method}`);
    const result = /** @type {object} */ (await METHODS[msg.method](this, params));
    return MODERN_VERSIONS.includes(requested) ? { resultType: "complete", ...result } : result;
  }

  callTool(p) {
    if (typeof p.name !== "string" || !p.name) throw new RpcError(ERR.invalidParams, "tools/call needs a tool name");
    if (!this.tools.has(p.name)) throw new RpcError(ERR.invalidParams, `Unknown tool: ${p.name}`);
    const args = p.arguments ?? {};
    if (typeof args !== "object" || Array.isArray(args)) throw new RpcError(ERR.invalidParams, "arguments must be an object");
    const run = this.queue.then(() => this.tools.call(p.name, args));
    this.queue = run.catch(() => {});
    return run;
  }

  /** Resolves once every request already received has been answered. */
  async drain() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

function invalid(msg) {
  if (Array.isArray(msg)) return "batches are not supported";
  if (!msg || typeof msg !== "object") return "not a JSON-RPC object";
  if (msg.jsonrpc !== "2.0") return 'jsonrpc must be "2.0"';
  if ("id" in msg && !isId(msg.id)) return "id must be a string or a number";
  if (typeof msg.method !== "string" && !("result" in msg || "error" in msg)) return "no method";
  return null;
}

/**
 * Serves until stdin closes, then waits for calls in flight to answer.
 * @param {McpServer} server
 * @param {{ input?: NodeJS.ReadableStream }} [io]
 */
export function serveStdio(server, { input = process.stdin } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on("line", (line) => server.receive(line));
  return new Promise((resolve) => {
    rl.on("close", () => { server.drain().then(resolve); });
  });
}
