// Known log signatures, each taken from a real failure seen in a live log.
// Severity: "error" breaks something, "warn" is probably a mod bug, "noise" is expected and collapsed.

// Civ VI modinfo verbs with no handler in the Civ VII loader. The 1.5.0 binary constructs ten
// Modding*Action classes (read from its symbol table) and none of these is among them.
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
  // A failed database action is logged as a chain: the file that needs a rollback, the action group,
  // "Failed to apply enabled components", then the rollback itself. The first two name the cause, the
  // third carries the outcome, and the rest are consequences, so the chain reads as one incident.
  {
    id: "db-rollback-file",
    test: /There were errors loading '([^']+)' that require a rollback/,
    severity: "error",
    hint: (m) => `${m[1]} failed to load and its changes are rolled back. The constraint or reference error just before this line says which row; the lines after say what it cost.`,
  },
  {
    id: "db-rollback-action",
    test: /Errors when applying action '([^']+) \((\w+)\)'\. Rollback Required/,
    severity: "error",
    hint: (m) => `Action group '${m[1]}' (${m[2]}) failed. The file named on the line before is the one at fault.`,
  },
  {
    id: "db-rollback",
    test: /Failed to apply enabled components/,
    severity: "error",
    hint: "The game will not start or load a game that needs this content: it returns to the main menu with a content configuration validation error. The cause is logged just before this line.",
  },
  {
    id: "config-rollback",
    test: /There was an error applying config actions/,
    severity: "error",
    hint: "A main-menu (shell) file failed, so the main-menu configuration failed: no enabled mod's main-menu content or scripts load. The cause is logged just before this line.",
  },
  {
    id: "db-rollback-consequence",
    test: /Rolling back database to a good state|Performing a complete rollback to vanilla|\]: Failed Validation\./,
    severity: "noise",
    hint: "A consequence of the database failure logged just before it.",
  },
  {
    id: "invalid-reference",
    test: /Invalid Reference on (\w+)\.(\w+) - "([^"]+)" does not exist in (\w+)/,
    severity: "error",
    hint: (m) => `${m[3]} is not defined in ${m[4]}, so ${m[1]}.${m[2]} points at nothing. This game version removed or renamed it, or it is misspelt. Validation fails and the game will not start.`,
  },
  {
    id: "chunk-import",
    test: /Failed (?:loading resource|to open file)[^\n]*?([\w./-]+\.chunk\.js)/,
    severity: "error",
    hint: (m) => `${m[1]} is a bundle file this game version does not ship, so the module importing it fails to load. Import the unbundled module instead: usually the same path without ".chunk"; if that file does not exist the module moved. Bundles exported single letters ("L as X"); the unbundled module exports real names.`,
  },
  {
    id: "source-error",
    test: /SOURCE ERROR - (\S+)/,
    severity: "error",
    hint: (m) => `${m[1]} failed to load, so nothing in it runs. The usual cause is an import of a file this game version does not ship or has moved; a missing-file line just before this one names it.`,
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
  // Other languages run through in-page interpreters (Python via Brython, Lua via Fengari) report
  // their own errors through the console, in their own formats.
  {
    id: "python-error",
    test: /Traceback \(most recent call last\)|^\s*(?:\[[^\]]*\]\s*)?File "[^"]+", line \d+|\b(NameError|AttributeError|ImportError|ModuleNotFoundError|IndentationError|KeyError|IndexError|ValueError|ZeroDivisionError): /,
    severity: "error",
    hint: "A Python script raised an exception. The traceback lines that follow name the file and line; the last one names the error.",
  },
  {
    id: "lua-error",
    test: /\[string "[^"]*"\]:\d+:|attempt to (?:call|index|perform arithmetic on|compare|concatenate) a \w+ value/,
    severity: "error",
    hint: "A Lua script raised an error. The [string \"...\"]:N prefix is the chunk and line.",
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

// Pulls the mod a line is about from the fs://game/<root>/ URL the engine logs for UI files, or from
// the /<root>/ path a SOURCE ERROR names.
export function modOf(line) {
  const m = line.match(/fs:\/\/game\/([^/\s]+)\//) ?? line.match(/SOURCE ERROR - \/([^/\s]+)\//);
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
