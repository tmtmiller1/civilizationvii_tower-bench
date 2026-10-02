import fs from "node:fs";
import { parseArgs } from "node:util";
import { BenchError } from "../bench.mjs";
import { validateRecipe } from "../recipes.mjs";

export function parseCli() {
  return parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string" }, depth: { type: "string" }, limit: { type: "string" },
      owner: { type: "string" }, id: { type: "string" }, amount: { type: "string" },
      yes: { type: "boolean" }, all: { type: "boolean" }, follow: { type: "boolean" },
      level: { type: "string" }, mod: { type: "string" }, md: { type: "boolean" },
      date: { type: "string" }, help: { type: "boolean", short: "h" },
      seed: { type: "string" }, age: { type: "string" },
      scope: { type: "string" }, json: { type: "boolean" }, since: { type: "string" },
      turns: { type: "string" }, replicates: { type: "string" }, mods: { type: "string" },
      recipe: { type: "string" }, prove: { type: "boolean" },
      match: { type: "string" }, timeout: { type: "string" }, for: { type: "string" }, log: { type: "boolean" },
      backlog: { type: "boolean" }, "no-reload": { type: "boolean" }, filter: { type: "string" },
      k: { type: "string" }, batch: { type: "string" }, "reload-at": { type: "string" }, schema: { type: "string" },
      files: { type: "boolean" }, offline: { type: "boolean" }, last: { type: "boolean" },
      player: { type: "string" }, unit: { type: "string" }, city: { type: "string" }, skip: { type: "boolean" },
      from: { type: "string" }, to: { type: "string" },
      zip: { type: "string" }, against: { type: "string" },
      "allow-writes": { type: "boolean" }, "allow-lab": { type: "boolean" }, "allow-eval": { type: "boolean" },
      suite: { type: "string" }, "only-if-updated": { type: "boolean" }, notify: { type: "boolean" }, at: { type: "string" },
    },
  });
}

/**
 * @typedef {{
 *   bench: import("../bench.mjs").Bench,
 *   paths: ReturnType<typeof import("../paths.mjs").resolvePaths>,
 *   opt: ReturnType<typeof parseCli>["values"],
 * }} Ctx
 * @typedef {(ctx: Ctx, args: string[], cmd: string) => unknown} Handler
 */

export const out = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
export const num = (v) => (v === undefined ? undefined : Number(v));
export const stampNow = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
export const errorText = (e) => (e instanceof Error ? e.message : String(e));

async function cursorPlot(bench) {
  const c = await bench.cursor();
  if (!c) throw new BenchError("no plot under the cursor: hover the map in game first");
  return c;
}

/** @param {import("../bench.mjs").Bench} bench */
async function unitPlot(bench, which) {
  const st = await bench.status();
  if (!("snapshot" in st)) throw new BenchError(`not connected to the game: ${st.reason}`);
  const s = which === "selected" ? st.snapshot?.selectedUnit : st.snapshot?.firstUnit;
  if (!s) throw new BenchError(which === "selected" ? "no unit is selected in game" : "the local player has no units");
  return { x: s.x, y: s.y };
}

/** @param {import("../bench.mjs").Bench} bench @param {string[]} tokens */
export async function where(bench, tokens) {
  const [a, b] = tokens;
  if (a === "cursor") return { at: await cursorPlot(bench), rest: tokens.slice(1) };
  if (a === "selected" || a === "unit") return { at: await unitPlot(bench, a), rest: tokens.slice(1) };
  if (!Number.isInteger(Number(a)) || !Number.isInteger(Number(b))) {
    throw new BenchError(`expected "x y", "cursor", "selected" or "unit", got "${tokens.join(" ")}"`);
  }
  return { at: { x: Number(a), y: Number(b) }, rest: tokens.slice(2) };
}

/** @param {import("../bench.mjs").Bench} bench */
export async function localPlayer(bench) {
  const st = await bench.status();
  return ("snapshot" in st ? st.snapshot?.localPlayer : undefined) ?? 0;
}

export function loadRecipe(file) {
  if (!file) throw new BenchError("which recipe file?");
  let r;
  try {
    r = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new BenchError(`cannot read recipe ${file}: ${errorText(e)}`);
  }
  const problem = validateRecipe(r);
  if (problem) throw new BenchError(`${file}: ${problem}`);
  return r;
}
