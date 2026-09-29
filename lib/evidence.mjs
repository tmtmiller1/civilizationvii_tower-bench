import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describeRequest } from "./writes.mjs";

// Evidence is filed and cited by LOCAL date, the date a person writes in their notes; the ts field
// stays an ISO instant for ordering.
export function localDate(d = new Date()) {
  const t = d instanceof Date ? d : new Date(d);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

// Append-only record of what the bench did and what the game did back, one JSON object per line,
// one file per day. It is the source for evidence lines in a notes file of engine verdicts.
export class EvidenceLog {
  constructor(dir) {
    this.dir = dir;
  }

  fileFor(date) {
    return path.join(this.dir, `${date}.jsonl`);
  }

  // Each entry gets its own id: a timestamp alone is not unique, and undo refers to writes by id.
  append(entry) {
    const full = { id: `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`, ts: new Date().toISOString(), ...entry };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.fileFor(localDate(full.ts)), JSON.stringify(full) + "\n");
    return full;
  }

  read(date) {
    try {
      return fs.readFileSync(this.fileFor(date), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }
}

function plotDelta(before, after) {
  if (!before || !after) return "";
  const parts = [];
  for (const k of ["terrain", "feature", "resource"]) {
    if (before[k] !== after[k]) parts.push(`${k} ${before[k] ?? "none"} -> ${after[k] ?? "none"}`);
  }
  if ((before.units?.length ?? 0) !== (after.units?.length ?? 0)) parts.push(`units ${before.units.length} -> ${after.units.length}`);
  if (!!before.city !== !!after.city) parts.push(after.city ? "settlement appeared" : "settlement removed");
  return parts.join(", ");
}

// Formats write entries as Markdown bullets: verdict, timing and the plot delta.
export function toMarkdown(entries) {
  const lines = [];
  for (const e of entries) {
    if (e.kind !== "write" && e.kind !== "undo") continue;
    const r = e.result ?? {};
    const timing = r.verdict === "LANDED" ? ` in ${r.landedMs} ms` : r.verdict === "NO EFFECT" ? ` within ${r.waitedMs} ms` : "";
    const delta = plotDelta(r.before, r.after);
    const engine = r.sent
      ? ` Engine returned ${JSON.stringify(r.returned)}${r.canStart !== undefined ? `, canStart ${JSON.stringify(r.canStart)}` : ""}.`
      : "";
    lines.push(
      `- **${describeRequest(e.request)}: ${r.verdict}${timing}.**${delta ? ` ${delta}.` : ""}${r.reason ? ` ${r.reason}.` : ""}`
      + `${engine} Evidence: watched ${localDate(e.ts)} on ${e.version ?? "unknown build"}, turn ${e.turn ?? "?"}, tower-bench${e.kind === "undo" ? " (undo)" : ""}.`,
    );
  }
  return lines.join("\n");
}
