// Reading an atlas: one member (or a root's members), text search, and the difference between two game versions.

/** @typedef {import("./atlas.mjs").Atlas} Atlas @typedef {import("./atlas.mjs").Member} Member */

const childrenOf = (atlas, prefix) => Object.values(atlas.members)
  .filter((m) => m.path.startsWith(`${prefix}.`) && m.path.split(".").length === prefix.split(".").length + 1)
  .sort((a, b) => a.path.localeCompare(b.path));

/**
 * A member with its verdicts and direct children, or a root with its members. Exact name first, then the same
 * name in any case.
 * @param {Atlas} atlas @param {string} name
 */
export function showMember(atlas, name) {
  const q = String(name ?? "").trim();
  const key = findKey(atlas.members, q);
  const rootKey = findKey(atlas.roots, q);
  if (!key && !rootKey) return null;
  const member = key ? atlas.members[key] : null;
  const byId = new Map(atlas.verdicts.map((v) => [v.id, v]));
  return {
    gameVersion: atlas.gameVersion,
    member,
    root: rootKey ? { name: rootKey, ...atlas.roots[rootKey] } : null,
    verdicts: (member ? member.verdicts : []).map((id) => byId.get(id)).filter(Boolean),
    children: childrenOf(atlas, /** @type {string} */ (key || rootKey)),
  };
}

const findKey = (obj, q) => (Object.hasOwn(obj, q) ? q
  : Object.keys(obj).find((k) => k.toLowerCase() === q.toLowerCase()));

function score(m, q, verdictText) {
  const p = m.path.toLowerCase();
  if (p === q) return 100;
  const last = /** @type {string} */ (p.split(".").at(-1));
  if (last === q) return 80;
  if (last.startsWith(q)) return 60;
  if (p.includes(q)) return 40;
  if (m.sdk?.signature?.toLowerCase().includes(q)) return 20;
  return verdictText.includes(q) ? 10 : 0;
}

/**
 * Members whose name, declared signature or verdict claim contains the text, best first, then by use.
 * @param {Atlas} atlas @param {string} text @param {number} [limit]
 */
export function searchAtlas(atlas, text, limit = 50) {
  const q = String(text ?? "").trim().toLowerCase();
  if (!q) return { total: 0, results: [] };
  const claims = new Map(atlas.verdicts.map((v) => [v.id, v.claim.toLowerCase()]));
  const hits = [];
  for (const m of Object.values(atlas.members)) {
    const s = score(m, q, m.verdicts.map((id) => claims.get(id) ?? "").join(" "));
    if (s) hits.push({ s, m });
  }
  const uses = (m) => m.usage?.count ?? 0;
  hits.sort((a, b) => b.s - a.s || uses(b.m) - uses(a.m) || a.m.path.localeCompare(b.m.path));
  return { total: hits.length, results: hits.slice(0, limit).map(({ m }) => brief(m)) };
}

/** @param {Member} m */
export const brief = (m) => ({ path: m.path, kind: m.kind, arity: m.arity, badges: m.badges,
  uses: m.usage?.count ?? 0, scopes: Object.keys(m.live).filter((s) => m.live[s].kind !== "absent") });

// Present in a version: seen live (not absent), used by its scripts, or declared.
const present = (m) => m.badges.some((b) => b === "LIVE" || b === "USED" || b === "DOCUMENTED");

/**
 * Members added and removed between two atlases, and members whose kind or arity changed. A member counts as
 * present when it was seen live, used by the game's scripts, or declared.
 * @param {Atlas} a older @param {Atlas} b newer
 */
export function diffAtlases(a, b) {
  const pa = new Map(Object.values(a.members).filter(present).map((m) => [m.path, m]));
  const pb = new Map(Object.values(b.members).filter(present).map((m) => [m.path, m]));
  const ea = new Set(Object.keys(a.events));
  const eb = new Set(Object.keys(b.events));
  return {
    from: a.gameVersion, to: b.gameVersion,
    added: [...pb.keys()].filter((k) => !pa.has(k)).sort(),
    removed: [...pa.keys()].filter((k) => !pb.has(k)).sort(),
    ...changes(pa, pb),
    events: { added: [...eb].filter((e) => !ea.has(e)).sort(), removed: [...ea].filter((e) => !eb.has(e)).sort() },
    liveIn: { from: Object.keys(a.sources?.live ?? {}), to: Object.keys(b.sources?.live ?? {}) },
  };
}

/** Members in both whose arity (when both know it) or kind differs. */
function changes(pa, pb) {
  const arity = [];
  const kind = [];
  for (const [k, ma] of pa) {
    const mb = pb.get(k);
    if (!mb) continue;
    const known = ma.arity !== null && mb.arity !== null;
    if (known && ma.arity !== mb.arity) arity.push({ path: k, from: ma.arity, to: mb.arity });
    if (ma.kind !== mb.kind) kind.push({ path: k, from: ma.kind, to: mb.kind });
  }
  return { arity, kind };
}
