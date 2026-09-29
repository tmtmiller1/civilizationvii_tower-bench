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

const unitCount = (p) => p.units?.length ?? 0;

function plotDelta(before, after) {
  if (!before || !after) return "";
  const parts = ["terrain", "feature", "resource"]
    .filter((k) => before[k] !== after[k])
    .map((k) => `${k} ${before[k] ?? "none"} -> ${after[k] ?? "none"}`);
  if (unitCount(before) !== unitCount(after)) parts.push(`units ${unitCount(before)} -> ${unitCount(after)}`);
  if (!!before.city !== !!after.city) parts.push(after.city ? "settlement appeared" : "settlement removed");
  return parts.join(", ");
}

const TIMING = { LANDED: (r) => ` in ${r.landedMs} ms`, "NO EFFECT": (r) => ` within ${r.waitedMs} ms` };

function engineNote(r) {
  if (!r.sent) return "";
  const canStart = r.canStart !== undefined ? `, canStart ${JSON.stringify(r.canStart)}` : "";
  return ` Engine returned ${JSON.stringify(r.returned)}${canStart}.`;
}

function entryLine(e) {
  const r = e.result ?? {};
  const timing = Object.hasOwn(TIMING, r.verdict) ? TIMING[r.verdict](r) : "";
  const delta = plotDelta(r.before, r.after);
  const outcome = `${r.verdict}${timing}.**${delta ? ` ${delta}.` : ""}${r.reason ? ` ${r.reason}.` : ""}`;
  const source = `watched ${localDate(e.ts)} on ${e.version ?? "unknown build"}, turn ${e.turn ?? "?"}, tower-bench`;
  return `- **${describeRequest(e.request)}: ${outcome}${engineNote(r)} Evidence: ${source}${e.kind === "undo" ? " (undo)" : ""}.`;
}

// Formats write entries as Markdown bullets: verdict, timing and the plot delta.
export function toMarkdown(entries) {
  return entries.filter((e) => e.kind === "write" || e.kind === "undo").map(entryLine).join("\n");
}
