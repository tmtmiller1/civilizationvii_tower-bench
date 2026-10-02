import { BenchError } from "./bench.mjs";
import { diffGame, impactGame, indexDir, listIndexes, snapshotGame, versionChanged } from "./patch.mjs";

// The patch-impact report over HTTP. Snapshot writes only the bench's own index store, never the game.
const list = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * @typedef {(bench: import("./bench.mjs").Bench, req: any, query: URLSearchParams,
 *   readBody: () => Promise<any>) => any} Route
 * @type {Record<string, Route>}
 */
export const PATCH_ROUTES = {
  "GET /api/game/indexes": (bench) => ({ indexes: listIndexes(indexDir(bench.paths)), status: versionChanged(bench.paths) }),
  "POST /api/game/snapshot": async (bench, _req, _q, readBody) => {
    const b = (await readBody()) ?? {};
    return snapshotGame(bench, { version: b.version || undefined, schemaDir: b.schemaDir || undefined, yes: !!b.yes });
  },
  "GET /api/game/diff": (bench, _req, q) => diffGame(bench.paths, { from: q.get("from") || undefined, to: q.get("to") || undefined }),
  "GET /api/game/impact": (bench, _req, q) => {
    const mods = list(q.get("mods") || "enabled");
    if (!mods.length) throw new BenchError("which mods? enabled, all, or folders");
    return impactGame(bench.paths, { mods, from: q.get("from") || undefined, to: q.get("to") || undefined });
  },
};
