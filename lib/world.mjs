import fs from "node:fs";
import path from "node:path";

const at = (snap, i) => ({ x: i % snap.w, y: Math.floor(i / snap.w) });
const name = (table, idx) => (idx == null || idx < 0 ? null : table?.[idx] ?? `#${idx}`);
const unitKey = (u) => `${u.owner}:${u.id}`;

// Answers "what changed between these two moments", grouped the way a mod question is asked:
// territory moving between players, units appearing, dying or moving, settlements and their size.
export function diffWorlds(a, b) {
  if (a.w !== b.w || a.h !== b.h) throw new Error(`map sizes differ (${a.w}x${a.h} vs ${b.w}x${b.h}); these are different games`);
  const plots = [];
  const transfers = new Map();
  for (let i = 0; i < a.t.length; i++) {
    const c = {};
    if (a.o[i] !== b.o[i]) {
      c.owner = [a.o[i], b.o[i]];
      const k = `${a.o[i]}>${b.o[i]}`;
      transfers.set(k, (transfers.get(k) ?? 0) + 1);
    }
    if (a.t[i] !== b.t[i]) c.terrain = [name(a.names.terrains, a.t[i]), name(b.names.terrains, b.t[i])];
    if (a.f[i] !== b.f[i]) c.feature = [name(a.names.features, a.f[i]), name(b.names.features, b.f[i])];
    if (a.r[i] !== b.r[i]) c.resource = [name(a.names.resources, a.r[i]), name(b.names.resources, b.r[i])];
    if (Object.keys(c).length) plots.push({ i, ...at(b, i), ...c });
  }

  const ua = new Map(a.units.map((u) => [unitKey(u), u]));
  const ub = new Map(b.units.map((u) => [unitKey(u), u]));
  const units = { appeared: [], gone: [], moved: [] };
  for (const [k, u] of ub) {
    const was = ua.get(k);
    if (!was) units.appeared.push({ ...u, ...at(b, u.i) });
    else if (was.i !== u.i) units.moved.push({ ...u, from: at(a, was.i), to: at(b, u.i) });
  }
  for (const [k, u] of ua) if (!ub.has(k)) units.gone.push({ ...u, ...at(a, u.i) });

  // Settlements are matched by plot: a capture changes the owner and the id but not the tile.
  const ca = new Map(a.cities.map((c) => [c.i, c]));
  const cb = new Map(b.cities.map((c) => [c.i, c]));
  const cities = { founded: [], lost: [], captured: [], grew: [] };
  for (const [i, c] of cb) {
    const was = ca.get(i);
    if (!was) cities.founded.push({ ...c, ...at(b, i) });
    else if (was.owner !== c.owner) cities.captured.push({ ...c, from: was.owner, ...at(b, i) });
    else if (was.pop != null && c.pop != null && was.pop !== c.pop) cities.grew.push({ ...c, popFrom: was.pop, ...at(b, i) });
  }
  for (const [i, c] of ca) if (!cb.has(i)) cities.lost.push({ ...c, ...at(a, i) });

  const pa = new Map(a.players.map((p) => [p.id, p]));
  const players = b.players.map((p) => {
    const was = pa.get(p.id);
    const tiles = (s) => s.o.reduce((n, o) => n + (o === p.id ? 1 : 0), 0);
    return { id: p.id, name: p.name, tiles: [tiles(a), tiles(b)], gold: [was?.gold ?? null, p.gold ?? null] };
  }).filter((p) => p.tiles[0] !== p.tiles[1] || (p.gold[0] != null && p.gold[0] !== p.gold[1]));

  return {
    turns: [a.turn, b.turn],
    plots,
    transfers: [...transfers].map(([k, n]) => { const [from, to] = k.split(">").map(Number); return { from, to, tiles: n }; })
      .sort((x, y) => y.tiles - x.tiles),
    units,
    cities,
    players,
  };
}

const pname = (id, byId) => (id < 0 ? "nobody" : `${byId.get(id) ?? "player"} (${id})`);

export function describeDiff(d, snap) {
  const byId = new Map(snap.players.map((p) => [p.id, p.name]));
  const lines = [`turn ${d.turns[0]} -> ${d.turns[1]}`];
  for (const t of d.transfers) lines.push(`territory: ${t.tiles} tile(s) ${pname(t.from, byId)} -> ${pname(t.to, byId)}`);
  const retyped = d.plots.filter((p) => p.terrain || p.feature || p.resource);
  for (const p of retyped.slice(0, 40)) {
    const parts = ["terrain", "feature", "resource"].filter((k) => p[k]).map((k) => `${k} ${p[k][0] ?? "none"} -> ${p[k][1] ?? "none"}`);
    lines.push(`plot (${p.x}, ${p.y}): ${parts.join(", ")}`);
  }
  if (retyped.length > 40) lines.push(`... and ${retyped.length - 40} more retyped plots`);
  for (const u of d.units.appeared) lines.push(`unit appeared: ${u.type} of ${pname(u.owner, byId)} at (${u.x}, ${u.y})`);
  for (const u of d.units.gone) lines.push(`unit gone: ${u.type} of ${pname(u.owner, byId)} last at (${u.x}, ${u.y})`);
  for (const u of d.units.moved) lines.push(`unit moved: ${u.type} of ${pname(u.owner, byId)} (${u.from.x}, ${u.from.y}) -> (${u.to.x}, ${u.to.y})`);
  for (const c of d.cities.founded) lines.push(`settlement founded: ${c.name} by ${pname(c.owner, byId)} at (${c.x}, ${c.y})`);
  for (const c of d.cities.lost) lines.push(`settlement gone: ${c.name} of ${pname(c.owner, byId)} at (${c.x}, ${c.y})`);
  for (const c of d.cities.captured) lines.push(`settlement changed hands: ${c.name} ${pname(c.from, byId)} -> ${pname(c.owner, byId)}`);
  for (const c of d.cities.grew) lines.push(`population: ${c.name} ${c.popFrom} -> ${c.pop}`);
  for (const p of d.players) {
    const bits = [];
    if (p.tiles[0] !== p.tiles[1]) bits.push(`tiles ${p.tiles[0]} -> ${p.tiles[1]}`);
    if (p.gold[0] != null && p.gold[0] !== p.gold[1]) bits.push(`gold ${p.gold[0]} -> ${p.gold[1]}`);
    lines.push(`${pname(p.id, byId)}: ${bits.join(", ")}`);
  }
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
        return { label: s.label, turn: s.turn, takenAt: s.takenAt, size: `${s.w}x${s.h}`, order: fs.statSync(file, { bigint: true }).mtimeNs };
      }).sort((x, y) => (x.order < y.order ? -1 : x.order > y.order ? 1 : 0)).map(({ order, ...rest }) => rest);
    } catch {
      return [];
    }
  }
}
