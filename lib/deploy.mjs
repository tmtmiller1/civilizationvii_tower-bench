import fs from "node:fs";
import path from "node:path";
import { sourceOf } from "./mods.mjs";

export function readModinfo(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`no such folder: ${dir}`);
  const file = fs.readdirSync(dir).find((f) => f.endsWith(".modinfo"));
  if (!file) throw new Error(`no .modinfo in ${dir}`);
  const xml = fs.readFileSync(path.join(dir, file), "utf8");
  const id = xml.match(/<Mod\b[^>]*\bid="([^"]+)"/)?.[1];
  if (!id) throw new Error(`${file} has no <Mod id="...">`);
  const items = [...new Set([...xml.matchAll(/<Item\b[^>]*>([^<]+)<\/Item>/g)].map((m) => m[1].trim().replace(/^\.?\//, "")))];
  // Deploy writes each item into the live copy, so an item must not climb out of the mod folder.
  const outside = items.filter((rel) => /^[A-Za-z]:/.test(rel) || rel.split(/[\\/]/).includes(".."));
  if (outside.length) throw new Error(`${file} lists files outside the mod folder: ${outside.join(", ")}`);
  return { id, file, items };
}

// The same FNV-1a runs in the page over the text the game serves, so the two can be compared
// without a crypto API in GameFace.
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

const fileHash = (p) => (fs.existsSync(p) ? fnv1a(fs.readFileSync(p, "utf8")) : null);

// UI files are read by the page on load; data and text are compiled into the databases when a game
// starts, so no reload short of a new game applies them.
export const isUiFile = (rel) => /\.(js|css|html|json)$/i.test(rel);

// A mod with its own deploy step (an allow-list that ships images, a cleanup of stray files) should
// be deployed with it; the bench then only proves the result.
const OWN_DEPLOY = ["scripts/deploy.mjs", "scripts/deploy.sh", "install-dev.sh", "deploy.sh"];

/**
 * @typedef {{ rel: string, state: string, hash: string | null, ui: boolean }} DeployChange
 * @typedef {{ modId: string, srcDir: string, ownDeploy: string | null, uiFiles: { rel: string, hash: string | null }[],
 *   refuse?: string, liveDir?: string, liveLabel?: string, inPlace?: boolean, changes?: DeployChange[],
 *   missing?: string[] }} DeployPlan
 */

function copiesRefusal(id, copies, live) {
  if (!copies.length) return `the game has never registered mod id ${id}. Copy the folder into Mods/ once and start the game so it scans it.`;
  if (live.length > 1) return `${live.length} copies of ${id} are enabled; disable all but one in the game's Add-Ons screen first.`;
  if (!live.length) return `no copy of ${id} is enabled; enable the one you edit in Add-Ons first.`;
  return null;
}

const workshopRefusal = (label) => `the copy the game loads is ${label}. Steam owns that folder and replaces it on update, so edits deployed there are lost and edits anywhere else do nothing. In Add-Ons, enable your local copy and disable the Workshop one, then deploy.`;

function diffFiles(srcDir, liveDir, rels) {
  /** @type {DeployChange[]} */
  const changes = [];
  /** @type {string[]} */
  const missing = [];
  for (const rel of rels) {
    const from = path.join(srcDir, rel);
    if (!fs.existsSync(from)) { missing.push(rel); continue; }
    const had = fileHash(path.join(liveDir, rel));
    const now = fileHash(from);
    if (had !== now) changes.push({ rel, state: had === null ? "new" : "changed", hash: now, ui: isUiFile(rel) });
  }
  return { changes, missing };
}

/** @returns {DeployPlan} */
export function planDeploy(srcDir, paths, rows) {
  const info = readModinfo(srcDir);
  const copies = rows.filter((r) => r.id === info.id);
  const live = copies.filter((r) => !r.disabled);
  const ownDeploy = OWN_DEPLOY.find((f) => fs.existsSync(path.join(srcDir, f))) ?? null;
  const uiFiles = info.items.filter(isUiFile).filter((rel) => fs.existsSync(path.join(srcDir, rel)))
    .map((rel) => ({ rel, hash: fileHash(path.join(srcDir, rel)) }));
  const base = { modId: info.id, srcDir, ownDeploy, uiFiles };
  const refuse = copiesRefusal(info.id, copies, live);
  if (refuse) return { ...base, refuse };
  const liveDir = path.dirname(live[0].path);
  const src = sourceOf(live[0].path, paths);
  if (src.kind === "workshop") return { ...base, liveDir, refuse: workshopRefusal(src.label) };
  if (path.resolve(liveDir) === path.resolve(srcDir)) {
    return { ...base, liveDir, liveLabel: src.label, inPlace: true, changes: [], missing: [] };
  }
  return { ...base, liveDir, liveLabel: src.label, ...diffFiles(srcDir, liveDir, [info.file, ...info.items]) };
}

export function applyDeploy(plan) {
  const changes = plan.changes ?? [];
  for (const c of changes) {
    const to = path.join(plan.liveDir, c.rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(plan.srcDir, c.rel), to);
  }
  return changes.length;
}
