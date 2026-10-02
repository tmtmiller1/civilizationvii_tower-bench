// The fuzz invariants, checked after every step, and the failure they report. A failure has a `kind` and a
// `key`; two failures are "the same" for shrinking when both match.
import fs from "node:fs";
import { sampleWatches } from "./engine.mjs";
import { pageErrors } from "./engine-sim.mjs";
import { modOf } from "./signatures.mjs";

export const ROLLBACK = new Set(["db-rollback-file", "db-rollback-action", "db-rollback", "config-rollback"]);

/**
 * @typedef {{ kind: string, key: string, detail: string, mod?: string | null, step?: number }} Failure
 * @typedef {{ name: string, expr: string }} Invariant
 */

/** Reads user invariants: a JSON list of { name, expr }, or an object holding one under "invariants". */
export function loadInvariants(file) {
  if (!file) return [];
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = Array.isArray(raw) ? raw : raw?.invariants;
  if (!Array.isArray(list) || !list.every((v) => v && typeof v.name === "string" && typeof v.expr === "string")) {
    throw new Error(`${file}: expected a list of { "name": ..., "expr": ... } (or { "invariants": [...] })`);
  }
  return list;
}

/** @param {any[]} lines log lines from LogTail.poll @returns {Failure | null} */
export function logFailure(lines) {
  const rollback = lines.find((l) => ROLLBACK.has(l.signature));
  if (rollback) return { kind: "db-rollback", key: `db-rollback:${rollback.mod ?? "-"}`, detail: rollback.text, mod: rollback.mod };
  const err = lines.find((l) => l.severity === "error" && l.mod);
  if (err) return { kind: "mod-error", key: `${err.signature}:${err.mod}`, detail: `${err.file}: ${err.text}`, mod: err.mod };
  return null;
}

/** Uncaught page errors whose file or stack names a non-official mod. @returns {Failure | null} */
export function pageFailure(errors) {
  for (const e of errors) {
    const mod = modOf(`${e.file ?? ""} ${e.message ?? ""}`);
    if (mod) return { kind: "page-error", key: `page-error:${mod}`, detail: `${e.message}${e.file ? ` (${e.file}:${e.line})` : ""}`, mod };
  }
  return null;
}

/** @param {any} sample from engine.sampleWatches @returns {Failure | null} */
export function invariantFailure(sample) {
  const bad = Object.entries(sample?.invariants ?? {}).find(([, v]) => !v.ok);
  return bad ? { kind: "invariant", key: `invariant:${bad[0]}`, detail: `${bad[0]}: ${bad[1].detail}` } : null;
}

/** @param {Failure | null} a @param {Failure | null} b */
export const sameFailure = (a, b) => !!a && !!b && a.kind === b.kind && a.key === b.key;

/**
 * Every invariant, cheapest first. `ctx` carries the log tail, the page-error count seen so far, the game's pid
 * and the user invariants.
 * @param {any} d @param {{ tail: { poll: () => any[] }, errSeen: number, pid: number | null,
 *   invariants: Invariant[] }} ctx
 * @returns {Promise<Failure | null>}
 */
export async function checkInvariants(d, ctx) {
  const now = d.gamePid();
  if (!now || (ctx.pid && now !== ctx.pid)) return { kind: "game-exited", key: "game-exited", detail: "the game process is gone" };
  const fromLogs = logFailure(ctx.tail.poll());
  if (fromLogs) return fromLogs;
  const pe = await d.bench.cdp.call(pageErrors, { since: ctx.errSeen }, { timeoutMs: 20000 });
  ctx.errSeen = pe.total;
  const fromPage = pageFailure(pe.errors);
  if (fromPage) return fromPage;
  if (!ctx.invariants.length) return null;
  const s = await d.bench.cdp.call(sampleWatches, { watches: [], invariants: ctx.invariants }, { timeoutMs: 30000 });
  return invariantFailure(s);
}
