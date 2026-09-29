import fs from "node:fs";
import path from "node:path";

const at = (snap, i) => ({ x: i % snap.w, y: Math.floor(i / snap.w) });
const name = (table, idx) => (idx == null || idx < 0 ? null : table?.[idx] ?? `#${idx}`);
const unitKey = (u) => `${u.owner}:${u.id}`;

const RETYPES = [["t", "terrain", "terrains"], ["f", "feature", "features"], ["r", "resource", "resources"]];

function plotChange(a, b, i) {
  const c = {};
  if (a.o[i] !== b.o[i]) c.owner = [a.o[i], b.o[i]];
  for (const [layer, key, table] of RETYPES) {
    if (a[layer][i] !== b[layer][i]) c[key] = [name(a.names[table], a[layer][i]), name(b.names[table], b[layer][i])];
  }
  return c;
}

function diffPlots(a, b) {
  const plots = [];
  /** @type {Map<string, number>} */
  const transfers = new Map();
  for (let i = 0; i < a.t.length; i++) {
    const c = plotChange(a, b, i);
    if (c.owner) {
      const k = `${a.o[i]}>${b.o[i]}`;
      transfers.set(k, (transfers.get(k) ?? 0) + 1);
    }
    if (Object.keys(c).length) plots.push({ i, ...at(b, i), ...c });
  }
  const list = [...transfers].map(([k, n]) => {
    const [from, to] = k.split(">").map(Number);
    return { from, to, tiles: n };
  });
  return { plots, transfers: list.sort((x, y) => y.tiles - x.tiles) };
}

function diffUnits(a, b) {
  const ua = new Map(a.units.map((u) => [unitKey(u), u]));
  const ub = new Map(b.units.map((u) => [unitKey(u), u]));
  const appeared = [];
  const gone = [];
  const moved = [];
  for (const [k, u] of ub) {
    const was = ua.get(k);
    if (!was) appeared.push({ ...u, ...at(b, u.i) });
    else if (was.i !== u.i) moved.push({ ...u, from: at(a, was.i), to: at(b, u.i) });
  }
  for (const [k, u] of ua) if (!ub.has(k)) gone.push({ ...u, ...at(a, u.i) });
  return { appeared, gone, moved };
}

const grewFrom = (was, c) => was.pop != null && c.pop != null && was.pop !== c.pop;

// Settlements are matched by plot: a capture changes the owner and the id but not the tile.
function diffCities(a, b) {
  const ca = new Map(a.cities.map((c) => [c.i, c]));
  const cb = new Map(b.cities.map((c) => [c.i, c]));
  const founded = [];
  const lost = [];
  const captured = [];
  const grew = [];
  for (const [i, c] of cb) {
    const was = ca.get(i);
    if (!was) founded.push({ ...c, ...at(b, i) });
    else if (was.owner !== c.owner) captured.push({ ...c, from: was.owner, ...at(b, i) });
    else if (grewFrom(was, c)) grew.push({ ...c, popFrom: was.pop, ...at(b, i) });
  }
  for (const [i, c] of ca) if (!cb.has(i)) lost.push({ ...c, ...at(a, i) });
  return { founded, lost, captured, grew };
}

function diffPlayers(a, b) {
  const pa = new Map(a.players.map((p) => [p.id, p]));
  return b.players.map((p) => {
    const was = pa.get(p.id);
    const tiles = (s) => s.o.reduce((n, o) => n + (o === p.id ? 1 : 0), 0);
    return { id: p.id, name: p.name, tiles: [tiles(a), tiles(b)], gold: [was?.gold ?? null, p.gold ?? null] };
  }).filter((p) => p.tiles[0] !== p.tiles[1] || (p.gold[0] != null && p.gold[0] !== p.gold[1]));
}

// Answers "what changed between these two moments", grouped the way a mod question is asked:
// territory moving between players, units appearing, dying or moving, settlements and their size.
export function diffWorlds(a, b) {
  if (a.w !== b.w || a.h !== b.h) {
    throw new Error(`map sizes differ (${a.w}x${a.h} vs ${b.w}x${b.h}); these are different games`);
  }
  const { plots, transfers } = diffPlots(a, b);
  return {
    turns: [a.turn, b.turn],
    plots,
    transfers,
    units: diffUnits(a, b),
    cities: diffCities(a, b),
    players: diffPlayers(a, b),
  };
}

const pname = (id, byId) => (id < 0 ? "nobody" : `${byId.get(id) ?? "player"} (${id})`);
const MAX_RETYPED_LINES = 40;

function retypedLines(d) {
  const retyped = d.plots.filter((p) => p.terrain || p.feature || p.resource);
  const lines = retyped.slice(0, MAX_RETYPED_LINES).map((p) => {
    const parts = ["terrain", "feature", "resource"].filter((k) => p[k])
      .map((k) => `${k} ${p[k][0] ?? "none"} -> ${p[k][1] ?? "none"}`);
    return `plot (${p.x}, ${p.y}): ${parts.join(", ")}`;
  });
  if (retyped.length > MAX_RETYPED_LINES) lines.push(`... and ${retyped.length - MAX_RETYPED_LINES} more retyped plots`);
  return lines;
}

function playerLine(p, byId) {
  const bits = [];
  if (p.tiles[0] !== p.tiles[1]) bits.push(`tiles ${p.tiles[0]} -> ${p.tiles[1]}`);
  if (p.gold[0] != null && p.gold[0] !== p.gold[1]) bits.push(`gold ${p.gold[0]} -> ${p.gold[1]}`);
  return `${pname(p.id, byId)}: ${bits.join(", ")}`;
}

const DIFF_SECTIONS = [
  (d, who) => d.transfers.map((t) => `territory: ${t.tiles} tile(s) ${who(t.from)} -> ${who(t.to)}`),
  (d) => retypedLines(d),
  (d, who) => d.units.appeared.map((u) => `unit appeared: ${u.type} of ${who(u.owner)} at (${u.x}, ${u.y})`),
  (d, who) => d.units.gone.map((u) => `unit gone: ${u.type} of ${who(u.owner)} last at (${u.x}, ${u.y})`),
  (d, who) => d.units.moved
    .map((u) => `unit moved: ${u.type} of ${who(u.owner)} (${u.from.x}, ${u.from.y}) -> (${u.to.x}, ${u.to.y})`),
  (d, who) => d.cities.founded.map((c) => `settlement founded: ${c.name} by ${who(c.owner)} at (${c.x}, ${c.y})`),
  (d, who) => d.cities.lost.map((c) => `settlement gone: ${c.name} of ${who(c.owner)} at (${c.x}, ${c.y})`),
  (d, who) => d.cities.captured.map((c) => `settlement changed hands: ${c.name} ${who(c.from)} -> ${who(c.owner)}`),
  (d) => d.cities.grew.map((c) => `population: ${c.name} ${c.popFrom} -> ${c.pop}`),
];

export function describeDiff(d, snap) {
  const byId = new Map(snap.players.map((p) => [p.id, p.name]));
  const who = (id) => pname(id, byId);
  const lines = [`turn ${d.turns[0]} -> ${d.turns[1]}`];
  for (const section of DIFF_SECTIONS) lines.push(...section(d, who));
  for (const p of d.players) lines.push(playerLine(p, byId));
  if (lines.length === 1) lines.push("nothing changed");
  return lines.join("\n");
}

export class SnapshotStore {
  constructor(dir) {
    this.dir = dir;
  }

  file(label) {
    if (!/^[\w.-]+$/.test(label)) throw new Error(`snapshot names use letters, digits, dot, dash and underscore: "${label}"`);
    return path.join(this.dir, `${label}.json`);
  }

  save(label, snap) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file(label), JSON.stringify({ label, takenAt: new Date().toISOString(), ...snap }));
    return label;
  }

  load(label) {
    try {
      return JSON.parse(fs.readFileSync(this.file(label), "utf8"));
    } catch {
      throw new Error(`no snapshot named "${label}"`);
    }
  }

  // Oldest first, by file modification time: it has sub-millisecond precision, so two snapshots
  // saved in the same millisecond still list in the order they were taken.
  list() {
    try {
      return fs.readdirSync(this.dir).filter((f) => f.endsWith(".json")).map((f) => {
        const file = path.join(this.dir, f);
        const s = JSON.parse(fs.readFileSync(file, "utf8"));
        const order = fs.statSync(file, { bigint: true }).mtimeNs;
        return { label: s.label, turn: s.turn, takenAt: s.takenAt, size: `${s.w}x${s.h}`, order };
      }).sort((x, y) => (x.order < y.order ? -1 : x.order > y.order ? 1 : 0)).map(({ order: _order, ...rest }) => rest);
    } catch {
      return [];
    }
  }
}
