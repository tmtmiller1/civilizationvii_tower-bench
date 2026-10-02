import { BenchError } from "../bench.mjs";
import { diffGame, impactGame, indexDir, listIndexes, snapshotGame, versionChanged } from "../patch.mjs";
import { techniqueById } from "../techniques.mjs";
import { num, out } from "./common.mjs";

export const PATCH_HELP = `  game                                 game indexes on file, and whether the game updated since the newest
  game snapshot [version] [--schema DIR] [--yes]
                                       index the installed game (files, exports, components, schema) so a
                                       later version can be compared with it; --yes replaces an index
  game diff [old] [new] [--limit 20]   what changed between two indexes (default: the two newest)
  game impact [folder...] [--mods all|enabled] [--from V] [--to V] [--level low]
                                       which mods the update breaks, each finding with the old and new
                                       fact and a fix; folders may hold one mod or many`;

const LEVELS = { high: ["High"], medium: ["High", "Medium"], low: ["High", "Medium", "Low"] };

function printStatus(paths) {
  const have = listIndexes(indexDir(paths));
  out(`game indexes in ${indexDir(paths)}: ${have.join(", ") || "none"}`);
  const v = versionChanged(paths);
  if (!v) return out("the installed version cannot be read here");
  out(`installed: ${v.installed}${v.message ? `\n${v.message}` : ""}`);
}

function printSnapshot(r) {
  out(`indexed game ${r.version}: ${r.stats.files} files, ${r.stats.scripts} scripts with exports, `
    + `${r.components.legacy} legacy components, ${r.components.registry} ui-next components, ${r.stats.tables} tables`);
  out(`  ${r.file} (${Math.round(r.bytes / 1024)} KB, files ${r.stats.filesMs} ms, schema ${r.stats.schemaMs} ms)`);
  if (r.schemaNote) out(`  no schema: ${r.schemaNote}`);
  if (r.modTables?.length) out(`  left out ${r.modTables.length} table(s) that installed mods create: ${more(r.modTables, 5).join(", ")}`);
}

const more = (list, n, fmt = String) => [...list.slice(0, n).map(fmt), ...(list.length > n ? [`... +${list.length - n} more`] : [])];

function section(title, list, n, fmt) {
  out(`\n${title}: ${list.length}`);
  for (const line of more(list, n, fmt)) out(`  ${line}`);
}

function printDiff(d, n) {
  out(`game ${d.from} -> ${d.to}`);
  section("files moved or renamed", d.files.moved, n, (m) => `${m.from} -> ${m.to} (${m.how})`);
  section("files removed", d.files.removed, n);
  section("files added", d.files.added, n);
  out(`\nfiles changed: ${d.files.changed.length}`);
  section("modules whose exports changed", d.exports.filter((e) => e.removed.length), n,
    (e) => `${e.file}${e.to ? ` (now ${e.to})` : ""}: lost ${e.removed.join(", ")}`);
  for (const k of /** @type {const} */ (["legacy", "registry"])) {
    section(`${k} components removed`, d.components[k].removed, n);
    section(`${k} components added`, d.components[k].added, n);
  }
  if (!d.schema.available) return out(`\nschema: ${d.schema.note}`);
  const fact = (f) => `${f.db}.${f.table}${f.column ? `.${f.column}` : ""}`;
  for (const k of ["tablesRemoved", "tablesAdded", "columnsRemoved", "columnsAdded", "nowRequired"]) {
    section(k.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`), d.schema[k], n, fact);
  }
  section("effect types removed", d.effectTypes.removed, n);
  out(`\nTypes rows: ${d.types.removed.length} removed, ${d.types.added.length} added (these follow the loaded game's age `
    + "and enabled mods as well as the update)");
}

function printFinding(f) {
  out(`  ${f.severity.padEnd(6)} ${f.text}`);
  out(`         was ${f.was}`);
  out(`         now ${f.now}`);
  out(`         fix: ${f.fix}`);
  if (f.files?.length) out(`         in ${more(f.files, 3).join(", ")}`);
  const t = f.techniques.map((id) => techniqueById(id)?.title ?? id);
  if (t.length) out(`         techniques: ${t.join("; ")}  (techniques show ${f.techniques[0]})`);
}

function printImpact(r, level) {
  out(`game ${r.from} -> ${r.to}: ${r.affected} of ${r.checked} mod(s) affected`);
  if (r.schemaNote) out(`database not compared: ${r.schemaNote}`);
  for (const f of r.failed) out(`  could not read ${f.folder}: ${f.error}`);
  const keep = LEVELS[level] ?? LEVELS.low;
  for (const m of r.mods) {
    const shown = m.findings.filter((f) => keep.includes(f.severity));
    if (!shown.length) continue;
    out(`\n${m.name} (${m.id})  ${m.folder}`);
    shown.forEach(printFinding);
  }
}

const SUBS = {
  snapshot: ({ bench, opt }, [version]) => {
    const r = snapshotGame(bench, { version, schemaDir: opt.schema, yes: !!opt.yes });
    return opt.json ? out(r) : printSnapshot(r);
  },
  diff: ({ paths, opt }, [from, to]) => {
    const r = diffGame(paths, { from, to });
    return opt.json ? out(r) : printDiff(r, num(opt.limit) ?? 20);
  },
  impact: ({ paths, opt }, folders) => {
    const mods = folders.length ? folders : (opt.mods ?? "enabled").split(",").map((s) => s.trim()).filter(Boolean);
    const r = impactGame(paths, { mods, from: opt.from, to: opt.to });
    return opt.json ? out(r) : printImpact(r, opt.level);
  },
};

/** @type {Record<string, import("./common.mjs").Handler>} */
export const PATCH_COMMANDS = {
  game: (ctx, [sub, ...rest]) => {
    if (!sub) {
      if (!ctx.opt.json) return printStatus(ctx.paths);
      return out({ indexes: listIndexes(indexDir(ctx.paths)), status: versionChanged(ctx.paths) });
    }
    if (!Object.hasOwn(SUBS, sub)) throw new BenchError(`unknown game command "${sub}"; try snapshot, diff or impact`);
    return SUBS[sub](ctx, rest);
  },
};
