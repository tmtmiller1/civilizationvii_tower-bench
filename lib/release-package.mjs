// What a release ships: a zip or a folder, opened read-only into a list of files and the folder that holds
// the mod. Zips are read with the system's own tools (no dependencies): unzip on macOS and Linux, tar.exe on
// Windows 10 and later, which reads zip archives too.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BenchError } from "./bench.mjs";
import { parseModinfo } from "./static/modinfo.mjs";
import { relPath, walkFiles } from "./static/util.mjs";

/**
 * @typedef {{ kind: "zip" | "folder", source: string, root: string, files: string[], bad: string[],
 *   tops: string[], links: { file: string, outside: boolean }[], atZipRoot: boolean, close: () => void }} Package
 */

const isWindows = () => process.platform === "win32";

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const why = /** @type {any} */ (e).code === "ENOENT"
      ? `${cmd} is not installed (the bench reads zips with unzip, or tar.exe on Windows)` : String(/** @type {any} */ (e).stderr || e);
    throw new BenchError(`cannot read the zip: ${why.trim()}`);
  }
}

/** Entry names of a zip, as stored (folders end in "/"). */
export function zipEntries(zip) {
  const out = isWindows() ? run("tar", ["-tf", zip]) : run("unzip", ["-Z1", zip]);
  return out.split(/\r?\n/).filter(Boolean);
}

function extractZip(zip, dest) {
  // Both tools refuse entries that climb out with ".." or an absolute path; those are reported separately.
  if (isWindows()) run("tar", ["-xf", zip, "-C", dest]);
  else run("unzip", ["-qq", "-o", zip, "-d", dest]);
}

/** An entry that would land outside the folder it is unpacked into. */
export const escapes = (name) => /^([A-Za-z]:|[\\/])/.test(name) || name.split(/[\\/]/).includes("..");

function symlinks(root, files) {
  const out = [];
  const real = fs.realpathSync(root);
  for (const rel of files) {
    const full = path.join(root, rel);
    if (!fs.lstatSync(full).isSymbolicLink()) continue;
    let target = "";
    try { target = fs.realpathSync(full); } catch { /* dangling */ }
    out.push({ file: rel, outside: !target || !target.startsWith(real + path.sep) });
  }
  return out;
}

/** The folder of the shallowest modinfo under dir, or null. */
export function modRoot(dir) {
  const infos = walkFiles(dir, { all: true }).filter((f) => f.endsWith(".modinfo") && !f.includes(`${path.sep}__MACOSX${path.sep}`))
    .sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
  return infos.length ? path.dirname(infos[0]) : null;
}

function openZip(zip) {
  if (!fs.existsSync(zip)) throw new BenchError(`no such zip: ${zip}`);
  const names = zipEntries(zip);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-release-"));
  const close = () => fs.rmSync(tmp, { recursive: true, force: true });
  try {
    extractZip(zip, tmp);
  } catch (e) { close(); throw e; }
  const root = modRoot(tmp);
  if (!root) { close(); throw new BenchError(`${zip} holds no .modinfo`); }
  const tops = [...new Set(names.filter((n) => !escapes(n)).map((n) => n.split(/[\\/]/)[0]))].filter((t) => t !== "__MACOSX");
  const files = walkFiles(root, { all: true }).map((f) => relPath(root, f));
  const outsideRoot = walkFiles(tmp, { all: true }).map((f) => relPath(tmp, f))
    .filter((f) => !path.join(tmp, f).startsWith(root + path.sep));
  return { kind: /** @type {const} */ ("zip"), source: path.resolve(zip), root, files, tops, close,
    bad: [...names.filter(escapes), ...(root === tmp ? [] : outsideRoot.filter((f) => !f.startsWith("__MACOSX/")))],
    links: symlinks(root, files), atZipRoot: root === tmp };
}

function openFolder(dir) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new BenchError(`no such folder: ${dir}`);
  const files = walkFiles(root, { all: true }).map((f) => relPath(root, f));
  return { kind: /** @type {const} */ ("folder"), source: root, root, files, tops: [], bad: [], links: symlinks(root, files),
    close: () => {}, atZipRoot: false };
}

/**
 * Opens a zip or a folder for reading. Call close() when done: a zip is unpacked to a temporary folder.
 * @param {string} p
 * @returns {Package}
 */
export function openPackage(p) {
  return /\.zip$/i.test(p) && fs.existsSync(p) && fs.statSync(p).isFile() ? openZip(p) : openFolder(p);
}

/**
 * Every modinfo in a package, parsed, with its folder relative to the package root.
 * @param {string} root
 */
export function packageModinfos(root) {
  return walkFiles(root, { all: true }).filter((f) => f.endsWith(".modinfo"))
    .map((f) => ({ rel: relPath(root, f), info: parseModinfo(f) }));
}

/** Numeric parts compared in order: 1.10.0 > 1.9.2; 1.3 equals 1.3.0. */
export function compareVersions(a, b) {
  const parts = (v) => (String(v ?? "").match(/\d+/g) ?? []).map(Number);
  const pa = parts(a);
  const pb = parts(b);
  const n = Math.max(pa.length, pb.length);
  const i = Array.from({ length: n }, (_, k) => k).find((k) => (pa[k] ?? 0) !== (pb[k] ?? 0));
  return i === undefined ? 0 : Math.sign((pa[i] ?? 0) - (pb[i] ?? 0));
}

/** Total bytes and the largest files. */
export function sizeOf(root, files) {
  const sizes = files.map((rel) => {
    try { return { rel, bytes: fs.statSync(path.join(root, rel)).size }; } catch { return { rel, bytes: 0 }; }
  });
  const bytes = sizes.reduce((n, s) => n + s.bytes, 0);
  return { bytes, largest: sizes.sort((a, b) => b.bytes - a.bytes).slice(0, 5) };
}

export const human = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB`
  : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
