import path from "node:path";
import { child, descendants, parseLenient } from "./xml.mjs";
import { readText } from "./util.mjs";

/**
 * @typedef {{ type: string, value: string, attrs: Record<string, string> }} Condition
 * @typedef {{ id: string, any: boolean, conds: Condition[] }} Criteria
 * @typedef {{ type: string, items: string[], locales: (string | null)[] }} Action
 * @typedef {{ id: string | null, scope: string, criteriaId: string | null, criteria: Criteria | null,
 *   loadOrder: string | null, actions: Action[] }} Group
 * @typedef {{ path: string, xmlError: string | null, id: string | null, version: string | null, name: string | null,
 *   props: Record<string, string>, deps: { id: string, title: string }[], refs: { id: string, title: string }[],
 *   criteria: Record<string, Criteria>, groups: Group[], excludes: { modId: string, groupId: string }[],
 *   loc: Record<string, string>, items: string[], outside: string[] }} Modinfo
 */

const text = (n) => (n?.text ?? "").trim();

// An item names a file inside the mod folder; one that climbs out (a drive letter or a ".." segment) is
// not the mod's file to load. Same rule as deploy's readModinfo.
const climbsOut = (rel) => /^[A-Za-z]:/.test(rel) || rel.split(/[\\/]/).includes("..");

/** Item text with a trailing comment fragment removed and a leading "./" or "/" dropped. */
export const cleanItem = (item) => item.split("<!--")[0].trim().replace(/^\.?\//, "");

/**
 * @param {string} file
 * @returns {Modinfo}
 */
export function parseModinfo(file) {
  const raw = readText(file);
  /** @type {Modinfo} */
  const info = {
    path: file, xmlError: null, id: null, version: null, name: null, props: {}, deps: [], refs: [],
    criteria: {}, groups: [], excludes: [], loc: {}, items: [], outside: [],
  };
  const { root, error } = parseLenient(raw, { repair: false });
  if (!root) return regexFallback(info, raw, error);
  readHeader(info, root);
  readCriteria(info, root);
  readGroups(info, root);
  readLoc(info, root);
  finish(info);
  return info;
}

function readHeader(info, root) {
  info.id = root.attrs.id ?? null;
  info.version = root.attrs.version ?? null;
  for (const c of child(root, "Properties")?.children ?? []) info.props[c.tag] = text(c);
  info.deps = modRefs(child(root, "Dependencies"));
  info.refs = modRefs(child(root, "References"));
}

const modRefs = (el) => (el?.children ?? []).filter((c) => c.tag === "Mod").map((m) => ({ id: m.attrs.id, title: m.attrs.title ?? "" }));

function regexFallback(info, raw, error) {
  info.xmlError = error;
  info.id = raw.match(/<Mod[^>]*\bid="([^"]+)"/)?.[1] ?? null;
  for (const k of ["Name", "Description", "Authors", "AffectsSavedGames"]) {
    const m = raw.match(new RegExp(`<${k}>([\\s\\S]*?)</${k}>`));
    if (m) info.props[k] = m[1].trim();
  }
  info.name = info.props.Name ?? null;
  return info;
}

function readCriteria(info, root) {
  for (const c of (child(root, "ActionCriteria")?.children ?? []).filter((n) => n.tag === "Criteria")) {
    const conds = c.children.map((ch) => ({ type: ch.tag, value: text(ch), attrs: ch.attrs }));
    info.criteria[c.attrs.id] = { id: c.attrs.id, any: /^(1|true)$/i.test(c.attrs.any ?? ""), conds };
  }
}

function readGroups(info, root) {
  for (const g of (child(root, "ActionGroups")?.children ?? []).filter((n) => n.tag === "ActionGroup")) {
    const grp = newGroup(info, g);
    for (const ex of g.children.filter((n) => n.tag === "Exclude")) {
      info.excludes.push({ modId: ex.attrs.mod_id, groupId: ex.attrs.action_group_id });
    }
    for (const a of child(g, "Actions")?.children ?? []) addAction(grp, a);
    info.groups.push(grp);
  }
}

/** @returns {Group} */
function newGroup(info, g) {
  const criteriaId = g.attrs.criteria ?? null;
  const props = child(g, "Properties");
  const lo = props ? child(props, "LoadOrder") : undefined;
  return {
    id: g.attrs.id ?? null, scope: (g.attrs.scope ?? "game").toLowerCase(), criteriaId,
    criteria: (criteriaId && info.criteria[criteriaId]) || null, loadOrder: lo ? text(lo) : null, actions: [],
  };
}

function addAction(grp, a) {
  let act = grp.actions.find((x) => x.type === a.tag);
  if (!act) {
    act = { type: a.tag, items: [], locales: [] };
    grp.actions.push(act);
  }
  for (const i of a.children.filter((n) => n.tag === "Item")) {
    const item = text(i);
    if (!item) continue;
    act.items.push(item);
    act.locales.push(i.attrs.locale ?? a.attrs.locale ?? null);
  }
}

function readLoc(info, root) {
  const lt = child(root, "LocalizedText");
  if (!lt) return;
  for (const t of descendants(lt, "Text")) {
    if (!t.attrs.id) continue;
    for (const ch of t.children) {
      if (ch.tag.toLowerCase().startsWith("en")) info.loc[t.attrs.id] = text(ch);
    }
  }
}

function finish(info) {
  const items = new Set(info.groups.flatMap((g) => g.actions.flatMap((a) => a.items.map(cleanItem))));
  info.items = [...items];
  info.outside = info.items.filter(climbsOut);
  const name = info.props.Name ?? null;
  info.name = name && name.startsWith("LOC_") ? info.loc[name] ?? name : name;
}

/** Ages an action group loads in, from its criteria's AgeInUse conditions; null means every age. */
export function groupAges(group) {
  const ages = new Set((group.criteria?.conds ?? [])
    .filter((c) => c.type === "AgeInUse" && c.value)
    .map((c) => c.value.split("_").pop().toLowerCase()));
  return ages.size ? ages : null;
}

const GATES = new Set(["ModInUse", "ModIsEnabled", "ConfigurationValueMatches", "ConfigurationValueContains"]);

/** A group that loads only when another mod or a setup option is on. */
export const isConditional = (group) => (group.criteria?.conds ?? []).some((c) => GATES.has(c.type));

/** Absolute path of a modinfo item. */
export const itemPath = (mi, item) => path.join(path.dirname(mi.path), cleanItem(item));
