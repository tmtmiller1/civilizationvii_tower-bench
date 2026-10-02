// The atlas as a Markdown reference: an index, one page per root and an events page. Everything in it comes
// from the atlas (game-relative file names, no local paths), so the folder can be published as it is.
import fs from "node:fs";
import path from "node:path";

/** @typedef {import("./atlas.mjs").Atlas} Atlas @typedef {import("./atlas.mjs").Member} Member */

const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const code = (v) => `\`${String(v).replace(/`/g, "'")}\``;
const table = (cols, rows) => [`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`,
  ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");

const LEGEND = [
  "- LIVE: present on a running page when the atlas was built (the scope column says which page: shell is the",
  "  main menu, game is a loaded game).",
  "- USED: the game's own scripts use it; the count is how many times, with example call sites.",
  "- DOCUMENTED: declared in the type declarations the atlas was built with.",
  "- WATCHED: a finding about it was observed in a running game. Findings that only mention it, and other",
  "  evidence levels (inferred, reported), are listed on its page but not badged.",
].join("\n");

function sourcesLine(atlas) {
  const s = atlas.sources;
  const parts = [];
  if (s.usage) parts.push(`${s.usage.files} game script files read`);
  const scopes = Object.keys(s.live ?? {});
  parts.push(scopes.length ? `live crawl of the ${scopes.join(" and ")} page` : "no live crawl (no LIVE badges)");
  if (s.sdk) parts.push(`${s.sdk.files} declaration file(s)`);
  if (s.verdicts) parts.push(`${s.verdicts.verdicts} finding(s), ${s.verdicts.attached} attached to a member`);
  return parts.join("; ");
}

/** @param {Atlas} atlas */
export function indexPage(atlas) {
  const rows = Object.entries(atlas.roots)
    .sort((a, b) => b[1].used - a[1].used || a[0].localeCompare(b[0]))
    .map(([name, r]) => [`[${name}](${name}.md)`, r.members, r.used, Object.keys(r.live).join(", ") || "-",
      r.documented ? "yes" : "-", r.watched ? "yes" : "-"]);
  return [
    `# Civilization VII engine API atlas: game ${atlas.gameVersion}`,
    "",
    "Generated from the engine and the game's own files, not written by hand. Built from: " + `${sourcesLine(atlas)}.`,
    "",
    LEGEND,
    "",
    `Gameplay and UI events the game's scripts listen for or fire: [events](events.md).`,
    "",
    table(["Root", "Members", "Uses", "Live", "Documented", "Watched"], rows),
    "",
  ].join("\n");
}

function usageLine(u) {
  if (!u) return null;
  const args = Object.entries(u.args).map(([n, c]) => `${n} arg${n === "1" ? "" : "s"} x${c}`).join(", ");
  return `Used ${u.count} time(s) in ${u.files} file(s)${args ? `; called with ${args}` : ""}.`;
}

function liveLine(m) {
  return Object.entries(m.live).map(([scope, r]) => {
    const extra = r.kind === "function" ? `, arity ${r.arity}` : r.value !== undefined ? ` = ${r.value}` : "";
    return `${scope}: ${r.kind}${extra}${r.via === "probe" ? " (found by name)" : ""}`;
  }).join("; ");
}

/** @param {Member} m @param {Map<number, any>} verdicts */
function memberSection(m, verdicts) {
  const out = [`### ${code(m.path)}`, ""];
  if (m.badges.length) out.push(`${m.badges.join(" · ")}`, "");
  if (m.sdk) out.push(`Declared: ${code(m.sdk.signature)}`, "");
  if (Object.keys(m.live).length) out.push(`Live: ${liveLine(m)}.`, "");
  const u = usageLine(m.usage);
  if (u) out.push(u, "", ...(m.usage?.examples ?? []).map((e) => `- ${code(e)}`), "");
  for (const v of m.verdicts.map((id) => verdicts.get(id)).filter(Boolean)) {
    out.push(`> ${v.claim} (evidence: ${v.level ?? "not stated"}${v.date ? ` ${v.date}` : ""})`, "");
  }
  return out.join("\n");
}

/** @param {Atlas} atlas @param {string} root */
export function rootPage(atlas, root) {
  const r = atlas.roots[root];
  const members = Object.values(atlas.members).filter((m) => m.root === root)
    .sort((a, b) => a.path.localeCompare(b.path));
  const verdicts = new Map(atlas.verdicts.map((v) => [v.id, v]));
  const rows = members.map((m) => [code(m.path), m.kind, m.arity ?? "-", m.badges.join(" ") || "-", m.usage?.count ?? 0,
    Object.keys(m.live).filter((s) => m.live[s].kind !== "absent").join(", ") || "-"]);
  return [
    `# ${root}`,
    "",
    `[Index](index.md) · game ${atlas.gameVersion} · ${r.members} member(s), used ${r.used} time(s) by the game's scripts`
      + `${Object.keys(r.live).length ? `; live on ${Object.keys(r.live).join(", ")}` : ""}.`,
    "",
    table(["Member", "Kind", "Arity", "Badges", "Uses", "Live in"], rows),
    "",
    ...members.map((m) => memberSection(m, verdicts)),
  ].join("\n");
}

/** @param {Atlas} atlas */
export function eventsPage(atlas) {
  const rows = Object.entries(atlas.events).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, e]) => [code(name), e.on, e.trigger, e.other, e.examples.map(code).join("<br>")]);
  return [
    "# Events",
    "",
    `[Index](index.md) · game ${atlas.gameVersion}. Names passed as text to engine.on / once (listen), engine.trigger`
      + " (fire) and engine.off / call (other) in the game's scripts. \"(computed)\" counts names built at run time.",
    "",
    table(["Event", "Listen", "Fire", "Other", "Examples"], rows),
    "",
  ].join("\n");
}

/**
 * Writes index.md, events.md and <Root>.md into dir.
 * @param {Atlas} atlas @param {string} dir
 */
export function exportMarkdown(atlas, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, text) => { fs.writeFileSync(path.join(dir, name), text); return name; };
  const files = [write("index.md", indexPage(atlas)), write("events.md", eventsPage(atlas))];
  for (const root of Object.keys(atlas.roots)) {
    if (/^[\w$]+$/.test(root)) files.push(write(`${root}.md`, rootPage(atlas, root)));
  }
  return { dir, files: files.length };
}
