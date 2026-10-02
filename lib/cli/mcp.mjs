import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, serveStdio } from "../mcp.mjs";
import { INSTRUCTIONS, createToolTable } from "../mcp-tools.mjs";
import { createResources } from "../mcp-resources.mjs";

/** @typedef {import("./common.mjs").Ctx} Ctx */

export const MCP_HELP = `  mcp [--allow-writes] [--allow-lab] [--allow-eval]
                                       serve the bench to an AI assistant over MCP (stdio). Read-only
                                       unless allowed: --allow-writes for game, registry and file changes,
                                       --allow-lab also for lab_start and bisect, --allow-eval for console JS`;

function version() {
  const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
  try { return JSON.parse(fs.readFileSync(pkg, "utf8")).version ?? "0.0.0"; } catch { return "0.0.0"; }
}

// stdout carries protocol messages only. Anything a bench module prints goes to stderr instead, where an MCP
// client shows or logs it.
function guardStdout() {
  const write = process.stdout.write.bind(process.stdout);
  const toErr = (...a) => console.error(...a);
  console.log = toErr;
  console.info = toErr;
  console.debug = toErr;
  console.table = (data) => console.error(JSON.stringify(data));
  return (/** @type {string} */ line) => { write(line); };
}

/** @param {Ctx} ctx */
async function mcpCommand({ bench, opt }) {
  const o = /** @type {Record<string, unknown>} */ (opt);
  const flags = { allowWrites: !!o["allow-writes"], allowLab: !!o["allow-lab"], allowEval: !!o["allow-eval"] };
  const write = guardStdout();
  const log = (line) => process.stderr.write(`[tower-bench mcp] ${line}\n`);
  const tools = createToolTable({ bench, flags });
  const server = new McpServer({
    tools, resources: createResources(bench), info: { name: "tower-bench", version: version() },
    instructions: INSTRUCTIONS, write, log,
  });
  log(`serving ${tools.defs.length} tools on stdio; writes ${flags.allowWrites ? "allowed" : "refused"}, lab `
    + `${flags.allowWrites && flags.allowLab ? "allowed" : "refused"}, eval ${flags.allowEval ? "listed" : "not listed"}`);
  await serveStdio(server);
  log("stdin closed; exiting");
}

/** @type {Record<string, import("./common.mjs").Handler>} */
export const MCP_COMMANDS = { mcp: mcpCommand };
