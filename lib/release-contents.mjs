// Release checks on what the package holds: the files the modinfo lists, files it ships that nothing loads,
// development leftovers, nested copies of the mod, files outside the mod folder, and test probes or debug
// switches left on.
import path from "node:path";
import { runtimeRefs } from "./static/check.mjs";
import { stripJsComments } from "./static/jsscan.mjs";
import { code, listMore, readText, relPath } from "./static/util.mjs";
import { human, packageModinfos, sizeOf } from "./release-package.mjs";

/**
 * @typedef {{ check: string, status: "PASS" | "FAIL" | "WARN" | "INFO", text: string, fix?: string,
 *   evidence?: any }} CheckResult
 * @typedef {{ pkg: import("./release-package.mjs").Package, mod: import("./static/mod.mjs").Mod,
 *   mi: import("./static/modinfo.mjs").Modinfo }} ContentsCtx
 */

/** @returns {CheckResult} */
export const result = (check, status, text, fix, evidence) => ({ check, status, text,
  ...(fix ? { fix } : {}), ...(evidence ? { evidence } : {}) });

/** @param {ContentsCtx} ctx @returns {CheckResult} */
export function declaredFiles({ mod }) {
  if (!mod.missing.length) return result("declared-files", "PASS", "every file the modinfo lists ships in the package.");
  return result("declared-files", "FAIL",
    `the modinfo lists ${mod.missing.length} file(s) the package does not ship: ${listMore(mod.missing, 4, (m) => `${code(m.item)} (${m.action})`)}. A missing data file rolls the database back; a missing script never runs.`,
    "Add the files to the package, or remove the items from the modinfo.", { missing: mod.missing });
}

/** @param {ContentsCtx} ctx @returns {CheckResult[]} */
export function runtimeFiles({ mod }) {
  const out = [];
  const r = runtimeRefs(mod);
  if (r.undeclared.length) {
    out.push(result("undeclared-runtime", "INFO",
      `the scripts load ${r.undeclared.length} file(s) at run time that no modinfo action declares: ${listMore(r.undeclared, 3, (u) => `${code(u.path)} (${u.kind} in ${u.file})`)}. They load anyway: the game serves any file in a loaded mod's folder to XMLHttpRequest and to import (watched on 1.5.0, 2026-10-03).`,
      "Optional: list them under ImportFiles so the modinfo names every file the mod uses.", { files: r.undeclared }));
  }
  const unused = [...mod.unloadedJs, ...mod.files.filter((f) => /\.(xml|sql)$/i.test(f) && !mod.declared.has(f.toLowerCase())
    && !/(^|\/)(text|l10n|loc|localization)\//i.test(f))];
  if (unused.length) {
    out.push(result("unused-files", "INFO",
      `ships ${unused.length} script or data file(s) that no action declares and no loaded script imports: ${listMore(unused, 4, code)}. They never run; dev leftovers usually.`,
      "Leave them out of the package unless something reads them.", { files: unused }));
  }
  return out;
}

const JUNK = [
  [/(^|\/)\.env(\.[^/]*)?$/, ".env files (can hold secrets)", "FAIL"],
  [/(^|\/)\.git(\/|$)/, ".git folders"],
  [/(^|\/)node_modules\//, "node_modules"],
  [/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i, "Finder and Explorer files"],
  [/(^|\/)__MACOSX\//, "__MACOSX folders"],
  [/\.map$/i, "source maps (ship them only on purpose)"],
  [/(\.(bak|orig|rej|swp|swo|tmp|old)|~)$/i, "backup and editor files"],
  [/(^|\/)(tests?|__tests__|spec)\//i, "test folders"],
  [/(^|\/)(\.vscode|\.idea|\.github|\.claude)\//, "editor and CI folders"],
  [/(^|\/)(dist|build|out)\//, "nested build output folders"],
  [/\.(zip|7z|rar|tgz|tar|gz)$/i, "archives"],
  [/(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|tsconfig\.json|jsconfig\.json|eslint\.config\.[cm]?js|\.eslintrc[^/]*|\.prettierrc[^/]*|\.editorconfig|\.gitignore|\.gitattributes|\.npmrc|\.nvmrc)$/, "build and tooling files"],
  [/(^|\/)(scratch|untitled)[^/]*$|(^|\/)(scratch|tmp|temp)\//i, "scratch files"],
  [/ (copy( \d+)?|\d+)\.[^./]+$/i, "duplicated files (\"name copy.js\", \"name 2.js\")"],
  [/\.log$/i, "log files"],
];

/** @param {ContentsCtx} ctx @returns {CheckResult} */
export function devJunk({ pkg }) {
  /** @type {Map<string, { status: string, files: string[] }>} */
  const hits = new Map();
  for (const f of pkg.files) {
    const j = JUNK.find(([rx]) => /** @type {RegExp} */ (rx).test(f));
    if (!j) continue;
    const label = /** @type {string} */ (j[1]);
    const h = hits.get(label) ?? { status: /** @type {string} */ (j[2] ?? "WARN"), files: [] };
    h.files.push(f);
    hits.set(label, h);
  }
  if (!hits.size) return result("dev-junk", "PASS", "no development leftovers (.git, node_modules, .DS_Store, source maps, backups, test folders).");
  const status = [...hits.values()].some((h) => h.status === "FAIL") ? "FAIL" : "WARN";
  return result("dev-junk", status,
    `the package ships development leftovers: ${[...hits].map(([label, h]) => `${label}: ${listMore(h.files, 2, code)}`).join("; ")}.`,
    "Build the package from an allow-list of the mod's files (the modinfo, its items, text, art, README, LICENSE).",
    Object.fromEntries([...hits].map(([label, h]) => [label, h.files])));
}

/** @param {ContentsCtx} ctx @returns {CheckResult} */
export function nestedCopies({ pkg, mi }) {
  const top = path.dirname(mi.path);
  const others = packageModinfos(pkg.root).filter((m) => path.dirname(path.join(pkg.root, m.rel)) !== top);
  const same = others.filter((m) => m.info.id && m.info.id === mi.id);
  const diff = others.filter((m) => !same.includes(m));
  if (same.length) {
    return result("nested-copy", "FAIL",
      `the package holds ${same.length} more cop(ies) of this mod (same id ${code(mi.id ?? "")}): ${listMore(same.map((m) => m.rel), 3, code)}. The game registers every copy; a duplicate id can load the wrong one or blank the screen (watched).`,
      "Remove the nested copy (often a dist/ or build folder copied in).", { modinfos: same.map((m) => m.rel) });
  }
  if (diff.length) {
    return result("nested-copy", "WARN",
      `the package holds ${diff.length} other modinfo(s): ${listMore(diff.map((m) => `${m.rel} (${m.info.id})`), 3, code)}. Each registers as a mod of its own.`,
      "Ship one mod per package unless the bundle is deliberate.", { modinfos: diff.map((m) => m.rel) });
  }
  return result("nested-copy", "PASS", "one modinfo, no nested copy of the mod.");
}

/** @param {ContentsCtx} ctx @returns {CheckResult[]} */
export function outsideFiles({ pkg, mod }) {
  const outside = mod.modinfos.flatMap((mi) => mi.outside.map((item) => `${path.basename(mi.path)}: ${item}`));
  const links = pkg.links.filter((l) => l.outside).map((l) => l.file);
  const bad = [...pkg.bad, ...outside, ...links];
  const out = [bad.length
    ? result("outside-files", "FAIL", `${bad.length} file(s) point or sit outside the mod folder: ${listMore(bad, 4, code)}.`,
      "Keep every file inside the mod's folder; zip that one folder.", { files: bad })
    : result("outside-files", "PASS", "every file sits inside the mod folder.")];
  if (pkg.kind === "zip" && (pkg.atZipRoot || pkg.tops.length > 1)) {
    out.push(result("zip-layout", "WARN", pkg.atZipRoot
      ? "the zip has no top folder: the modinfo sits at its root, so unzipping into Mods/ spills the files there."
      : `the zip has ${pkg.tops.length} top-level entries (${listMore(pkg.tops, 4, code)}); players unzip it into Mods/ and get each as a folder.`,
    "Zip the mod's folder itself, so the archive holds one folder named for the mod."));
  }
  return out;
}

/** @param {ContentsCtx} ctx @returns {CheckResult} */
export function sizeSummary({ pkg }) {
  const s = sizeOf(pkg.root, pkg.files);
  return result("size", "INFO", `${pkg.files.length} file(s), ${human(s.bytes)}; largest: ${s.largest.map((x) => `${x.rel} (${human(x.bytes)})`).join(", ")}.`,
    undefined, { files: pkg.files.length, bytes: s.bytes, largest: s.largest });
}

const PROBE_NAME = /probe|repro|harness|debug|selftest|self-test|(^|[-_.])tests?([-_.]|$)/i;

/** @param {ContentsCtx} ctx @returns {CheckResult | null} */
export function probeFiles({ pkg, mod }) {
  const files = pkg.files.filter((f) => /\.(js|xml|sql|css|html|modinfo)$/i.test(f) && PROBE_NAME.test(path.basename(f)));
  const loaded = new Set([...mod.loadedJs].map((j) => relPath(mod.root, j)));
  const loads = files.filter((f) => mod.declared.has(f.toLowerCase()) || loaded.has(f));
  const ids = mod.modinfos.flatMap((mi) => [mi.id, ...mi.groups.map((g) => g.id)]).filter((i) => i && /probe|repro|harness|selftest/i.test(i));
  if (!files.length && !ids.length) return null;
  return result("probe-files", "WARN",
    `looks like test or debug code ships: ${[loads.length ? `loaded: ${listMore(loads, 3, code)}` : "", files.length > loads.length ? `shipped, not loaded: ${listMore(files.filter((f) => !loads.includes(f)), 3, code)}` : "", ids.length ? `ids: ${listMore(ids, 3, code)}` : ""].filter(Boolean).join("; ")}. A probe that loads runs in every player's game. Name-based guess: check each.`,
    "Leave probes and harness hooks out of the release, or gate them off.", { loaded: loads, files, ids });
}

const FLAGS = [
  [/\b(?:const|let|var)\s+(\w*(?:DEBUG|VERBOSE|DEV_?MODE|TRACE)\w*)\s*=\s*(?:true|1|!0)\s*[;,\n]/gi, "debug switch on"],
  [/\bLOG_LEVEL\s*[=:]\s*["']?(?:debug|trace|verbose|all)\b/gi, "verbose log level"],
  [/^\s*debugger\s*;?\s*$/gm, "debugger statement"],
];
const CONSOLE = /\bconsole\.(?:log|debug|info|trace)\s*\(/g;
// Above this many console calls per thousand lines (and at least CONSOLE_MIN in all), logging was probably
// left on from development: every call writes to UI.log on every player's machine.
const CONSOLE_DENSITY = 10;
const CONSOLE_MIN = 25;

/** @param {ContentsCtx} ctx @returns {CheckResult | null} */
export function devFlags({ mod }) {
  const hits = [];
  let calls = 0;
  let lines = 0;
  for (const full of mod.loadedJs) {
    let text;
    try { text = stripJsComments(readText(full)); } catch { continue; }
    const rel = relPath(mod.root, full);
    for (const [rx, label] of FLAGS) {
      for (const m of text.matchAll(/** @type {RegExp} */ (rx))) hits.push(`${rel}: ${label} (${m[0].trim().slice(0, 50)})`);
    }
    calls += (text.match(CONSOLE) ?? []).length;
    lines += text.split("\n").length;
  }
  const dense = calls >= CONSOLE_MIN && (calls * 1000) / Math.max(lines, 1) > CONSOLE_DENSITY;
  if (!hits.length && !dense) return null;
  const density = dense ? `${calls} console.log calls in ${lines} lines of loaded script (${Math.round((calls * 1000) / lines)} per 1000)` : "";
  return result("dev-flags", "WARN", `development switches look left on: ${[listMore(hits, 3, code), density].filter(Boolean).join("; ")}.`,
    "Turn debug switches off and trim logging before release.", { flags: hits, consoleCalls: calls, lines });
}
