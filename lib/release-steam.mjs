// Steam Workshop upload descriptions (.vdf beside the package): the content folder they upload must be this
// mod at this version, and the preview image they name must exist.
import fs from "node:fs";
import path from "node:path";
import { code } from "./static/util.mjs";
import { packageModinfos } from "./release-package.mjs";
import { result } from "./release-contents.mjs";

/** The quoted key/value pairs of a KeyValues (.vdf) file, keys lower-cased. Values may span lines. */
export function parseVdf(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const m of text.matchAll(/"([^"\\]+)"\s+"((?:[^"\\]|\\.)*)"/g)) out[m[1].toLowerCase()] = m[2].replace(/\\(.)/g, "$1");
  return out;
}

/** .vdf files in the package's folder, the folder checked, its parent and the zip's folder. */
function vdfFiles(ctx) {
  const dirs = new Set([ctx.pkg.kind === "folder" ? ctx.pkg.root : null, ctx.folder, ctx.folder && path.dirname(ctx.folder),
    ctx.zip && path.dirname(ctx.zip)].filter(Boolean).map((d) => path.resolve(/** @type {string} */ (d))));
  return [...dirs].flatMap((d) => {
    try { return fs.readdirSync(d).filter((n) => /\.vdf$/i.test(n)).map((n) => path.join(d, n)); } catch { return []; }
  });
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** What is wrong with the folder a .vdf uploads. */
function contentProblems(ctx, kv, base, out) {
  if (!kv.contentfolder) { out.warn.push("names no contentfolder"); return; }
  const content = path.resolve(base, kv.contentfolder);
  if (!fs.existsSync(content)) { out.fail.push(`uploads ${code(kv.contentfolder)}, which does not exist`); return; }
  const problem = uploadedMod(ctx, kv.contentfolder, content);
  if (problem) out.fail.push(problem);
  if (ctx.pkg.kind === "folder" && real(content) !== real(ctx.pkg.root)) out.warn.push(`uploads ${code(kv.contentfolder)}, not the folder checked`);
}

/** Is the uploaded folder this mod at this version? A problem, or null. */
function uploadedMod(ctx, name, content) {
  const top = packageModinfos(content).sort((a, b) => a.rel.split("/").length - b.rel.split("/").length)[0]?.info;
  if (!top) return `uploads ${code(name)}, which holds no .modinfo`;
  if (top.id !== ctx.mod.id) return `uploads ${code(top.id ?? "?")}, not ${code(ctx.mod.id)}`;
  if (ctx.version && top.props.Version !== ctx.version) {
    return `uploads version ${top.props.Version ?? "(none)"}, not ${ctx.version}: the content folder is stale`;
  }
  return null;
}

/** What is wrong with one .vdf, worst first. */
function vdfProblems(ctx, file, kv) {
  const base = path.dirname(file);
  /** @type {{ fail: string[], warn: string[] }} */
  const out = { fail: [], warn: [] };
  contentProblems(ctx, kv, base, out);
  if (kv.previewfile && !fs.existsSync(path.resolve(base, kv.previewfile))) out.fail.push(`names preview ${code(kv.previewfile)}, which does not exist`);
  if (kv.changenote && ctx.version && !kv.changenote.includes(ctx.version)) out.warn.push(`its changenote does not mention ${ctx.version}`);
  return out;
}

/** @returns {import("./release-contents.mjs").CheckResult[]} */
export function checkVdfs(ctx) {
  return vdfFiles(ctx).map((file) => {
    let kv;
    try { kv = parseVdf(fs.readFileSync(file, "utf8")); } catch (e) {
      return result("steam-vdf", "WARN", `${path.basename(file)} could not be read: ${e instanceof Error ? e.message : e}.`);
    }
    const { fail, warn } = vdfProblems(ctx, file, kv);
    const name = path.basename(file);
    const evidence = { file, contentfolder: kv.contentfolder ?? null, previewfile: kv.previewfile ?? null };
    if (fail.length || warn.length) {
      return result("steam-vdf", fail.length ? "FAIL" : "WARN", `${name} ${[...fail, ...warn].join("; ")}.`,
        "Point contentfolder at the built mod folder of this release, and previewfile at an image that exists (or drop it).", evidence);
    }
    return result("steam-vdf", "PASS", `${name} uploads this mod at ${ctx.version ?? "its version"}.`, undefined, evidence);
  });
}
