import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "techniques", "techniques.json");

/**
 * @typedef {{ id: string, title: string, category: string, purpose: string, why: string, when?: string,
 *   whenNot?: string, snippet?: string, snippetLang?: string, pitfalls?: string[], status: string,
 *   statusNote?: string, evidence?: { mods: number | null, note: string }, objects?: string[],
 *   related?: string[], kind: string }} Technique
 * @typedef {{ version: number, categories: { id: string, title: string, blurb?: string }[],
 *   entries: Technique[] }} Library
 */

// Every finding the bench produces names a rule; this is where a rule offers the entries that show how to
// do the thing properly. Keys are "<source>:<rule id>". A test holds both sides to the library.
export const RULE_TECHNIQUES = {
  "log:css-grid": ["gameface-flexbox-layout"],
  "log:missing-export": ["mod-copies-and-shadowing", "import-current-paths"],
  "log:civ6-verb": ["match-current-schema"],
  "log:file-load-issues": ["loc-tags-unique"],
  "log:db-rollback-file": ["match-current-schema", "data-reinsert-safely"],
  "log:db-rollback-action": ["match-current-schema", "data-reinsert-safely"],
  "log:db-rollback": ["match-current-schema", "data-update-replace", "data-reinsert-safely"],
  "log:config-rollback": ["match-current-schema", "loc-tags-unique"],
  "log:invalid-reference": ["match-current-schema"],
  "log:chunk-import": ["import-current-paths", "version-resilient-binding"],
  "log:source-error": ["import-current-paths", "version-resilient-binding", "optional-dynamic-import"],
  "log:sqlite-constraint": ["data-reinsert-safely", "data-update-replace", "loc-tags-unique"],
  "log:js-error": ["crash-breadcrumbs"],
  "lint:italic": ["gameface-text-rules"],
  "lint:border-color": ["gameface-border-longhands"],
  "lint:subpixel-border": ["gameface-border-longhands"],
  "lint:unresolved-text": ["loc-tags-unique"],
  "mods:two-copies-enabled": ["mod-copies-and-shadowing"],
  "mods:workshop-live": ["mod-copies-and-shadowing"],
  "mods:nested-copy": ["mod-copies-and-shadowing"],
  "deploy:workshop-copy": ["mod-copies-and-shadowing"],
  "deploy:reload": ["reload-ui-after-deploy", "gameface-xhr-not-fetch"],
  "conflict:same-id": ["mod-copies-and-shadowing", "namespace-everything"],
  "conflict:vanilla-file-override": ["decorate-dont-replace", "componentregistry-override"],
  "conflict:define-collision": ["decorate-dont-replace", "namespace-everything"],
  "conflict:define-over-decorated": ["decorate-dont-replace"],
  "conflict:registry-collision": ["componentregistry-override"],
  "conflict:proto-patch": ["closure-wrap-patching", "idempotent-patch-guard"],
  "conflict:localstorage-key": ["shared-modsettings", "versioned-options", "namespace-everything"],
  "conflict:shared-global": ["cooperative-global-registry", "namespace-everything"],
  "conflict:db-key-collision": ["data-update-replace", "data-reinsert-safely"],
  "conflict:loc-tag-collision": ["loc-tags-unique", "namespace-everything"],
  "check:missing-required-column": ["match-current-schema"],
  "check:unknown-table": ["match-current-schema"],
  "check:unknown-column": ["match-current-schema"],
  "check:duplicate-base-row": ["data-reinsert-safely", "data-update-replace"],
  "check:removed-effect-type": ["match-current-schema"],
  "check:invalid-reference": ["match-current-schema"],
  "check:missing-listed-file": ["match-current-schema"],
  "check:unresolved-import": ["import-current-paths", "version-resilient-binding", "optional-dynamic-import"],
  "check:duplicate-loc-tag": ["loc-tags-unique", "namespace-everything"],
  "conflict:decorate-chain": ["decorate-dont-replace"],
  "conflict:db-update-collision": ["data-update-replace", "data-first-gameplay"],
  "conflict:db-delete-vs-update": ["data-reinsert-safely", "data-update-replace"],
  "check:modinfo-malformed": ["modinfo-action-verbs", "packaging-accidents"],
  "check:item-outside-mod": ["packaging-accidents"],
  "check:unresolved-dynamic-import": ["optional-dynamic-import", "import-current-paths"],
  "check:missing-optional-import": ["optional-dynamic-import", "cross-mod-detection"],
  "check:cross-mod-import": ["cross-mod-detection", "optional-dynamic-import"],
  "check:unknown-decorate-target": ["decorate-dont-replace", "componentregistry-override"],
  "check:malformed-data-xml": ["match-current-schema", "data-update-replace"],
  "check:undeclared-table-dependency": ["cross-mod-detection", "match-current-schema"],
  "watch:canvas-pool": ["canvas-batched-paints", "retained-dom-markers"],
  "doctor:registry": ["mod-copies-and-shadowing"],
  "doctor:live": ["reload-ui-after-deploy"],
  "crash:triage": ["crash-breadcrumbs"],
  "patch:removed-file": ["import-current-paths", "version-resilient-binding", "chunk-bundle-imports"],
  "patch:removed-file-dynamic": ["optional-dynamic-import", "import-current-paths"],
  "patch:removed-export": ["version-resilient-binding", "import-current-paths"],
  "patch:removed-component": ["componentregistry-override", "decorate-dont-replace"],
  "patch:removed-table": ["match-current-schema"],
  "patch:removed-column": ["match-current-schema"],
  "patch:newly-required-column": ["match-current-schema"],
  "patch:removed-effect-type": ["match-current-schema"],
  "patch:stale-override": ["same-path-shadowing", "decorate-dont-replace", "line-number-coupling"],
  "patch:override-removed": ["same-path-shadowing", "import-current-paths"],
  "release:declared-files": ["packaging-accidents", "modinfo-action-verbs"],
  "release:undeclared-runtime": ["gameface-xhr-not-fetch"],
  "release:dev-junk": ["packaging-accidents"],
  "release:outside-files": ["packaging-accidents"],
  "release:zip-layout": ["packaging-accidents"],
  "release:zip-matches-folder": ["packaging-accidents"],
  "release:probe-files": ["packaging-accidents"],
  "release:nested-copy": ["mod-copies-and-shadowing", "packaging-accidents"],
  "release:preflight": ["match-current-schema", "import-current-paths"],
  "release:name": ["loc-tags-unique"],
  "release:description": ["loc-tags-unique"],
  "l10n:undefined-tag": ["loc-tags-unique"],
  "l10n:undefined-script-tag": ["loc-tags-unique"],
  "l10n:tag-case": ["loc-tags-unique"],
  "l10n:duplicate-loc-tag": ["loc-tags-unique", "namespace-everything"],
  "l10n:text-in-database-action": ["loc-tags-unique", "modinfo-action-verbs"],
  "l10n:language-unknown": ["loc-tags-unique"],
  "l10n:locale-unknown": ["loc-tags-unique"],
  "l10n:locale-mismatch": ["loc-tags-unique"],
  "l10n:path-language-mismatch": ["loc-tags-unique"],
  "l10n:cjk-font": ["gameface-text-rules", "gameface-css-subset"],
  "l10n:font-family-var": ["gameface-text-rules", "gameface-css-subset"],
  "lint:cjk-no-face": ["gameface-text-rules", "gameface-css-subset"],
  "lint:replacement-glyph": ["gameface-text-rules", "gameface-css-subset"],
};

let cached = null;

/** @returns {Library} */
export function loadTechniques(file = DEFAULT_FILE) {
  if (cached?.file === file) return cached.lib;
  /** @type {Library} */
  let lib = { version: 0, categories: [], entries: [] };
  try {
    lib = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // A missing library leaves findings without links; nothing else depends on it.
  }
  cached = { file, lib };
  return lib;
}

const brief = (t) => ({ id: t.id, title: t.title, purpose: t.purpose, status: t.status, kind: t.kind });

/** The entries a finding's rule offers, briefly. `key` is "<source>:<rule id>". */
export function techniquesFor(key, lib = loadTechniques()) {
  const ids = RULE_TECHNIQUES[key] ?? [];
  return ids.map((id) => lib.entries.find((t) => t.id === id)).filter(Boolean).map(brief);
}

export function techniqueById(id, lib = loadTechniques()) {
  return lib.entries.find((t) => t.id === id) ?? null;
}

const words = (s) => String(s ?? "").toLowerCase().split(/[^a-z0-9_.]+/).filter((w) => w.length > 1);

/** Ranks entries against a free-text query: titles and ids weigh most, then objects, then prose. */
export function searchTechniques(query, lib = loadTechniques()) {
  const q = words(query);
  if (!q.length) return lib.entries.map(brief);
  const scored = lib.entries.map((t) => {
    /** @type {[string[], number][]} */
    const fields = [
      [words(`${t.title} ${t.id.replace(/-/g, " ")}`), 5],
      [words((t.objects ?? []).join(" ")), 4],
      [words(`${t.category} ${t.purpose}`), 2],
      [words(`${t.why} ${t.when ?? ""} ${(t.pitfalls ?? []).join(" ")}`), 1],
    ];
    let score = 0;
    for (const w of q) {
      for (const [ws, weight] of fields) if (ws.some((x) => x === w || x.startsWith(w))) score += weight;
    }
    return { t, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).map((s) => brief(s.t));
}

/** Entries that use an engine object the code names, for the console: `LensManager.x` offers lens entries. */
export function techniquesForCode(code, lib = loadTechniques(), max = 4) {
  const idents = new Set(String(code ?? "").match(/[A-Za-z_$][\w$]*/g) ?? []);
  return lib.entries.filter((t) => (t.objects ?? []).some((o) => idents.has(o))).slice(0, max).map(brief);
}

/** Ids only, for findings that travel in bulk (log lines, lint issues); the UI resolves titles once. */
export function techniqueIds(key, lib = loadTechniques()) {
  return (RULE_TECHNIQUES[key] ?? []).filter((id) => lib.entries.some((t) => t.id === id));
}

// "Watched by the bench": a recipe that lists the techniques it exercises and passes in a lab game marks
// them watched, with the date and game version. A record per run, so a later failure is visible too.
const watchFile = (paths) => path.join(path.dirname(paths.evidence), "techniques-watched.json");

/** @returns {Record<string, { date: string, version: string | null, recipe: string | null, passed: boolean }[]>} */
export function readWatched(paths) {
  try { return JSON.parse(fs.readFileSync(watchFile(paths), "utf8")); } catch { return {}; }
}

/** @param {any} paths @param {{ ids: string[], recipe: string | null, passed: boolean, version: string | null }} run */
export function recordTechniqueRun(paths, { ids, recipe, passed, version }) {
  const all = readWatched(paths);
  const date = new Date().toISOString();
  for (const id of ids) all[id] = [...(all[id] ?? []), { date, version, recipe, passed }].slice(-20);
  fs.mkdirSync(path.dirname(watchFile(paths)), { recursive: true });
  fs.writeFileSync(watchFile(paths), JSON.stringify(all, null, 2));
}

/** The library with each entry's latest lab result attached: `watched` is the last pass, `lastRun` the last run. */
export function libraryWithRuns(paths, lib = loadTechniques()) {
  const runs = readWatched(paths);
  return { ...lib, entries: lib.entries.map((t) => {
    const list = runs[t.id] ?? [];
    const watched = list.filter((r) => r.passed).at(-1) ?? null;
    return list.length ? { ...t, watched, lastRun: list.at(-1) } : t;
  }) };
}
