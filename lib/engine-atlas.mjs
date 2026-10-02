// Page side of the API atlas: a read-only walk of the engine's script globals. It runs in the game through
// CdpSession.call, so it is self-contained.
//
// What it reads: property descriptors, prototypes and function arities. It never calls an engine function.
// An accessor (getter) is read only when its name is in `safe` for that object, which the bench fills with
// the names the game's own scripts read as plain properties there: the game performs that exact read
// itself at run time. Every other accessor is recorded as "accessor" without being read. Native objects can
// hide their members from getOwnPropertyNames (Object.keys gives []), so the names the game's scripts use
// on an object (`probe`) are also tried with a plain read when no descriptor is visible.

/**
 * @param {{ roots?: string[], probe?: Record<string, string[]>, safe?: Record<string, string[]>, depth?: number,
 *   maxRecords?: number, maxNames?: number, budgetMs?: number }} opts
 */
export function atlasCrawl(opts) {
  const o = { roots: [], probe: {}, safe: {}, depth: 3, maxRecords: 40000, maxNames: 600, budgetMs: 8000, ...opts };
  const st = {
    t0: Date.now(), records: /** @type {Record<string, any>} */ ({}), seen: new Map(),
    stats: { records: 0, truncated: false, accessorsSkipped: 0, accessorsRead: 0, probed: 0, absent: 0, errors: 0 },
    STOP: new Set([Object.prototype, Function.prototype]),
    FN_OWN: new Set(["length", "name", "prototype", "arguments", "caller"]),
  };

  const util = {
    over() {
      if (st.stats.records < o.maxRecords && Date.now() - st.t0 < o.budgetMs) return false;
      st.stats.truncated = true;
      return true;
    },
    protoOf(x) { try { return Object.getPrototypeOf(x); } catch { return null; } },
    findDesc(obj, name) {
      for (let x = obj; x && !st.STOP.has(x); x = util.protoOf(x)) {
        try {
          const d = Object.getOwnPropertyDescriptor(x, name);
          if (d) return d;
        } catch { return null; }
      }
      return null;
    },
    className(v) {
      const p = util.protoOf(v);
      try {
        const c = p && Object.getOwnPropertyDescriptor(p, "constructor")?.value;
        return typeof c === "function" ? (Object.getOwnPropertyDescriptor(c, "name")?.value ?? null) : null;
      } catch { return null; }
    },
    isDom(v) {
      return (typeof Node !== "undefined" && v instanceof Node) || (typeof Window !== "undefined" && v instanceof Window);
    },
    scalar(v, t) {
      if (t === "string") return { kind: t, value: v.length > 80 ? `${v.slice(0, 80)}...` : v };
      if (t === "number" || t === "boolean") return { kind: t, value: v };
      return v === null ? { kind: "null" } : { kind: t };
    },
    describe(v) {
      const t = typeof v;
      if (t === "function") {
        const len = Object.getOwnPropertyDescriptor(v, "length")?.value;
        return { kind: "function", arity: typeof len === "number" ? len : null };
      }
      if (t !== "object" || v === null) return util.scalar(v, t);
      if (util.isDom(v)) return { kind: "dom", cls: util.className(v) };
      if (Array.isArray(v)) return { kind: "array", length: v.length };
      return { kind: "object", cls: util.className(v) };
    },
    recurse(v) {
      return !!v && (typeof v === "object" || typeof v === "function") && !util.isDom(v) && !Array.isArray(v);
    },
  };

  const read = {
    // A plain read, for a probe name with no visible descriptor or an allowed getter.
    plain(obj, name, how) {
      try {
        const v = obj[name];
        if (v === undefined && how === "probe") { st.stats.absent++; return { rec: { kind: "absent" }, value: v }; }
        return { rec: { ...util.describe(v), via: how }, value: v };
      } catch (e) {
        st.stats.errors++;
        return { rec: { kind: "throws", via: how, error: String(e).slice(0, 120) }, value: undefined };
      }
    },
    member(obj, name, path) {
      const d = util.findDesc(obj, name);
      if (!d) { st.stats.probed++; return read.plain(obj, name, "probe"); }
      if ("value" in d) return { rec: util.describe(d.value), value: d.value };
      if (d.get && (o.safe[path] ?? []).includes(name)) {
        st.stats.accessorsRead++;
        const r = read.plain(obj, name, "getter");
        return { rec: { ...r.rec, accessor: true, set: !!d.set }, value: r.value };
      }
      st.stats.accessorsSkipped++;
      return { rec: { kind: "accessor", get: !!d.get, set: !!d.set }, value: undefined };
    },
    ownNames(obj) {
      const names = new Set();
      try {
        for (let x = obj; x && !st.STOP.has(x); x = util.protoOf(x)) {
          for (const n of Object.getOwnPropertyNames(x)) names.add(n);
        }
      } catch { st.stats.errors++; }
      return names;
    },
    names(obj, path) {
      const names = read.ownNames(obj);
      for (const n of o.probe[path] ?? []) names.add(n);
      const fn = typeof obj === "function";
      const all = [...names].filter((n) => n !== "constructor" && !(fn && st.FN_OWN.has(n)));
      const named = all.filter((n) => !/^\d+$/.test(n)).sort();
      const more = Math.max(0, named.length - o.maxNames);
      return { names: named.slice(0, o.maxNames), indexed: all.length - named.length, more };
    },
  };

  const walk = {
    visit(path, obj, level) {
      const self = st.records[path];
      if (st.seen.has(obj)) { self.ref = st.seen.get(obj); return; }
      st.seen.set(obj, path);
      const { names, indexed, more } = read.names(obj, path);
      if (indexed) self.indexed = indexed;
      if (more) self.more = more;
      let numbers = 0;
      for (const n of names) {
        if (util.over()) return;
        if (walk.child(obj, n, path, level).kind === "number") numbers++;
      }
      if (numbers && numbers === names.length) self.enum = true;
    },
    child(obj, n, path, level) {
      const p = `${path}.${n}`;
      const { rec, value } = read.member(obj, n, path);
      st.records[p] = rec;
      st.stats.records++;
      if (level < o.depth && util.recurse(value)) walk.visit(p, value, level + 1);
      return rec;
    },
  };

  const g = /** @type {any} */ (globalThis);
  for (const r of o.roots) {
    if (util.over()) break;
    const { rec, value } = read.member(g, r, "");
    st.records[r] = rec;
    st.stats.records++;
    if (util.recurse(value)) walk.visit(r, value, 1);
  }
  return { records: st.records, stats: { ...st.stats, ms: Date.now() - st.t0 } };
}
