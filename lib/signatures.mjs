// Known log signatures, each taken from a real failure recorded in this repo or seen in a live log.
// Severity: "error" breaks something, "warn" is probably a mod bug, "noise" is expected and collapsed.

// Civ VI modinfo verbs with no handler in the Civ VII loader. The 1.5.0 binary constructs ten
// Modding*Action classes (tools/civ7_symbols.py --actions) and none of these is among them.
const CIV6_VERBS = new Set(["ReplaceUIScript", "AddGameplayScripts", "AddUserInterfaces"]);

const OFFICIAL_ROOTS = new Set(["core", "base-standard", "age-antiquity", "age-exploration", "age-modern"]);

export const SIGNATURES = [
  {
    id: "css-grid",
    test: /near text:\s*1fr|display\s*:\s*grid/i,
    severity: "error",
    hint: "GameFace has no CSS grid, so this stylesheet stopped parsing. Use flexbox.",
  },
  {
    id: "missing-export",
    test: /does not provide an export named/,
    severity: "error",
    hint: "Usually a stale copy of the mod is loading instead of your edits: a Workshop subscription or a nested dist/ folder with the same mod id. Check Mods.",
  },
  {
    id: "civ6-verb",
    test: /No registered handler for '([^']+) \((\w+)\)'/,
    classify: (m) => (CIV6_VERBS.has(m[2]) ? "warn" : "noise"),
    hint: (m) => (CIV6_VERBS.has(m[2])
      ? `${m[2]} is a Civ VI action. Civ VII has no handler for it, so action group '${m[1]}' does nothing.`
      : `${m[2]} is valid but not handled in this scope. Official content logs this too.`),
  },
  {
    id: "file-load-issues",
    test: /There were issues loading '([^']+)'/,
    severity: "warn",
    hint: (m) => (/text|\.xml$/i.test(m[1])
      ? `The loader hit an error in ${m[1]} and continued. In text files one bad row, such as a duplicate LOC tag, can drop the whole file.`
      : `The loader hit an error in ${m[1]} and continued.`),
  },
  {
    id: "sqlite-constraint",
    test: /(UNIQUE|FOREIGN KEY|NOT NULL|CHECK) constraint failed|no such (table|column)/i,
    severity: "error",
    hint: "A database action was rejected. Rows from the same file may not have been applied.",
  },
  {
    id: "missing-asset",
    test: /Failed loading resource: (\S+)/,
    severity: "warn",
    hint: (m) => `Asset ${m[1]} does not exist. The base game logs some of these itself; if your mod names it, check the name and its blp: or fs:// prefix.`,
  },
  {
    id: "js-error",
    test: /\b(Uncaught|TypeError|ReferenceError|SyntaxError|RangeError)\b|is not a function|is not defined|Cannot read propert/,
    severity: "error",
    hint: "A script threw. The first line with a file path names the script.",
  },
  {
    id: "html-parse",
    test: /HTML Parser Error/,
    severity: "warn",
    hint: "An HTML fragment did not parse cleanly. The URL is the page it was inserted into, not necessarily the file at fault.",
  },
  {
    id: "generic-error",
    test: /\b(ERROR|Error)\b\s*:/,
    severity: "warn",
    hint: null,
  },
];

// Pulls the mod a line is about from the fs://game/<root>/ URL the engine logs for UI files.
export function modOf(line) {
  const m = line.match(/fs:\/\/game\/([^/\s]+)\//);
  if (!m || OFFICIAL_ROOTS.has(m[1])) return null;
  return m[1];
}

export function classify(line) {
  for (const sig of SIGNATURES) {
    const m = line.match(sig.test);
    if (!m) continue;
    const severity = sig.classify ? sig.classify(m) : sig.severity;
    const hint = typeof sig.hint === "function" ? sig.hint(m) : sig.hint;
    return { signature: sig.id, severity, hint, mod: modOf(line) };
  }
  return { signature: null, severity: "info", hint: null, mod: modOf(line) };
}
