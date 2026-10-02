import { BenchError } from "../bench.mjs";
import { atlasDir, listAtlases, loadAtlas, runBuild } from "../atlas.mjs";
import { diffAtlases, searchAtlas, showMember } from "../atlas-query.mjs";
import { exportMarkdown } from "../atlas-md.mjs";
import { gameVersion } from "../paths.mjs";
import { errorText, num, out } from "./common.mjs";

/** @typedef {import("./common.mjs").Ctx} Ctx */

export const ATLAS_HELP = `  atlas build [--live] [--verdicts FILE] [--sdk DIR] [--depth 3] [--timeout 8]
                                       the engine API atlas for this game version: every Root.member
                                       the game's scripts use, merged with a read-only crawl of the
                                       page the debugger is on (--live; never calls engine functions),
                                       declaration files and findings docs
  atlas show <Root.member> [--atlas V] kind, arity, live scopes, uses with call sites, verdicts
  atlas search <text> [--limit 50]     members by name, declared signature or verdict text
  atlas diff <v1> <v2>                 members added, removed or changed arity between game versions
  atlas export --md <dir>              a publishable Markdown reference: index, a page per root, events
  atlas list                           saved atlases`;

const asBench = (e) => (e instanceof BenchError ? e : new BenchError(errorText(e)));
const guard = (fn) => { try { return fn(); } catch (e) { throw asBench(e); } };

/** @param {Ctx} ctx */
const current = ({ paths, opt }) => guard(() => loadAtlas(atlasDir(paths), opt["atlas"], gameVersion(paths)));

function printSummary(s, file) {
  out(`atlas for game ${s.gameVersion}: ${s.roots} roots, ${s.members} members, ${s.events} event names`);
  out(`  LIVE ${s.live}  USED ${s.used}  DOCUMENTED ${s.documented}  WATCHED ${s.watched}`);
  const u = s.sources.usage;
  if (u) out(`  usage: ${u.files} script files (${(u.bytes / 1048576).toFixed(1)} MB) read in ${u.ms} ms`);
  const live = Object.entries(s.sources.live);
  out(live.length ? `  live: ${live.map(([sc, l]) => `${sc} ${l.records} records${l.truncated ? " (truncated)" : ""}, `
    + `${l.at.slice(0, 16)}`).join("; ")}` : "  live: no crawl saved for this version (atlas build --live)");
  if (s.sources.sdk) out(`  declarations: ${s.sources.sdk.files} file(s), ${s.sources.sdk.members} declared names`);
  const v = s.sources.verdicts;
  if (v) out(`  verdicts: ${v.verdicts} finding(s) naming an API, ${v.attached} attached to an atlas member`);
  out(`  ${file}`);
}

function printRoot(r) {
  const live = Object.entries(r.root.live).map(([s, k]) => `${s} ${k}`).join(", ") || "not crawled";
  out(`${r.root.name} (game ${r.gameVersion}): ${r.root.members} member(s), used ${r.root.used} time(s); live ${live}`);
}

function printMember(m, version) {
  const arity = m.arity !== null ? `, arity ${m.arity}` : "";
  out(`${m.path} (game ${version}): ${m.kind}${arity}  [${m.badges.join(" ") || "no badges"}]`);
  for (const [scope, rec] of Object.entries(m.live)) out(`  live ${scope}: ${JSON.stringify(rec)}`);
  if (m.sdk) out(`  declared: ${m.sdk.signature}  (${m.sdk.file})`);
  if (!m.usage) return;
  out(`  used ${m.usage.count} time(s) in ${m.usage.files} file(s); args seen ${JSON.stringify(m.usage.args)}`);
  for (const e of m.usage.examples) out(`    ${e}`);
}

function printShow(r) {
  if (r.member) printMember(r.member, r.gameVersion);
  else printRoot(r);
  for (const v of r.verdicts) out(`  verdict (${v.level ?? "?"}${v.date ? ` ${v.date}` : ""}, ${v.role}): ${v.claim}`);
  const names = r.children.map((c) => `${c.path.split(".").at(-1)}${c.kind === "function" ? "()" : ""}`);
  if (names.length) out(`  members: ${names.join(", ")}`);
}

const row = (b) => `  ${b.path.padEnd(48)} ${b.kind.padEnd(9)} ${String(b.arity ?? "").padEnd(3)} ${b.badges.join(" ")}`
  + `${b.uses ? `  uses ${b.uses}` : ""}`;

function printDiff(d) {
  out(`game ${d.from} -> ${d.to}: ${d.added.length} added, ${d.removed.length} removed, ${d.arity.length} arity `
    + `changed, ${d.kind.length} kind changed; events +${d.events.added.length} -${d.events.removed.length}`);
  if (d.liveIn.from.length !== d.liveIn.to.length) out("  note: the two atlases were crawled live on different pages");
  for (const p of d.added) out(`  + ${p}`);
  for (const p of d.removed) out(`  - ${p}`);
  for (const x of d.arity) out(`  ~ ${x.path} arity ${x.from} -> ${x.to}`);
  for (const x of d.kind) out(`  ~ ${x.path} ${x.from} -> ${x.to}`);
  for (const e of d.events.added) out(`  + event ${e}`);
  for (const e of d.events.removed) out(`  - event ${e}`);
}

const SUBS = {
  /** @param {Ctx} ctx */
  async build({ bench, opt }) {
    const r = await runBuild(bench, { live: !!opt["live"], sdk: opt["sdk"], verdicts: opt["verdicts"],
      depth: num(opt.depth) ?? 3, budgetMs: (num(opt.timeout) ?? 8) * 1000 }).catch((e) => { throw asBench(e); });
    return opt.json ? out(r) : printSummary(r.summary, r.file);
  },
  show(ctx, [name]) {
    if (!name) throw new BenchError("atlas show <Root.member>");
    const r = showMember(current(ctx), name);
    if (!r) throw new BenchError(`"${name}" is not in the atlas; try "atlas search ${name.split(".").at(-1)}"`);
    return ctx.opt.json ? out(r) : printShow(r);
  },
  search(ctx, words) {
    if (!words.length) throw new BenchError("atlas search <text>");
    const r = searchAtlas(current(ctx), words.join(" "), num(ctx.opt.limit) ?? 50);
    if (ctx.opt.json) return out(r);
    out(`${r.total} match(es)${r.total > r.results.length ? `, first ${r.results.length}` : ""}`);
    return r.results.forEach((b) => out(row(b)));
  },
  diff({ paths, opt }, [a, b]) {
    if (!a || !b) throw new BenchError("atlas diff <v1> <v2> (game versions from \"atlas list\", or atlas files)");
    const dir = atlasDir(paths);
    const d = guard(() => diffAtlases(loadAtlas(dir, a), loadAtlas(dir, b)));
    return opt.json ? out(d) : printDiff(d);
  },
  export(ctx, [dir]) {
    if (!ctx.opt.md || !dir) throw new BenchError("atlas export --md <dir>");
    const r = guard(() => exportMarkdown(current(ctx), dir));
    return ctx.opt.json ? out(r) : out(`${r.files} page(s) written to ${r.dir} (start at index.md)`);
  },
  list({ paths, opt }) {
    const all = listAtlases(atlasDir(paths));
    if (opt.json) return out(all);
    if (!all.length) return out("no atlas yet; run \"atlas build\"");
    return all.forEach((a) => out(`  ${a.version.padEnd(16)} built ${a.mtime.slice(0, 16)}  ${a.file}`));
  },
};

/** @type {Record<string, import("./common.mjs").Handler>} */
export const ATLAS_COMMANDS = {
  atlas(ctx, [sub = "list", ...rest]) {
    if (!Object.hasOwn(SUBS, sub)) throw new BenchError("atlas build | show <Root.member> | search <text> | diff <v1> <v2> | export --md <dir> | list");
    return SUBS[sub](ctx, rest);
  },
};

const qnum = (v) => (v == null || v === "" ? undefined : Number(v));
const routeGuard = (fn) => { try { return fn(); } catch (e) { throw new BenchError(errorText(e), 404); } };

// Each handler is (bench, req, query, readBody). Reads are offline; build writes only the bench's own atlas files
// (and, with live, runs the read-only crawl on the connected page).
export const ATLAS_ROUTES = {
  "GET /api/atlas/list": (bench) => listAtlases(atlasDir(bench.paths)),
  "GET /api/atlas/search": (bench, _req, q) => routeGuard(() => searchAtlas(
    loadAtlas(atlasDir(bench.paths), q.get("atlas") || undefined, gameVersion(bench.paths)), q.get("q") ?? "",
    qnum(q.get("limit")) ?? 100)),
  "GET /api/atlas/show": (bench, _req, q) => routeGuard(() => showMember(
    loadAtlas(atlasDir(bench.paths), q.get("atlas") || undefined, gameVersion(bench.paths)), q.get("member") ?? "")),
  "POST /api/atlas/build": async (bench, _req, _q, readBody) => {
    const b = await readBody();
    const r = await runBuild(bench, { live: !!b.live }).catch((e) => { throw new BenchError(errorText(e)); });
    return { file: r.file, summary: r.summary };
  },
};
