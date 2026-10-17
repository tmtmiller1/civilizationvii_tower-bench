// Steam Workshop upload through the Steamworks API (ISteamUGC), running as the game with the Steam client's signed-in
// account. steamcmd's workshop_build_item sends a preview image to legacy cloud storage, which Civilization VII refuses
// with "Access Denied", rolling the whole update back; this sends it through SetItemPreview instead. That only helps an
// item made by the official tools (creator app 3688890): watched on an item steamcmd made (creator app 1295660), Steam
// refused the image as 1295660 ("UGC Upload Access Denied"), and as 3688890 it stored the image but failed the update.
// Only the files, the change note and the preview are sent. The title, description, visibility and tags stay as they
// are on Steam, because the Workshop page text is kept by hand there.
import fs from "node:fs";
import path from "node:path";
import { BenchError } from "./bench.mjs";
import { parseVdf } from "./release-steam.mjs";

export const CIV7_APP_ID = 1295660;
export const SDK_APP_ID = 3688890;
const PREVIEW_MAX = 1024 * 1024;
const PREVIEW_TYPES = /\.(png|jpe?g|gif)$/i;
const PAGE_FIELDS = ["title", "description", "visibility", "tags"];

/**
 * @typedef {{ vdf: string, appId: number, itemId: string | null, content: string | null, changeNote: string | null,
 *   preview: string | null, previewBytes: number | null, kept: string[], problems: string[] }} UploadPlan
 */

/** The item and app the .vdf names. @param {Record<string, string>} kv @param {string[]} problems */
function itemOf(kv, problems) {
  const itemId = /^[1-9]\d*$/.test(kv.publishedfileid ?? "") ? kv.publishedfileid : null;
  if (!itemId) problems.push("the .vdf has no publishedfileid; make the item with steamcmd first, then upload here");
  const appId = Number(kv.appid ?? CIV7_APP_ID);
  if (appId !== CIV7_APP_ID) problems.push(`the .vdf is for app ${kv.appid}, not Civilization VII (${CIV7_APP_ID})`);
  return { itemId, appId };
}

/** The mod folder to send. @param {string | null} content @param {string[]} problems */
function checkContent(content, problems) {
  if (!content) problems.push("the .vdf has no contentfolder");
  else if (!fs.existsSync(content) || !fs.statSync(content).isDirectory()) problems.push(`content folder ${content} doesn't exist`);
  else if (!fs.readdirSync(content).some((n) => n.endsWith(".modinfo"))) problems.push(`content folder ${content} has no .modinfo at its top`);
  return content;
}

/** The preview image's size in bytes, or null when it is missing. @param {string} image @param {string[]} problems */
function previewSize(image, problems) {
  if (!PREVIEW_TYPES.test(image)) problems.push(`preview ${image} should be a PNG, JPG or GIF`);
  if (!fs.existsSync(image)) { problems.push(`preview ${image} doesn't exist`); return null; }
  const bytes = fs.statSync(image).size;
  if (bytes > PREVIEW_MAX) problems.push(`preview ${image} is ${Math.ceil(bytes / 1024)} KB; Steam takes up to 1 MB`);
  return bytes;
}

/** The preview to send: the one given, else the .vdf's. @param {string[]} problems */
function imageOf(given, named, previewOnly, problems) {
  const image = given ? path.resolve(given) : named;
  if (!image && previewOnly) problems.push("--preview-only needs an image: --preview FILE, or a previewfile in the .vdf");
  return image;
}

/**
 * What an upload of this .vdf would send. Relative paths resolve against the .vdf's folder, as steamcmd does.
 * @param {string} vdf
 * @param {{ preview?: string | null, previewOnly?: boolean }} [opts] preview: an image to send instead of the
 *   .vdf's previewfile; previewOnly: send the image alone, leaving the files and change note as they are
 * @returns {UploadPlan}
 */
export function uploadPlan(vdf, opts = {}) {
  const previewOnly = !!opts.previewOnly;
  const file = path.resolve(vdf);
  if (!fs.existsSync(file)) throw new BenchError(`no such file: ${vdf}`);
  const kv = parseVdf(fs.readFileSync(file, "utf8"));
  const at = (p) => (p ? path.resolve(path.dirname(file), p) : null);
  /** @type {string[]} */
  const problems = [];
  const { itemId, appId } = itemOf(kv, problems);
  const content = previewOnly ? null : checkContent(at(kv.contentfolder), problems);
  const image = imageOf(opts.preview, at(kv.previewfile), previewOnly, problems);
  const previewBytes = image ? previewSize(image, problems) : null;
  const changeNote = (!previewOnly && kv.changenote) || null;
  const kept = [...(previewOnly ? ["files", "change note"] : []), ...PAGE_FIELDS];
  return { vdf: file, appId, itemId, content, changeNote, preview: image, previewBytes, kept, problems };
}

/**
 * A Steamworks session running as `appId`. steamworks.js pumps callbacks on an interval it never clears, which would
 * keep the process alive after the upload; the handle is caught as init makes it and cleared on close.
 * @param {number} appId
 */
export async function openSteam(appId) {
  /** @type {any} */
  let sw;
  try { sw = (await import("steamworks.js")).default; } catch {
    throw new BenchError("workshop-upload needs steamworks.js: run `npm install` in the tower-bench folder");
  }
  const realSetInterval = /** @type {any} */ (globalThis.setInterval);
  /** @type {any} */
  let pump;
  globalThis.setInterval = /** @type {any} */ ((/** @type {any[]} */ ...a) => (pump = realSetInterval(...a)));
  try {
    return { client: sw.init(appId), close: () => clearInterval(pump) };
  } catch (e) {
    const why = e instanceof Error ? e.message : e;
    throw new BenchError(`Steam wouldn't start as app ${appId} (${why}); is the Steam client running and signed in?`);
  } finally {
    globalThis.setInterval = realSetInterval;
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fresh = { cachedResponseMaxAge: 0 };

/** @param {any} item */
const itemState = (item) => item && { title: item.title, timeUpdated: item.timeUpdated,
  previewUrl: item.previewUrl || null, creatorAppId: item.creatorAppId ?? null };

/** Why Steam refused an update, with what was watched about previews on items the game made. */
function refusal(plan, before, e) {
  const why = `Steam refused the update (${e instanceof Error ? e.message : e})`;
  if (!plan.preview || before.creatorAppId === SDK_APP_ID) return why;
  return `${why}. This item was made as app ${before.creatorAppId ?? "?"}, not by the official tools (${SDK_APP_ID}), ` +
    "and Steam has refused a preview for such items every way it was tried; send the files without --preview, and add " +
    "the image on the Workshop page in a browser";
}

/** Who Steam is signed in as, and the item as it stands; refuses an item that account doesn't own. */
async function ownedItem(client, plan, itemId) {
  const user = { name: client.localplayer.getName(), steamId: String(client.localplayer.getSteamId().steamId64) };
  const item = await client.workshop.getItem(itemId, fresh);
  if (!item) throw new BenchError(`Steam has no Workshop item ${plan.itemId}, or ${user.name} can't see it`);
  const owner = String(item.owner?.steamId64);
  if (owner !== user.steamId) {
    throw new BenchError(`item ${plan.itemId} belongs to ${owner}; Steam is signed in as ${user.name} (${user.steamId})`);
  }
  return { user, before: itemState(item) };
}

/** The ISteamUGC update for a plan: only what it sends. @param {UploadPlan} plan */
function updateOf(plan) {
  /** @type {Record<string, string>} */
  const update = {};
  if (plan.content) update.contentPath = plan.content;
  if (plan.changeNote) update.changeNote = plan.changeNote;
  if (plan.preview) update.previewPath = plan.preview;
  return update;
}

/** Steam answers before its item query shows the update; read until it does, or give up after `tries`. */
async function watchItem(client, itemId, before, wantsPreview, opts) {
  const settleMs = opts.settleMs ?? 2000;
  const tries = opts.tries ?? 10;
  let after = null;
  for (let i = 0; i < tries; i++) {
    after = itemState(await client.workshop.getItem(itemId, fresh));
    const moved = after && (after.timeUpdated > before.timeUpdated || after.previewUrl !== before.previewUrl);
    if (moved && (!wantsPreview || after.previewUrl)) return { after, watched: true };
    await wait(settleMs);
  }
  return { after, watched: false };
}

/**
 * Check the plan against Steam and, with `send`, upload it and read the item back until Steam shows the change.
 * @param {UploadPlan} plan
 * @param {{ send?: boolean, steam?: typeof openSteam, settleMs?: number, tries?: number }} [opts] steam, settleMs and
 *   tries: replaced in tests
 */
export async function workshopUpload(plan, opts = {}) {
  if (plan.problems.length) throw new BenchError(`${path.basename(plan.vdf)}: ${plan.problems.join("; ")}`);
  if (!plan.content && !plan.preview) throw new BenchError("nothing to send: no content folder and no preview");
  const itemId = BigInt(/** @type {string} */ (plan.itemId));
  const session = await (opts.steam ?? openSteam)(plan.appId);
  try {
    const { user, before } = await ownedItem(session.client, plan, itemId);
    const report = { itemId: plan.itemId, user, before, sent: false, after: null, watched: false,
      needsToAcceptAgreement: false, seconds: 0 };
    if (!opts.send) return report;
    const t0 = Date.now();
    const r = await session.client.workshop.updateItem(itemId, updateOf(plan), plan.appId).catch((e) => {
      throw new BenchError(refusal(plan, before, e));
    });
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    const seen = await watchItem(session.client, itemId, before, !!plan.preview, opts);
    return { ...report, ...seen, sent: true, seconds, needsToAcceptAgreement: !!r?.needsToAcceptAgreement };
  } finally {
    session.close();
  }
}
