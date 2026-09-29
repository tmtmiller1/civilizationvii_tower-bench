// Client for the game's Cohtml debugger (the UIDebugger CDP endpoint, port 9444 by default).
// Only Runtime.evaluate is used: Page.enable hangs on this build and there is no screenshot agent.

export async function listTargets(port, { timeoutMs = 3000 } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(timeoutMs) });
  return res.json();
}

export function scopeOf(target) {
  if (!target) return "offline";
  if (/\/root-game\.html$/.test(target.url)) return "game";
  if (/\/root-shell\.html$/.test(target.url)) return "shell";
  return "other";
}

export function pickTarget(targets) {
  return targets.find((t) => scopeOf(t) === "game")
    ?? targets.find((t) => scopeOf(t) === "shell")
    ?? targets[0]
    ?? null;
}

function describeException(details) {
  return details.exception?.description ?? details.exception?.value ?? details.text ?? "evaluation failed";
}

export class GameEvalError extends Error {}

export class CdpSession {
  constructor(port) {
    this.port = port;
    this.ws = null;
    this.target = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  get scope() {
    return this.ws ? scopeOf(this.target) : "offline";
  }

  async connect() {
    const target = pickTarget(await listTargets(this.port));
    if (!target) throw new Error(`no debuggable page on port ${this.port}`);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`could not open ${target.webSocketDebuggerUrl}`));
    });
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    };
    ws.onclose = () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("debugger connection closed"));
      }
      this.pending.clear();
      if (this.ws === ws) this.ws = null;
    };
    this.ws = ws;
    this.target = target;
  }

  // Loading a save swaps root-shell for root-game. Re-list targets so a session never keeps
  // evaluating against a page that has been replaced.
  async ensure() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const current = pickTarget(await listTargets(this.port));
      if (current && current.url === this.target.url) return;
      this.ws.close();
      this.ws = null;
    }
    await this.connect();
  }

  send(method, params, timeoutMs) {
    const ws = this.ws;
    if (!ws) return Promise.reject(new Error("debugger connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms (the game may be mid-turn)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { timeoutMs = 10000 } = {}) {
    await this.ensure();
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.exceptionDetails) throw new GameEvalError(describeException(r.exceptionDetails));
    return r.result?.value;
  }

  // Runs a self-contained function in the page with `args` embedded as a JSON literal and returns
  // its result through JSON, which survives engine objects that returnByValue cannot serialise.
  async call(fn, args = {}, opts) {
    const src = typeof fn === "function" ? fn.toString() : fn;
    const expr = `(async () => { const r = await (${src})(${JSON.stringify(args)});`
      + ` return JSON.stringify(r === undefined ? null : r); })()`;
    const out = await this.evaluate(expr, opts);
    return out == null ? null : JSON.parse(out);
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}
