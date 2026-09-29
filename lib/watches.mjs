import fs from "node:fs";
import path from "node:path";
import { localDate } from "./evidence.mjs";

// Watches record a value per turn; invariants must stay true every turn. Both are plain JS
// expressions evaluated in the game, e.g. a watch `Players.get(0).Cities.getCities().length` or an
// invariant `Players.getAliveIds().every(id => Players.get(id) != null)`.
export class WatchStore {
  constructor(root) {
    this.defsFile = path.join(root, "watches.json");
    this.seriesDir = path.join(root, "watch-series");
  }

  defs() {
    try { return JSON.parse(fs.readFileSync(this.defsFile, "utf8")); } catch { return { watches: [], invariants: [] }; }
  }

  saveDefs(d) {
    fs.mkdirSync(path.dirname(this.defsFile), { recursive: true });
    fs.writeFileSync(this.defsFile, JSON.stringify(d, null, 2));
  }

  add(kind, name, expr) {
    if (!["watches", "invariants"].includes(kind)) throw new Error(`kind must be watches or invariants, not ${kind}`);
    if (!name || !expr) throw new Error("a name and an expression are both needed");
    const d = this.defs();
    d[kind] = [...d[kind].filter((w) => w.name !== name), { name, expr }];
    this.saveDefs(d);
    return d;
  }

  remove(name) {
    const d = this.defs();
    const before = d.watches.length + d.invariants.length;
    d.watches = d.watches.filter((w) => w.name !== name);
    d.invariants = d.invariants.filter((w) => w.name !== name);
    if (d.watches.length + d.invariants.length === before) throw new Error(`no watch or invariant named ${name}`);
    this.saveDefs(d);
    return d;
  }

  record(sample) {
    fs.mkdirSync(this.seriesDir, { recursive: true });
    const ts = new Date().toISOString();
    fs.appendFileSync(path.join(this.seriesDir, `${localDate()}.jsonl`), JSON.stringify({ ts, ...sample }) + "\n");
  }

  // Returns name -> [{turn, value}] for numeric plotting, oldest first, deduplicated by turn.
  series(date = localDate()) {
    let lines = [];
    try {
      lines = fs.readFileSync(path.join(this.seriesDir, `${date}.jsonl`), "utf8").split("\n").filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch { /* none yet */ }
    const out = {};
    for (const s of lines) {
      for (const [name, r] of Object.entries(s.watches ?? {})) {
        const point = r.error ? { turn: s.turn, error: r.error } : { turn: s.turn, value: r.value };
        (out[name] ??= new Map()).set(s.turn, point);
      }
    }
    return Object.fromEntries(Object.entries(out).map(([k, m]) => [k, [...m.values()]]));
  }
}

export function violations(sample) {
  return Object.entries(sample.invariants ?? {}).filter(([, r]) => !r.ok)
    .map(([name, r]) => ({ name, detail: r.detail }));
}
