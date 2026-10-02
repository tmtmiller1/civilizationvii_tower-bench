// Verdicts for the atlas: findings in a Markdown list where each entry is a top-level bullet that leads with a
// bold claim, names the API in code spans (`Api.member`) and states "Evidence: watched|inferred|reported"
// with a date. Members named in the bold claim are the entry's subject; if the claim names none, every API
// code span in the entry is a mention, because a body that names one API often names the tool used to set up the
// experiment, not what the finding is about.
import fs from "node:fs";

const API = /^(engine|[A-Z][\w$]*)((?:\.[A-Za-z_$][\w$]*)+)/;
const LEVEL = /Evidence:\s*\**\s*`?(watched|inferred|reported)`?([\s\S]{0,160})/i;
// A span ending in a file extension names a file (`Mods.sqlite`), and a JavaScript built-in is not engine API.
const FILE_EXT = /^(cpp|h|txt|sqlite|log|ts|js|mjs|xml|md|json|css|html|png|blp|modinfo|sql|dll|dylib|ini|exe|csv)$/i;
const DATE = /\b(\d{4}-\d{2}-\d{2})\b/;

/**
 * `Configuration.getUser().setValue` -> `Configuration.getUser`: the chain up to the first call, at most three
 * names, or null when the span is not an API reference.
 * @param {string} span
 */
export function apiPath(span) {
  const s = span.trim().replace(/\s+/g, "");
  const m = API.exec(s);
  if (!m) return null;
  const parts = [m[1], ...m[2].slice(1).split(".")];
  if (FILE_EXT.test(/** @type {string} */ (parts.at(-1))) || (m[1] !== "engine" && m[1] in globalThis)) return null;
  return parts.slice(0, 3).join(".");
}

const codeSpans = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
const apiSpans = (text) => [...new Set(codeSpans(text).map(apiPath).filter((p) => p !== null))];
const plain = (s) => s.replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim();

/**
 * @typedef {{ id: number, line: number, section: string, claim: string, level: string | null, date: string | null,
 *   members: string[], role: "subject" | "mention" }} Verdict
 */

/** Top-level bullet entries with their heading and first line number. @param {string} text */
export function entries(text) {
  /** @type {{ line: number, section: string, text: string }[]} */
  const out = [];
  let section = "";
  let cur = null;
  text.split(/\r?\n/).forEach((l, i) => {
    if (/^#{1,6}\s/.test(l)) { section = l.replace(/^#+\s*/, "").trim(); cur = null; }
    else if (/^[-*]\s/.test(l)) { cur = { line: i + 1, section, text: l.slice(2) }; out.push(cur); }
    else if (cur && (/^\s+\S/.test(l) || (l.trim() && !/^(---|\|)/.test(l)))) cur.text += `\n${l.trim()}`;
    else if (!l.trim()) cur = null;
  });
  return out;
}

/** The evidence level and date an entry states, both null when it states none. */
function evidenceOf(text) {
  const ev = LEVEL.exec(text);
  if (!ev) return { level: null, date: null };
  return { level: ev[1].toLowerCase(), date: DATE.exec(ev[2])?.[1] ?? null };
}

/** The bold claim an entry leads with, or null. */
const boldOf = (text) => /^\s*\*\*([\s\S]+?)\*\*/.exec(text)?.[1] ?? null;

/** @param {{ line: number, section: string, text: string }} e @param {number} id @returns {Verdict | null} */
function verdictOf(e, id) {
  const bold = boldOf(e.text);
  const evidence = evidenceOf(e.text);
  const subject = bold ? apiSpans(bold) : [];
  const members = subject.length ? subject : apiSpans(e.text);
  if (!members.length || (!evidence.level && !bold)) return null;
  return {
    id, line: e.line, section: e.section, claim: plain(bold ?? e.text.split("\n")[0]).slice(0, 300), ...evidence,
    // An entry that names a single API member is about that member even when its claim does not name it.
    members, role: subject.length ? "subject" : "mention",
  };
}

/**
 * Every verdict in a Markdown text that names at least one API member.
 * @param {string} text
 * @returns {Verdict[]}
 */
export function parseVerdicts(text) {
  /** @type {Verdict[]} */
  const out = [];
  for (const e of entries(text)) {
    const v = verdictOf(e, out.length + 1);
    if (v) out.push(v);
  }
  return out;
}

/** @param {string} file */
export function readVerdicts(file) {
  if (!file || !fs.existsSync(file)) throw new Error(`no verdicts file at ${file}`);
  const text = fs.readFileSync(file, "utf8");
  return { entries: entries(text).length, verdicts: parseVerdicts(text) };
}
