// release-check: the slips that ship a broken Workshop or GitHub release, read from the package before it
// goes out. Every check is PASS, FAIL, WARN or INFO with the fix. Nothing here runs the game or writes
// anything; the registered copy it compares against is read from Mods.sqlite read-only.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { analyseMod } from "./analysis.mjs";
import { BenchError } from "./bench.mjs";
import { modinfoText } from "./l10n.mjs";
import { readMods, sourceOf, textFromModFiles } from "./mods.mjs";
import {
  declaredFiles, devFlags, devJunk, nestedCopies, outsideFiles, probeFiles, result, runtimeFiles, sizeSummary,
} from "./release-contents.mjs";
import { compareVersions, openPackage, packageModinfos } from "./release-package.mjs";
import { checkVdfs } from "./release-steam.mjs";
import { loadMod } from "./static/mod.mjs";
import { parseModinfo } from "./static/modinfo.mjs";
import { code, listMore, readText } from "./static/util.mjs";
import { techniqueIds } from "./techniques.mjs";

/**
 * @typedef {import("./release-contents.mjs").CheckResult} CheckResult
 * @typedef {{ paths: any, pkg: ReturnType<typeof openPackage>, mod: import("./static/mod.mjs").Mod,
 *   mi: import("./static/modinfo.mjs").Modinfo, version: string | null, folder: string | null,
 *   zip: string | null, against: string | null, analyse: typeof analyseMod }} Ctx
 */

/** The modinfo with this id in a package, or the shallowest one. */
function modinfoFor(root, id) {
  const all = packageModinfos(root).sort((a, b) => a.rel.split("/").length - b.rel.split("/").length);
  return (all.find((m) => m.info.id === id) ?? all[0])?.info ?? null;
}

/** The release to compare with: --against, else the Workshop copy (or another registered copy) of the id. */
function previousRelease(ctx) {
  if (ctx.against) {
    const prev = openPackage(ctx.against);
    try {
      const mi = modinfoFor(prev.root, ctx.mod.id);
      if (mi && mi.id !== ctx.mod.id) throw new BenchError(`--against holds ${mi.id}, not ${ctx.mod.id}`);
      return mi ? { label: ctx.against, mi, explicit: true } : null;
    } finally { prev.close(); }
  }
  if (!ctx.paths.modsDb || !fs.existsSync(ctx.paths.modsDb)) return null;
  const here = new Set([ctx.pkg.root, ctx.folder].filter(Boolean).map((p) => realpath(/** @type {string} */ (p))));
  const copies = readMods(ctx.paths.modsDb).filter((r) => r.id === ctx.mod.id && fs.existsSync(r.path)
    && !here.has(realpath(path.dirname(r.path))));
  const pick = copies.find((r) => sourceOf(r.path, ctx.paths).kind === "workshop") ?? copies[0];
  if (!pick) return null;
  const src = sourceOf(pick.path, ctx.paths);
  return { label: src.label, mi: parseModinfo(pick.path), explicit: src.kind === "workshop" };
}

function realpath(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** @param {Ctx} ctx @returns {CheckResult} */
function versionBumped(ctx) {
  const v = ctx.version;
  if (!v) {
    return result("version", "WARN", "the modinfo has no <Version> in <Properties>, so players and tools cannot tell this release from the last.",
      "Add <Version>x.y.z</Version> to <Properties> and raise it every release.");
  }
  const prev = previousRelease(ctx);
  if (!prev) {
    return result("version", "WARN", `version ${v}; nothing to compare it with (no --against and no other registered copy of ${code(ctx.mod.id)}).`,
      "Pass --against with the last release's zip or folder.");
  }
  return compareWith(ctx, v, prev);
}

/** @param {Ctx} ctx @param {string} v @returns {CheckResult} */
function compareWith(ctx, v, prev) {
  const was = prev.mi.props.Version ?? null;
  const same = prev.mi.version === ctx.mi.version;
  const attr = `Mod@version ${ctx.mi.version ?? "(none)"}${same ? " (unchanged)" : `, was ${prev.mi.version ?? "(none)"}`}`;
  const c = compareVersions(v, was);
  const evidence = { version: v, previous: was, against: prev.label, modVersion: ctx.mi.version,
    previousModVersion: prev.mi.version };
  if (c > 0) return result("version", "PASS", `version ${v}, up from ${was ?? "(none)"} in ${prev.label}; ${attr}.`, undefined, evidence);
  if (c < 0) {
    return result("version", "FAIL", `version ${v} is older than ${was} in ${prev.label}; ${attr}.`, "Raise <Version> above the last release.", evidence);
  }
  const note = prev.explicit ? " Either this release is already out, or its version was not raised."
    : " That copy may be your own dev copy; pass --against with the last release to be sure.";
  return result("version", prev.explicit ? "FAIL" : "WARN", `version ${v} is the same as ${prev.label} has; ${attr}.${note}`,
    "Raise <Version> in <Properties>.", evidence);
}

const CHANGELOG = /^change(s|log)[^/]*\.(md|txt)$/i;

function findChangelog(dirs) {
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    const hit = names.find((n) => CHANGELOG.test(n));
    if (hit) return path.join(d, hit);
  }
  return null;
}

/** @param {Ctx} ctx @returns {CheckResult | null} */
function changelogEntry(ctx) {
  const v = ctx.version;
  const up = (p, n) => (n ? up(path.dirname(p), n - 1) : p);
  const dirs = [ctx.pkg.root, ...(ctx.folder ? [ctx.folder, up(ctx.folder, 1), up(ctx.folder, 2)] : [])];
  const file = v ? findChangelog(dirs) : null;
  if (!file || !v) return null;
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = new RegExp(`(?<![\\w.])v?${esc}(?![\\w]|\\.\\d)`);
  const lines = readText(file).split(/\r?\n/).filter((l) => token.test(l));
  const name = path.basename(file);
  if (lines.some((l) => /^\s*(#{1,6}\s|\[|\*\*|v?\d|version\b)/i.test(l))) return result("changelog", "PASS", `${name} has an entry for ${v}.`);
  if (lines.length) return result("changelog", "WARN", `${name} mentions ${v} but has no heading for it.`, `Add a heading such as "## ${v}".`);
  return result("changelog", "FAIL", `${name} has no entry for ${v}.`, `Add a "## ${v}" section saying what changed.`);
}

/** @param {Ctx} ctx @param {"Name" | "Description"} prop @returns {CheckResult} */
function propResolves(ctx, prop) {
  const value = ctx.mi.props[prop];
  const check = prop === "Name" ? "name" : "description";
  if (!value) {
    return result(check, prop === "Name" ? "FAIL" : "WARN", `the modinfo has no <${prop}>.`, `Add <${prop}> to <Properties>.`);
  }
  if (!value.startsWith("LOC_")) return result(check, "PASS", `${prop} is plain text: ${code(value.slice(0, 60))}.`);
  const own = modinfoText(ctx.mi).get(value);
  if (own !== undefined) return result(check, "PASS", `${code(value)} resolves from the modinfo's LocalizedText: ${code(own.slice(0, 60))}.`);
  const elsewhere = textFromModFiles(ctx.mi.path, value);
  if (elsewhere !== null) {
    return result(check, "WARN",
      `${code(value)} is defined only in a text file the game loads in a game (${code(elsewhere.slice(0, 40))}). The mod list reads the modinfo's LocalizedText (Mods.sqlite), so it may show the raw tag there (a main-menu probe on 1.5.0, 2026-09-29, found such a tag unresolved).`,
      `Add <LocalizedText><Text id="${value}"><en_US>...</en_US></Text></LocalizedText> to the modinfo, or a <File> there naming the text file.`);
  }
  return result(check, "FAIL", `${code(value)} is defined nowhere in the shipped text, so the mod list shows the raw tag.`,
    "Define the tag in the modinfo's LocalizedText block.");
}

/** @param {Ctx} ctx @returns {CheckResult} */
function affectsSavedGames(ctx) {
  const raw = ctx.mi.props.AffectsSavedGames;
  const hasData = ctx.mod.dbOps.some((e) => e.db === "gameplay");
  const ui = ctx.mi.groups.some((g) => g.actions.some((a) => a.type === "UIScripts" || a.type === "ImportFiles"));
  if (raw === undefined) {
    return result("affects-saved-games", "WARN",
      "AffectsSavedGames is not set. A mod without AffectsSavedGames=0 is not applied when a save made without it is loaded (watched on 1.5.0), so a player who adds it mid-campaign sees nothing.",
      "Set <AffectsSavedGames>0</AffectsSavedGames> if the mod can join a game in progress, or 1 deliberately if it cannot.");
  }
  const on = /^(1|true)$/i.test(raw);
  if (on && !hasData && ui) {
    return result("affects-saved-games", "WARN", "AffectsSavedGames is 1 on a mod with no gameplay data: it will not load into saves made without it (watched on 1.5.0).",
      "Set it to 0 unless saves really depend on the mod.");
  }
  return result("affects-saved-games", "PASS", on
    ? "AffectsSavedGames is 1: the mod loads only into new games and saves made with it."
    : "AffectsSavedGames is 0: the mod also loads into saves made without it.");
}

/** @param {Ctx} ctx @returns {CheckResult} */
function preflight(ctx) {
  let r;
  try { r = ctx.analyse(ctx.paths, ctx.pkg.root); } catch (e) {
    return result("preflight", "WARN", `the pre-flight check could not run: ${e instanceof Error ? e.message : String(e)}.`);
  }
  // Listed-but-missing files are reported under declared-files.
  const defects = r.defects.filter((d) => d.rule !== "missing-listed-file");
  const blocking = defects.filter((d) => d.verdict === "BLOCKS GAME" || d.verdict === "FEATURE DEAD");
  const high = r.conflicts.filter((c) => c.severity === "High").length;
  const tail = `${defects.length - blocking.length} minor${high ? `; ${high} High conflict(s) with the mods enabled here` : ""}. Read from files, not run.`;
  if (!blocking.length) return result("preflight", "PASS", `nothing blocks a game on ${r.gameVersion}; ${tail}`, undefined, { verdict: r.verdict });
  const list = listMore(blocking, 3, (d) => `${d.verdict} ${d.rule}: ${d.text.slice(0, 120)}`);
  return result("preflight", "FAIL", `${blocking.length} defect(s) that block a game or kill a feature on ${r.gameVersion}: ${list}; ${tail}`,
    "Run `tower-bench check <folder>` for the full list and fix each.", { defects: blocking });
}

const hashOf = (f) => { try { return crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex"); } catch { return null; } };

/**
 * A zip next to its source folder: same mod, same version, same files.
 * @param {Ctx} ctx @returns {CheckResult | null}
 */
function zipMatchesFolder(ctx) {
  if (ctx.pkg.kind !== "zip" || !ctx.folder) return null;
  const src = loadMod(ctx.folder);
  const smi = src.modinfos[0];
  if (!smi) return null;
  if (smi.id !== ctx.mod.id) return result("zip-matches-folder", "FAIL", `the zip holds ${code(ctx.mod.id)}, the folder ${code(smi.id)}.`, "Zip the right folder.");
  const sv = smi.props.Version ?? null;
  if (sv !== ctx.version) return result("zip-matches-folder", "FAIL", `the zip holds version ${ctx.version}, the folder ${sv}: the zip is stale.`, "Rebuild the zip from the folder.");
  const byLower = new Map(ctx.pkg.files.map((f) => [f.toLowerCase(), f]));
  const wanted = src.files.filter((f) => src.declared.has(f.toLowerCase()) || src.loadedJs.has(path.join(src.root, f)));
  const differ = wanted.filter((f) => {
    const z = byLower.get(f.toLowerCase());
    return !z || hashOf(path.join(ctx.pkg.root, z)) !== hashOf(path.join(src.root, f));
  });
  if (differ.length) {
    return result("zip-matches-folder", "FAIL", `${differ.length} of the folder's ${wanted.length} loaded file(s) are missing from the zip or differ: ${listMore(differ, 4, code)}.`,
      "Rebuild the zip from the folder.", { files: differ });
  }
  return result("zip-matches-folder", "PASS", `the zip matches the folder: version ${sv}, ${wanted.length} loaded file(s) identical.`);
}

const STATUS_RANK = { FAIL: 0, WARN: 1, PASS: 2, INFO: 3 };

/** @param {Ctx} ctx @returns {CheckResult[]} */
function runChecks(ctx) {
  return [
    versionBumped(ctx), changelogEntry(ctx), zipMatchesFolder(ctx),
    declaredFiles(ctx), ...runtimeFiles(ctx), devJunk(ctx), nestedCopies(ctx), ...outsideFiles(ctx),
    probeFiles(ctx), devFlags(ctx), preflight(ctx),
    propResolves(ctx, "Name"), propResolves(ctx, "Description"), affectsSavedGames(ctx),
    ...checkVdfs(ctx), sizeSummary(ctx),
  ].filter((c) => c !== null).map((c) => ({ ...c, techniques: techniqueIds(`release:${c.check}`) }));
}

/**
 * Checks a release before it ships: a mod folder, its zip, or both (the zip is then checked against the folder).
 * @param {{ paths: any }} bench
 * @param {{ dir?: string | null, zip?: string | null, against?: string | null, analyse?: typeof analyseMod }} opts
 */
export async function releaseCheck(bench, { dir = null, zip = null, against = null, analyse = analyseMod }) {
  if (!dir && !zip) throw new BenchError("release-check <mod-folder> [--zip path] [--against path]");
  const pkg = openPackage(zip ?? /** @type {string} */ (dir));
  try {
    const ctx = makeContext(bench, pkg, { dir, zip, against, analyse });
    const checks = runChecks(ctx).sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
    const has = (s) => checks.some((c) => c.status === s);
    return { id: ctx.mod.id, version: ctx.version, modVersion: ctx.mi.version, verdict: has("FAIL") ? "FAIL" : has("WARN") ? "WARN" : "PASS",
      package: { kind: pkg.kind, path: pkg.source, files: pkg.files.length }, checks };
  } finally { pkg.close(); }
}

/** @returns {Ctx} */
function makeContext(bench, pkg, { dir, zip, against, analyse }) {
  const mod = loadMod(pkg.root);
  const mi = mod.modinfos.find((m) => path.dirname(m.path) === pkg.root) ?? mod.modinfos[0];
  if (!mi) throw new BenchError(`${zip ?? dir} has no .modinfo`);
  return { paths: bench.paths, pkg, mod, mi, version: mi.props.Version ?? null, analyse,
    folder: dir ? path.resolve(dir) : null, zip: zip ? path.resolve(zip) : null, against: against ?? null };
}
