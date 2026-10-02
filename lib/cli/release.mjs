import fs from "node:fs";
import { BenchError } from "../bench.mjs";
import { l10nCheck, l10nLive } from "../l10n.mjs";
import { releaseCheck } from "../release.mjs";
import { errorText, out } from "./common.mjs";

/** @param {any} r */
function printRelease(r) {
  out(`${r.id} ${r.version ?? "(no version)"}: ${r.verdict}  (${r.package.kind} ${r.package.path}, ${r.package.files} files)`);
  for (const c of r.checks) {
    out(`  ${c.status.padEnd(4)} ${c.check}: ${c.text}`);
    if (c.fix && (c.status === "FAIL" || c.status === "WARN")) out(`       fix: ${c.fix}`);
  }
  out("Read from files, not run.");
}

const SEVERITY = { error: "ERROR", warn: "WARN ", info: "INFO " };

/** @returns {never} */
const fail = (e) => { throw e instanceof BenchError ? e : new BenchError(errorText(e)); };

/** @param {any} r */
function printL10n(r) {
  out(`${r.id}: ${r.used} tag(s) used, ${r.english} defined in English${r.gameVersion ? `, checked against game ${r.gameVersion}` : ", base game not read"}`);
  for (const l of r.languages) out(`  ${l.lang.padEnd(11)} ${String(l.tags).padStart(5)} tags, ${l.missing} missing, ${l.extra} extra`);
  for (const f of r.findings) out(`  ${SEVERITY[f.severity]} ${f.rule}: ${f.text}`);
  if (!r.findings.length) out("  no findings");
}

/** @type {import("./common.mjs").Handler} */
async function releaseCommand({ bench, opt }, [dir]) {
  // --zip and --against are this module's options in parseCli
  const o = /** @type {Record<string, any>} */ (opt);
  const r = await releaseCheck(bench, { dir: dir ?? null, zip: o["zip"] ?? null, against: o["against"] ?? null });
  if (r.verdict === "FAIL") process.exitCode = 1;
  return opt.json ? out(r) : printRelease(r);
}

/** @param {any} r */
function printLive(r) {
  for (const i of r.issues) out(`  ${i.rule}: ${i.path}\n      ${i.detail}`);
  const cut = r.truncated ? " (stopped at the element limit)" : "";
  out(`${r.issues.length} issue(s) in ${r.visited} element(s); page lang ${r.lang ?? "(none)"}${cut}`);
}

/** @type {import("./common.mjs").Handler} */
async function l10nCommand({ bench, opt }, [dir]) {
  if (dir === "live" && !fs.existsSync(dir)) {
    const r = await l10nLive(bench, { scope: opt.scope ?? null });
    return opt.json ? out(r) : printLive(r);
  }
  if (!dir) throw new BenchError("l10n <mod-folder> | l10n live [--scope CSS]");
  const r = await l10nCheck(bench, { dir }).catch(fail);
  if (r.findings.some((f) => f.severity === "error")) process.exitCode = 1;
  return opt.json ? out(r) : printL10n(r);
}

/** @type {Record<string, import("./common.mjs").Handler>} */
export const RELEASE_COMMANDS = { "release-check": releaseCommand, l10n: l10nCommand };

export const RELEASE_HELP = `  release-check <mod-folder> [--zip F] [--against F]
                                       before a release: version raised (against F, or the Workshop
                                       copy), changelog entry, the zip matches the folder, no missing
                                       or stray files, no dev leftovers or nested copy, no probes or
                                       debug switches left on, pre-flight, name and description resolve,
                                       AffectsSavedGames, Steam .vdf; exit 1 on any FAIL
  l10n <mod-folder>                    localization lint: tags used but not defined, each language
                                       against English, duplicates, language codes, placeholders,
                                       fonts that cannot draw CJK text; exit 1 on any error
  l10n live [--scope CSS]              visible text in the running UI that draws as boxes`;

export const RELEASE_ROUTES = {
  "GET /api/release-check": (bench, _req, q) => {
    const dir = q.get("dir") || null;
    const zip = q.get("zip") || null;
    if (!dir && !zip) throw new BenchError("which mod folder or zip?");
    return releaseCheck(bench, { dir, zip, against: q.get("against") || null }).catch(fail);
  },
  "GET /api/l10n": (bench, _req, q) => {
    const dir = q.get("dir");
    if (!dir) throw new BenchError("which mod folder?");
    return l10nCheck(bench, { dir }).catch(fail);
  },
  "GET /api/l10n/live": (bench, _req, q) => l10nLive(bench, { scope: q.get("scope") || null }).catch(fail),
};
