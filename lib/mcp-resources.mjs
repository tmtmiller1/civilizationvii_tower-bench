// MCP resources: the techniques library, one resource per entry, and the evidence log, one per day.
import fs from "node:fs";
import { libraryWithRuns, loadTechniques } from "./techniques.mjs";

const TECHNIQUE = "tower-bench://techniques/";
const EVIDENCE = "tower-bench://evidence/";
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** @param {{ evidence: string }} paths */
function evidenceDays(paths) {
  try {
    return fs.readdirSync(paths.evidence).map((f) => DAY_FILE.exec(f)?.[1]).filter((d) => d !== undefined)
      .sort().reverse();
  } catch {
    return [];
  }
}

/**
 * @param {import("./bench.mjs").Bench} bench
 * @returns {import("./mcp.mjs").ResourceTable}
 */
export function createResources(bench) {
  const paths = bench.paths;
  return {
    list: () => [
      ...loadTechniques().entries.map((t) => ({
        uri: `${TECHNIQUE}${t.id}`, name: t.id, title: t.title, mimeType: "application/json",
        description: `${t.kind === "avoid" ? "Avoid: " : ""}${t.purpose}`,
      })),
      ...evidenceDays(paths).slice(0, 30).map((d) => ({
        uri: `${EVIDENCE}${d}`, name: `evidence-${d}`, title: `Evidence log ${d}`, mimeType: "application/json",
        description: "what the bench did that day and what the game did back, one entry per action or tool call",
      })),
    ],
    read: (uri) => {
      if (uri.startsWith(TECHNIQUE)) {
        const id = uri.slice(TECHNIQUE.length);
        const t = libraryWithRuns(paths, loadTechniques()).entries.find((x) => x.id === id);
        return t ? { uri, mimeType: "application/json", text: JSON.stringify(t, null, 1) } : null;
      }
      const day = uri.startsWith(EVIDENCE) ? uri.slice(EVIDENCE.length) : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
      return { uri, mimeType: "application/json", text: JSON.stringify(bench.evidence.read(day), null, 1) };
    },
  };
}
