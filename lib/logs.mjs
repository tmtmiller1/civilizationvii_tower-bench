import fs from "node:fs";
import path from "node:path";
import { classify } from "./signatures.mjs";

export const DEFAULT_LOGS = ["UI.log", "Modding.log", "Database.log", "Scripting.log"];

export function parseLine(file, text) {
  return { file, text, ...classify(text) };
}

// Reads whole lines appended since the last poll. The game truncates its logs on launch, so a file
// that shrinks is re-read from the start rather than skipped.
export class LogTail {
  constructor(dir, files = DEFAULT_LOGS) {
    this.dir = dir;
    this.state = new Map(files.map((f) => [f, { offset: 0, partial: "", skipFirst: false }]));
  }

  // Positions every file at its end so only new lines are reported, or `backlog` bytes before it.
  seekToEnd(backlog = 0) {
    for (const [file, st] of this.state) {
      const size = this.size(file);
      st.offset = Math.max(0, size - backlog);
      st.partial = "";
      st.skipFirst = backlog > 0 && st.offset > 0;
    }
  }

  size(file) {
    try { return fs.statSync(path.join(this.dir, file)).size; } catch { return 0; }
  }

  poll() {
    const out = [];
    for (const [file, st] of this.state) {
      const size = this.size(file);
      if (size < st.offset) {
        st.offset = 0;
        st.partial = "";
      }
      if (size === st.offset) continue;
      for (const text of this.readLines(file, st, size)) if (text.trim()) out.push(parseLine(file, text));
    }
    return out;
  }

  readLines(file, st, size) {
    const fd = fs.openSync(path.join(this.dir, file), "r");
    try {
      const buf = Buffer.alloc(size - st.offset);
      fs.readSync(fd, buf, 0, buf.length, st.offset);
      st.offset = size;
      const lines = (st.partial + buf.toString("utf8")).split(/\r?\n/);
      st.partial = lines.pop() ?? "";
      if (st.skipFirst) {
        lines.shift();
        st.skipFirst = false;
      }
      return lines;
    } finally {
      fs.closeSync(fd);
    }
  }
}

export function readRecent(dir, files = DEFAULT_LOGS, bytes = 256 * 1024) {
  const tail = new LogTail(dir, files);
  tail.seekToEnd(bytes);
  return tail.poll();
}
