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

export function planDeploy(srcDir, paths, rows) {
  const info = readModinfo(srcDir);
  const copies = rows.filter((r) => r.id === info.id);
  const live = copies.filter((r) => !r.disabled);
  const ownDeploy = OWN_DEPLOY.find((f) => fs.existsSync(path.join(srcDir, f))) ?? null;
  const uiFiles = info.items.filter(isUiFile).filter((rel) => fs.existsSync(path.join(srcDir, rel)))
    .map((rel) => ({ rel, hash: fileHash(path.join(srcDir, rel)) }));
  const base = { modId: info.id, srcDir, ownDeploy, uiFiles };
  if (!copies.length) return { ...base, refuse: `the game has never registered mod id ${info.id}. Copy the folder into Mods/ once and start the game so it scans it.` };
  if (live.length > 1) return { ...base, refuse: `${live.length} copies of ${info.id} are enabled; disable all but one in the game's Add-Ons screen first.` };
  if (!live.length) return { ...base, refuse: `no copy of ${info.id} is enabled; enable the one you edit in Add-Ons first.` };
  const liveDir = path.dirname(live[0].path);
  const src = sourceOf(live[0].path, paths);
  if (src.kind === "workshop") {
    return { ...base, liveDir, refuse: `the copy the game loads is ${src.label}. Steam owns that folder and replaces it on update, so edits deployed there are lost and edits anywhere else do nothing. In Add-Ons, enable your local copy and disable the Workshop one, then deploy.` };
  }
  if (path.resolve(liveDir) === path.resolve(srcDir)) return { ...base, liveDir, liveLabel: src.label, inPlace: true, changes: [], missing: [] };
  const changes = [];
  const missing = [];
  for (const rel of [info.file, ...info.items]) {
    const from = path.join(srcDir, rel);
    if (!fs.existsSync(from)) { missing.push(rel); continue; }
    const had = fileHash(path.join(liveDir, rel));
    const now = fileHash(from);
    if (had !== now) changes.push({ rel, state: had === null ? "new" : "changed", hash: now, ui: isUiFile(rel) });
  }
  return { ...base, liveDir, liveLabel: src.label, changes, missing };
}

export function applyDeploy(plan) {
  for (const c of plan.changes) {
    const to = path.join(plan.liveDir, c.rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(plan.srcDir, c.rel), to);
  }
  return plan.changes.length;
}
