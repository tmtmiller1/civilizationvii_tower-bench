import { BenchError } from "../bench.mjs";
import { analyseConflicts, analyseMod } from "../analysis.mjs";
import { POOL_LIMIT } from "../canvas.mjs";
import { techniqueById } from "../techniques.mjs";
import { proveCommand, withProofs } from "./labtools.mjs";
import { num, out } from "./common.mjs";

const row = (c, tail) => `  ${c.name.padEnd(36)} priority ${String(c.priority).padEnd(4)} ${tail}`;

function printActive(r) {
  if (!r.active) return;
  out(`\nmods applied to this game: ${r.active.now}; enabled for the next launch: ${r.active.next}`);
  if (r.active.onlyNow.length) out(`  only in this game: ${r.active.onlyNow.join(", ")}`);
  if (r.active.onlyNext.length) out(`  only at the next launch: ${r.active.onlyNext.join(", ")}`);
  for (const n of r.active.notes) out(`  ${n}`);
}

function printRegistry(r) {
  const apis = Object.entries(r.apis).filter(([k]) => !k.endsWith("Error"))
    .map(([k, v]) => `${k} ${v ? "readable" : "unavailable"}`).join(", ");
  out(`registry on the ${r.scope} page: ${apis}`);
  if (r.apis.componentRegistryError) out(`  ui-next registry: ${r.apis.componentRegistryError}`);
  out(`\nlegacy components replaced or styled by a mod: ${r.controls.length} of ${r.totals.controls ?? "?"}`);
  for (const c of r.controls) out(row(c, `${c.className ?? ""}  ${c.mods.join(", ")}`));
  out(`\nui-next components above base priority: ${r.components.length} of ${r.totals.components ?? "?"}`);
  for (const c of r.components) out(row(c, `winner ${c.factory ?? "?"}`));
  printActive(r);
}

function printProbe(r) {
  out(`${r.verdict}: painted ${r.k} calls; ${r.candidates} numeric candidate(s) sampled`);
  out(`canvas 2D context ${r.canvas2d ? "present" : "absent"}; pixel API ${r.pixelApi ? "present" : "absent"}`);
  for (const [m, ok] of Object.entries(r.domains)) out(`  CDP ${m}: ${ok === true ? "answers" : ok}`);
  for (const x of r.rows.slice(0, 15)) {
    out(`  ${x.tracks ? "TRACKS " : "       "}${x.key}: moved ${x.moved} while painting (${x.perCall}/call), ${x.drift} without`);
  }
}

function printStress(r) {
  out(r.crashed ? "the game crashed" : "the game survived the run");
  out(`  renderer: ${r.rendererLine ?? "no AddStaticResource line in Renderer.log"}`);
  out(`  last breadcrumb: ${r.lastBreadcrumb ?? "none"} (painted ${r.painted ?? "?"} calls${r.reloaded ? ", with one reload" : ""})`);
  if (r.pages.length > 1) out(`  painted on ${r.pages.length} pages: the count ran across a reload`);
}

const CANVAS_SUBS = {
  probe: async ({ bench, opt }) => {
    const r = await bench.canvasProbe({ k: num(opt.k) ?? 1000 });
    return opt.json ? out(r) : printProbe(r);
  },
  count: async ({ bench, opt }, [op]) => {
    const r = await bench.canvasCounter(op === "install" ? "install" : "read");
    if (opt.json) return out(r);
    if (!r.installed) return out(`not counting${r.reason ? `: ${r.reason}` : "; \"canvas count install\" starts now, \"agent canvas on\" from page load"}`);
    return out(`${r.calls} paint calls on this page since ${new Date(r.since).toLocaleTimeString()} `
      + `(an upper bound on pool slots; the pool holds ${POOL_LIMIT})\n${JSON.stringify(r.byMethod)}`);
  },
  stress: async ({ bench, opt }) => {
    if (!opt.yes) throw new BenchError("canvas stress paints until the game crashes; lab games only; add --yes");
    const r = await bench.canvasStress({ limit: num(opt.limit) ?? 200000, batch: num(opt.batch) ?? 1000,
      reloadAt: num(opt["reload-at"]) ?? 0 });
    return opt.json ? out(r) : printStress(r);
  },
};

const LEVELS = { high: ["High"], medium: ["High", "Medium"], low: ["High", "Medium", "Low"] };

function fixLine(ids) {
  const titles = (ids ?? []).map((id) => techniqueById(id)?.title ?? id);
  return titles.length ? `      fix: ${titles.join("; ")}  (techniques show ${ids[0]})` : null;
}

function printConflict(c) {
  out(`  ${c.severity.padEnd(6)} ${c.a} / ${c.b}: ${c.text}${c.proof ? `  [${c.proof.label}]` : ""}`);
  if (c.prove) out(`      prove: tower-bench ${c.prove}`);
  const fix = fixLine(c.techniques);
  if (fix) out(fix);
}

function printConflicts(r, level) {
  const shown = r.conflicts.filter((c) => (LEVELS[level] ?? LEVELS.medium).includes(c.severity));
  const by = (s) => r.conflicts.filter((c) => c.severity === s).length;
  out(`${r.mods} mod folder(s) read against game ${r.gameVersion}: ${by("High")} High, ${by("Medium")} Medium, `
    + `${by("Low")} Low. Read from files, not run.`);
  if (r.schemaNote) out(`  database checks skipped: ${r.schemaNote}`);
  for (const f of r.failed) out(`  could not read ${f.folder}: ${f.error}`);
  for (const c of shown) printConflict(c);
  if (shown.length < r.conflicts.length) out(`  (${r.conflicts.length - shown.length} lower-severity hidden; --level low shows them)`);
}

/** @param {any} r */
export function printCheck(r) {
  out(`${r.id}: ${r.verdict} on game ${r.gameVersion} (read from files, not run; checked against ${r.against} enabled mod(s))`);
  if (r.schemaNote) out(`  database checks skipped: ${r.schemaNote}`);
  for (const d of r.defects) {
    out(`  ${d.verdict.padEnd(12)} ${d.rule}${d.age ? ` (${d.age})` : ""}: ${d.text}`);
    const fix = fixLine(d.techniques);
    if (fix) out(fix);
  }
  if (r.runtime.unresolved) out(`  ${r.runtime.unresolved} computed run-time path(s) could not be checked`);
  if (r.conflicts.length) out(`\nconflicts with the mods the game will load alongside it: ${r.conflicts.length}`);
  for (const c of r.conflicts) printConflict(c);
}

/** @param {import("./common.mjs").Ctx} ctx */
export function conflictsCommand(ctx) {
  const { paths, opt } = ctx;
  if (opt.prove) return proveCommand(ctx);
  const r = analyseConflicts(paths, { all: !!opt.all, schemaDir: opt.schema });
  r.conflicts = withProofs(paths, r.conflicts);
  return opt.json ? out(r) : printConflicts(r, opt.level ?? "medium");
}

/** @type {Record<string, import("./common.mjs").Handler>} */
export const INSPECT_COMMANDS = {
  check({ paths, opt }, [dir]) {
    if (!dir) throw new BenchError("which mod folder? check <mod-folder>");
    const r = analyseMod(paths, dir, { schemaDir: opt.schema });
    return opt.json ? out(r) : printCheck(r);
  },
  canvas(ctx, [sub = "count", ...rest]) {
    if (!Object.hasOwn(CANVAS_SUBS, sub)) throw new BenchError("canvas probe [--k 1000] | count [install] | stress --yes [--limit N] [--reload-at N]");
    return CANVAS_SUBS[sub](ctx, rest);
  },
  async registry({ bench, opt }) {
    const r = await bench.registry();
    return opt.json ? out(r) : printRegistry(r);
  },
};
