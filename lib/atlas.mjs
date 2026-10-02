// The engine API atlas: one record per `Root.member`, merged from what a live page exposes (lib/engine-atlas.mjs),
// what the game's own scripts use (lib/atlas-usage.mjs), what declaration files say (lib/atlas-sdk.mjs) and what
// findings docs concluded (lib/atlas-verdicts.mjs). Stored per game version under ~/.tower-bench/atlas.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { crawlPlan, usageIndex } from "./atlas-usage.mjs";
import { readSdk } from "./atlas-sdk.mjs";
import { readVerdicts } from "./atlas-verdicts.mjs";
import { atlasCrawl } from "./engine-atlas.mjs";
import { gameVersion } from "./paths.mjs";

export const ATLAS_SCHEMA = 1;

/**
 * @typedef {import("./atlas-usage.mjs").Use} Use
 * @typedef {import("./atlas-sdk.mjs").SdkMember} SdkMember
 * @typedef {import("./atlas-verdicts.mjs").Verdict} Verdict
 * @typedef {{ scope: string, at: string, records: Record<string, any>, stats: any }} LiveCrawl
 * @typedef {{ path: string, root: string, kind: string, arity: number | null, badges: string[],
 *   live: Record<string, any>, usage: Use | null, sdk: SdkMember | null, verdicts: number[] }} Member
 * @typedef {{ schema: number, gameVersion: string, builtAt: string, sources: any,
 *   roots: Record<string, any>, members: Record<string, Member>, events: Record<string, any>,
 *   verdicts: Verdict[] }} Atlas
 */

/**
 * LIVE: seen in a crawl (and not absent); USED: in game scripts; DOCUMENTED: declared; WATCHED: a watched verdict
 * that is about this member (its subject, not a passing mention).
 */
export function badgesOf(m, verdicts = []) {
  const out = [];
  if (Object.values(m.live).some((r) => r.kind !== "absent")) out.push("LIVE");
  if (m.usage?.count) out.push("USED");
  if (m.sdk) out.push("DOCUMENTED");
  if (verdicts.some((v) => v.level === "watched" && v.role === "subject")) out.push("WATCHED");
  return out;
}

const liveRecord = (live) => live.game ?? live.shell ?? Object.values(live)[0];

function liveKind(live) {
  const r = liveRecord(live);
  if (!r) return null;
  return r.kind === "accessor" ? "accessor" : r.kind;
}

function kindOf(m) {
  return liveKind(m.live) ?? (m.sdk ? (m.sdk.kind === "global" ? "object" : m.sdk.kind) : null)
    ?? (m.usage ? (m.usage.called ? "function" : "property") : "unknown");
}

function arityOf(m) {
  const r = liveRecord(m.live);
  if (typeof r?.arity === "number") return r.arity;
  return m.sdk?.params?.total ?? null;
}

/** @returns {Member} */
const emptyMember = (p) => ({ path: p, root: p.split(".")[0], kind: "", arity: null, badges: [], live: {}, usage: null,
  sdk: null, verdicts: [] });

function rootSummary(name, members, live, sdk) {
  const own = members.filter((m) => m.root === name);
  const at = (scope) => live[scope]?.records?.[name];
  return {
    members: own.length,
    used: own.reduce((n, m) => n + (m.path.split(".").length === 2 ? m.usage?.count ?? 0 : 0), 0),
    live: Object.fromEntries(Object.keys(live).filter((s) => at(s)).map((s) => [s, at(s).kind])),
    documented: !!sdk?.[name] || own.some((m) => m.sdk),
    watched: own.some((m) => m.badges.includes("WATCHED")),
  };
}

/** Members from the engine-derived sources: usage, declarations and live crawls. */
function collectMembers(used, declared, live) {
  /** @type {Record<string, Member>} */
  const members = {};
  const at = (p) => (members[p] ??= emptyMember(p));
  for (const [p, u] of Object.entries(used)) at(p).usage = /** @type {Use} */ (u);
  for (const [p, s] of Object.entries(declared)) if (p.includes(".")) at(p).sdk = s;
  for (const [scope, crawl] of Object.entries(live)) {
    for (const [p, r] of Object.entries(crawl.records)) if (p.includes(".")) at(p).live[scope] = r;
  }
  return { members, at };
}

function sourcesOf({ usage, sdk, verdicts, live }, attached) {
  return {
    usage: usage ? { files: usage.files, bytes: usage.bytes, ms: usage.ms } : null,
    sdk: sdk ? { files: sdk.files, members: Object.keys(sdk.members).length } : null,
    verdicts: verdicts ? { entries: verdicts.entries, verdicts: verdicts.verdicts.length, attached } : null,
    live: Object.fromEntries(Object.entries(live).map(([s, c]) => [s, { at: c.at, ...c.stats }])),
  };
}

/**
 * Merges the sources into one atlas. Any source may be missing.
 * @param {{ gameVersion: string, usage?: any, sdk?: { files: number, members: Record<string, SdkMember> } | null,
 *   verdicts?: { entries: number, verdicts: Verdict[] } | null, live?: Record<string, LiveCrawl> }} input
 * @returns {Atlas}
 */
export function buildAtlas(input) {
  const src = { usage: null, sdk: null, verdicts: null, live: {}, ...input };
  const used = src.usage ? src.usage.members : {};
  const declared = src.sdk ? src.sdk.members : {};
  const vlist = src.verdicts ? src.verdicts.verdicts : [];
  const { members, at } = collectMembers(used, declared, src.live);
  // Attached: names a member some engine-derived source knows. A verdict about anything else still gets a
  // member of its own, so "atlas show" finds it.
  const attached = vlist.filter((v) => v.members.some((p) => members[p])).length;
  for (const v of vlist) for (const p of v.members) at(p).verdicts.push(v.id);
  finishMembers(Object.values(members), vlist);
  return {
    schema: ATLAS_SCHEMA, gameVersion: input.gameVersion, builtAt: new Date().toISOString(),
    sources: sourcesOf(src, attached), roots: rootsOf(Object.values(members), declared, src.live), members,
    events: src.usage ? src.usage.events : {}, verdicts: vlist,
  };
}

/** @param {Member[]} list @param {Verdict[]} vlist */
function finishMembers(list, vlist) {
  const byId = new Map(vlist.map((v) => [v.id, v]));
  for (const m of list) {
    m.kind = kindOf(m);
    m.arity = arityOf(m);
    m.badges = badgesOf(m, m.verdicts.map((id) => byId.get(id)));
  }
}

function rootsOf(list, declared, live) {
  const names = new Set([...list.map((m) => m.root), ...Object.keys(declared).filter((p) => !p.includes("."))]);
  return Object.fromEntries([...names].sort().map((r) => [r, rootSummary(r, list, live, declared)]));
}

// ---- storage ----

/** @param {{ evidence: string }} paths */
export const atlasDir = (paths) => path.join(path.dirname(paths.evidence), "atlas");
const safeName = (v) => String(v).replace(/[^\w.-]+/g, "_");

/** @param {string} dir @param {Atlas} atlas */
export function saveAtlas(dir, atlas) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeName(atlas.gameVersion)}.json.gz`);
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(atlas)));
  return file;
}

/** Saved atlases, newest build first. @param {string} dir */
export function listAtlases(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".json.gz")); } catch { return []; }
  return names.map((f) => {
    const full = path.join(dir, f);
    return { version: f.replace(/\.json\.gz$/, ""), file: full, mtime: fs.statSync(full).mtime.toISOString() };
  }).sort((a, b) => b.mtime.localeCompare(a.mtime));
}

/** @param {string} file @returns {Atlas} */
export function readAtlasFile(file) {
  const raw = fs.readFileSync(file);
  const text = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  return JSON.parse(text);
}

/**
 * An atlas by game version, by file path, or (no `which`) the preferred version's, else the newest.
 * @param {string} dir @param {string | undefined} which @param {string | null} [preferred]
 */
export function loadAtlas(dir, which, preferred = null) {
  if (which && fs.existsSync(which) && fs.statSync(which).isFile()) return readAtlasFile(which);
  const all = listAtlases(dir);
  const hit = findAtlas(all, which, preferred);
  if (hit) return readAtlasFile(hit.file);
  const saved = all.map((a) => a.version).join(", ") || "none";
  throw new Error(which ? `no atlas for "${which}" in ${dir}; saved: ${saved}` : "no atlas yet; run \"atlas build\" first");
}

// The named version; with no name, the preferred version's, else the newest.
function findAtlas(all, which, preferred) {
  if (which) return all.find((a) => a.version === safeName(which));
  return (preferred && all.find((a) => a.version === safeName(preferred))) || all[0];
}

const inputsFile = (dir, version) => path.join(dir, `${safeName(version)}.inputs.json`);
const liveFile = (dir, version, scope) => path.join(dir, `${safeName(version)}.live-${safeName(scope)}.json`);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

/** The live crawls saved for one version, by scope. @returns {Record<string, LiveCrawl>} */
export function savedCrawls(dir, version) {
  const prefix = `${safeName(version)}.live-`;
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".json")); } catch { return {}; }
  return Object.fromEntries(names.map((f) => readJson(path.join(dir, f), null)).filter((c) => c?.scope)
    .map((c) => [c.scope, c]));
}

// ---- live crawl ----

/**
 * Crawl arguments from the usage index: roots, the names to probe per object, and the getters safe to read
 * (names the game's scripts read there without calling them; every root, which scripts read by name).
 */
export function crawlArgs(usage, { depth = 3, budgetMs = 8000, maxRecords = 40000 } = {}) {
  const plan = crawlPlan(usage);
  /** @type {Record<string, string[]>} */
  const safe = { "": plan.roots };
  for (const [p, u] of Object.entries(usage.members)) {
    if (u.called) continue;
    const parts = p.split(".");
    (safe[parts.slice(0, -1).join(".")] ??= []).push(/** @type {string} */ (parts.at(-1)));
  }
  return { roots: plan.roots, probe: plan.probe, safe, depth, budgetMs, maxRecords };
}

/**
 * Runs the read-only crawl on the page the debugger is on and saves it under its scope.
 * @param {any} bench @param {any} usage @param {{ depth?: number, budgetMs?: number }} [opts]
 * @returns {Promise<LiveCrawl>}
 */
export async function crawlLive(bench, usage, opts = {}) {
  await bench.requireConnection();
  const args = crawlArgs(usage, opts);
  const r = await bench.cdp.call(atlasCrawl, args, { timeoutMs: args.budgetMs + 20000 });
  const crawl = { scope: bench.cdp.scope, at: new Date().toISOString(), records: r.records, stats: r.stats };
  bench.log({ kind: "atlas", request: { crawl: crawl.scope, roots: args.roots.length, depth: args.depth },
    result: { records: r.stats.records, truncated: r.stats.truncated, ms: r.stats.ms } });
  return crawl;
}

/**
 * `atlas build`: the usage index from the install, plus SDK and verdicts when given (else the ones the last
 * build of this version used), plus every saved live crawl of this version; `live` crawls the current page first.
 * @param {any} bench
 * @param {{ live?: boolean, sdk?: string, verdicts?: string, depth?: number, budgetMs?: number,
 *   version?: string }} [opts]
 */
export async function runBuild(bench, opts = {}) {
  const { paths } = bench;
  const version = opts.version || bench.version || gameVersion(paths) || "unknown";
  const dir = atlasDir(paths);
  const usage = usageIndex(paths.install);
  const prior = { sdk: null, verdicts: null, ...readJson(inputsFile(dir, version), {}) };
  const sdk = opts.sdk ? readSdk(opts.sdk) : prior.sdk;
  const verdicts = opts.verdicts ? readVerdicts(opts.verdicts) : prior.verdicts;
  fs.mkdirSync(dir, { recursive: true });
  const crawled = opts.live ? await crawlLive(bench, usage, opts) : null;
  if (crawled) fs.writeFileSync(liveFile(dir, version, crawled.scope), JSON.stringify(crawled));
  fs.writeFileSync(inputsFile(dir, version), JSON.stringify({ sdk, verdicts }));
  const atlas = buildAtlas({ gameVersion: version, usage, sdk, verdicts, live: savedCrawls(dir, version) });
  return { file: saveAtlas(dir, atlas), summary: summarise(atlas), crawled: crawled && crawled.scope };
}

/** Counts for a build report. @param {Atlas} atlas */
export function summarise(atlas) {
  const list = Object.values(atlas.members);
  const count = (b) => list.filter((m) => m.badges.includes(b)).length;
  return {
    gameVersion: atlas.gameVersion, roots: Object.keys(atlas.roots).length, members: list.length,
    live: count("LIVE"), used: count("USED"), documented: count("DOCUMENTED"), watched: count("WATCHED"),
    events: Object.keys(atlas.events).length, sources: atlas.sources,
  };
}
