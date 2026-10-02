// What the MCP tool modules share: types, the verification wording every description repeats, and a way
// to reuse the CLI's printers as tool text.
import { where } from "./cli/common.mjs";

/**
 * @typedef {{ allowWrites: boolean, allowLab: boolean, allowEval: boolean }} Flags
 * @typedef {{ bench: import("./bench.mjs").Bench, paths: import("./bench.mjs").Bench["paths"], flags: Flags }} ToolCtx
 * @typedef {{ text: string, data?: unknown, isError?: boolean }} Out
 * @typedef {"read" | "eval" | "write" | "lab"} Gate
 * @typedef {{ name: string, title: string, gate: Gate, description: string, input?: Record<string, any>,
 *   required?: string[], run: (ctx: ToolCtx, args: any) => Out | Promise<Out> }} ToolDef
 */

export const VERDICTS = "Verdicts come from re-reading the game after the change, never from the engine's reply: "
  + "LANDED (read back as asked), NO EFFECT (sent, nothing changed when re-read; some changes land only at the turn "
  + "roll, so re-read after a turn before concluding), UNEXPECTED (something changed, not what was asked), ALREADY "
  + "(already so; nothing sent), REFUSED (not sent: the request is invalid), THREW (the engine threw). The engine's "
  + "return value proves nothing. Report the verdict as the result.";

export const STATIC_NOTE = "Read from files, not run: every finding is a hypothesis about what the game will do. "
  + "Prove a static finding in a lab game (lab_start, reproduce, lab_stop) before acting on it.";

export const messageOf = (e) => (e instanceof Error ? e.message : String(e));

/**
 * Runs a function that prints with console.log (a CLI printer or command) and returns what it printed. Tool
 * calls run one at a time, so nothing else prints meanwhile; protocol messages never go through console.log.
 * @param {() => unknown} fn
 */
export async function captureOut(fn, { echo = (/** @type {string} */ _line) => {} } = {}) {
  /** @type {string[]} */
  const lines = [];
  const orig = console.log;
  const before = process.exitCode;
  console.log = (...a) => {
    const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x, null, 2))).join(" ");
    lines.push(line);
    echo(line);
  };
  let failed = false;
  try {
    await fn();
  } catch (e) {
    lines.push(`Error: ${messageOf(e)}`);
    failed = true;
  } finally {
    console.log = orig;
    // A CLI command reports failure through the exit code; that belongs to this call, not the server process.
    if (process.exitCode && process.exitCode !== before) failed = true;
    process.exitCode = before;
  }
  return { text: lines.join("\n"), failed };
}

/** Schema pieces most tools repeat. */
export const S = {
  folder: { type: "string", description: "path to a mod folder (the one holding its .modinfo)" },
  x: { type: "integer", description: "plot x" },
  y: { type: "integer", description: "plot y" },
  at: { type: "string", description: '"x y", "cursor" (plot under the mouse), "selected" (the selected unit\'s plot) or '
    + '"unit" (the local player\'s first unit); used instead of x and y' },
  limit: (n, max = 1000) => ({ type: "integer", minimum: 1, maximum: max, description: `how many to return (default ${n})` }),
};

/**
 * The plot a tool names, by x and y or by `at`.
 * @param {import("./bench.mjs").Bench} bench @param {{ x?: number, y?: number, at?: string }} args
 */
export async function plotArg(bench, { x, y, at }) {
  if (at !== undefined) {
    return (await where(bench, at.trim().split(/\s+/))).at;
  }
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error("give x and y, or at");
  return { x: /** @type {number} */ (x), y: /** @type {number} */ (y) };
}
