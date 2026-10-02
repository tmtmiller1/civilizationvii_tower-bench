// The tool table an AI assistant sees over MCP. Each tool is a thin wrapper over a bench function; this
// file holds what they share: argument checks, the permission gates, per-call arming, the evidence
// record of every call, and the text-plus-JSON result.
import { GAME_TOOLS } from "./mcp-tools-game.mjs";
import { FILE_TOOLS } from "./mcp-tools-files.mjs";
import { WRITE_TOOLS } from "./mcp-tools-write.mjs";
import { STATIC_NOTE, VERDICTS, messageOf } from "./mcp-common.mjs";

/** @typedef {import("./mcp-common.mjs").ToolDef} ToolDef @typedef {import("./mcp-common.mjs").Flags} Flags
 * @typedef {import("./mcp-common.mjs").ToolCtx} ToolCtx @typedef {import("./mcp-common.mjs").Out} Out
 * @typedef {import("./mcp-common.mjs").Gate} Gate */

export const INSTRUCTIONS = `Tower Bench: a live test bench for Civilization VII mods. It reads a running game through \
the game's UI debugger and reads the game's own files (logs, Mods.sqlite, crash reports).

How to use it well:
- Isolation is the evidence: which mod, off versus on, reproduces versus not. A plausible mechanism is not evidence.
- Read the log tail (logs_recent) and the crash triage (crash_triage) before theorising.
- ${STATIC_NOTE}
- ${VERDICTS}
- Say whether you watched a change work (a LANDED verdict, a re-read, a passed recipe) or only think it works.

Permissions are set by the human who started this server, not by you. Without --allow-writes every tool that changes
the game, the mod registry or the game's files returns a refusal; lab_start and bisect also need --allow-lab; eval is
listed only with --allow-eval. Every call, refused or not, is recorded in the bench's evidence log.`;

const GATE_TEXT = {
  write: "Changes the running game, the mod registry or the game's files. Needs the server started with --allow-writes.",
  lab: "Starts and quits test games and switches mods for them (restored after). Needs --allow-writes and --allow-lab.",
  eval: "Runs JavaScript inside the game. Listed only because the server was started with --allow-eval.",
};

const ALL_TOOLS = [...GAME_TOOLS, ...FILE_TOOLS, ...WRITE_TOOLS];

/** @param {Gate} gate @param {Flags} flags */
export function refusalFor(gate, flags) {
  const restart = (f) => `A human enables it by restarting the server with ${f}, for example `
    + `\`claude mcp add tower-bench -- node /path/to/tower-bench.mjs mcp ${f}\`. Do not work around this refusal.`;
  if (gate === "write" && !flags.allowWrites) {
    return `Refused: this tool changes the game, its mod registry or its files, and this Tower Bench server was started `
      + `without --allow-writes. ${restart("--allow-writes")}`;
  }
  if (gate === "lab" && !(flags.allowWrites && flags.allowLab)) {
    return "Refused: this tool starts and quits test games and switches mods for them, and this Tower Bench server was "
      + `started without ${flags.allowWrites ? "" : "--allow-writes and "}--allow-lab. ${restart("--allow-writes --allow-lab")}`;
  }
  if (gate === "eval" && !flags.allowEval) return `Refused: running JavaScript needs --allow-eval. ${restart("--allow-eval")}`;
  return null;
}

const TYPES = {
  string: (v) => typeof v === "string",
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => !!v && typeof v === "object" && !Array.isArray(v),
};

// Each check returns the problem with value v under schema s, or nothing.
const VALUE_CHECKS = [
  (s, v) => s.type && !TYPES[s.type](v) && `must be ${s.type === "integer" ? "an" : "a"} ${s.type}`,
  (s, v) => s.enum && !s.enum.includes(v) && `must be one of ${s.enum.join(", ")}`,
  (s, v) => typeof v === "number" && s.minimum !== undefined && v < s.minimum && `must be at least ${s.minimum}`,
  (s, v) => typeof v === "number" && s.maximum !== undefined && v > s.maximum && `must be at most ${s.maximum}`,
  (s, v) => Array.isArray(v) && s.items?.type && !v.every(TYPES[s.items.type]) && `must hold ${s.items.type}s`,
];

/** @param {string} key @param {any} spec @param {unknown} v */
function badValue(key, spec, v) {
  for (const check of VALUE_CHECKS) {
    const problem = check(spec, v);
    if (problem) return `${key} ${problem}`;
  }
  return null;
}

/** The subset of JSON Schema the tool table uses: types, enums, bounds, required, no unknown keys. */
export function checkArgs(def, args) {
  const props = def.input ?? {};
  for (const [k, v] of Object.entries(args)) {
    if (!Object.hasOwn(props, k)) return `unknown argument "${k}"; this tool takes ${Object.keys(props).join(", ") || "none"}`;
    const bad = badValue(k, props[k], v);
    if (bad) return bad;
  }
  const missing = (def.required ?? []).find((k) => args[k] === undefined);
  return missing ? `missing required argument "${missing}"` : null;
}

/** @param {ToolDef} def @param {Flags} flags */
function describe(def, flags) {
  const gate = GATE_TEXT[def.gate];
  const refused = def.gate === "eval" ? null : refusalFor(def.gate, flags);
  const now = refused ? " Currently refused on this server." : "";
  return {
    name: def.name, title: def.title,
    description: [def.description, gate ? `${gate}${now}` : ""].filter(Boolean).join("\n\n"),
    inputSchema: { type: "object", properties: def.input ?? {}, ...(def.required?.length ? { required: def.required } : {}),
      additionalProperties: false },
    annotations: { title: def.title, readOnlyHint: def.gate === "read", destructiveHint: def.gate === "write" || def.gate === "lab",
      idempotentHint: def.gate === "read", openWorldHint: false },
  };
}

const JSON_LIMIT = 60000;

/** @param {Out} out @returns {import("./mcp.mjs").ToolResult} */
export function toResult(out) {
  let text = out.text || "(no output)";
  if (out.data !== undefined) {
    let json = JSON.stringify(out.data, null, 1) ?? "null";
    if (json.length > JSON_LIMIT) json = `${json.slice(0, JSON_LIMIT)}\n... (cut at ${JSON_LIMIT} characters)`;
    text += `\n\n\`\`\`json\n${json}\n\`\`\``;
  }
  return { content: [{ type: "text", text }], isError: !!out.isError };
}

const summary = (args) => {
  const s = JSON.stringify(args);
  return s.length > 500 ? `${s.slice(0, 500)}...` : s;
};

/** The verdict a result carries, for the evidence line. */
const verdictOf = (data) => (data && typeof data === "object" && "verdict" in data ? String(data.verdict) : undefined);

/** @param {ToolCtx} ctx @param {ToolDef} def @param {object} args */
async function runGuarded(ctx, def, args) {
  const problem = checkArgs(def, args);
  if (problem) return { out: { text: `Bad arguments: ${problem}.`, isError: true }, outcome: "bad-args" };
  const refused = refusalFor(def.gate, ctx.flags);
  if (refused) return { out: { text: refused, isError: true }, outcome: "refused" };
  const arm = def.gate === "write" || def.gate === "lab";
  try {
    // Armed for this call only: the next call starts disarmed whatever this one did.
    if (arm) ctx.bench.armed = true;
    const out = await def.run(ctx, args);
    return { out, outcome: out.isError ? "error" : "ok" };
  } catch (e) {
    return { out: { text: `Error: ${messageOf(e)}`, isError: true }, outcome: "error" };
  } finally {
    ctx.bench.armed = false;
  }
}

/**
 * @param {{ bench: import("./bench.mjs").Bench, flags: Flags, tools?: ToolDef[] }} opts
 * @returns {import("./mcp.mjs").ToolTable & { defs: ToolDef[] }}
 */
export function createToolTable({ bench, flags, tools = ALL_TOOLS }) {
  const defs = tools.filter((d) => d.gate !== "eval" || flags.allowEval);
  const byName = new Map(defs.map((d) => [d.name, d]));
  /** @type {ToolCtx} */
  const ctx = { bench, paths: bench.paths, flags };
  return {
    defs,
    list: () => defs.map((d) => describe(d, flags)),
    has: (name) => byName.has(name),
    call: async (name, args) => {
      const def = /** @type {ToolDef} */ (byName.get(name));
      const t0 = Date.now();
      const { out, outcome } = await runGuarded(ctx, def, args);
      const verdict = verdictOf(out.data);
      try {
        bench.log({ kind: "mcp", request: { tool: name, args: summary(args) },
          result: { outcome, ...(verdict ? { verdict } : {}),
            ...(out.isError ? { error: out.text.slice(0, 300) } : {}) },
          ms: Date.now() - t0 });
      } catch (e) {
        out.text += `\n\nnote: the evidence log could not be written: ${messageOf(e)}`;
      }
      return toResult(out);
    },
  };
}
