// Turns static conflict findings into observed verdicts. Each pair runs in a lab game with only the two
// mods (and the base game) enabled; the running game's registry or the load logs then say whether the
// conflict happened. Verdicts are logged as evidence and kept in a store, so the static report can say
// "confirmed on <date>" next to a finding.
import fs from "node:fs";
import path from "node:path";
import { localDate } from "./evidence.mjs";
import { copiesOf, keepLog, labDeps, refuseIfBusy, setModCopies, withLabGame } from "./labtools.mjs";
import { classify } from "./signatures.mjs";

/**
 * @typedef {"CONFIRMED" | "REFUTED" | "INCONCLUSIVE" | "NOT PROVABLE"} Verdict
 * @typedef {{ a: string, b: string, aRoot?: string, bRoot?: string, severity: string, rule: string,
 *   text: string }} Finding
 * @typedef {{ date: string, ts: string, a: string, b: string, rule: string, severity: string, text: string,
 *   verdict: Verdict, detail: string, run?: string | null, command?: string }} Proof
 */

const REGISTRY_RULES = new Set(["define-collision", "registry-collision", "define-over-decorated"]);
const LOG_RULES = new Set(["db-key-collision", "db-update-collision", "db-delete-vs-update", "loc-tag-collision"]);
const ROLLBACK = new Set(["db-rollback-file", "db-rollback-action", "db-rollback", "config-rollback"]);
const DB_ERRORS = new Set([...ROLLBACK, "invalid-reference", "sqlite-constraint"]);
const LEVELS = { high: ["High"], medium: ["High", "Medium"], low: ["High", "Medium", "Low"] };

export const proofKind = (rule) => (REGISTRY_RULES.has(rule) ? "registry" : LOG_RULES.has(rule) ? "logs"
  : rule === "same-id" ? "registered-copies" : "recipe");

const namesIn = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const verdict = (v, detail) => ({ verdict: /** @type {Verdict} */ (v), detail });

// Which of the pair a legacy definition's files come from: fs://game/<folder>/ names the mod's folder or id.
function ownersOf(ctl, c) {
  const marks = (id, root) => new Set([id, root && path.basename(root)].filter(Boolean));
  return [[c.a, marks(c.a, c.aRoot)], [c.b, marks(c.b, c.bRoot)]]
    .filter(([, m]) => ctl.mods.some((x) => m.has(x))).map(([id]) => id);
}

function defineVerdict(c, name, ctl) {
  if (!ctl) return verdict("INCONCLUSIVE", `no mod-supplied definition of ${name} is visible in the running game`);
  const owners = ownersOf(ctl, c);
  if (owners.length === 1) {
    const loser = owners[0] === c.a ? c.b : c.a;
    return verdict("CONFIRMED", `${name}: the definition from ${owners[0]} is live; ${loser}'s was replaced`);
  }
  const files = ctl.mods.join(", ") || "no mod files";
  return verdict("INCONCLUSIVE", `${name} is live as class ${ctl.className ?? "?"} with files from ${files}; `
    + "its owner in this pair cannot be told");
}

function decoratedVerdict(c, name, ctl) {
  const owners = ctl ? ownersOf(ctl, c) : [];
  if (!owners.length) return verdict("REFUTED", `the vanilla ${name} is live; neither mod's redefinition took`);
  return verdict("CONFIRMED", `${owners.join(" and ")} replaced ${name} in game, so the other mod's decorator `
    + "attaches to the replacement");
}

function componentVerdict(name, comp) {
  if (!comp) {
    return verdict("INCONCLUSIVE", `no ui-next component ${name} above base priority: a priority-0 registration `
      + "cannot be told from the base game's");
  }
  return verdict("CONFIRMED", `${name} has one live registration (priority ${comp.priority}, factory `
    + `${comp.factory ?? "?"}); the other is not recorded`);
}

/** A verdict from the running game's registry (bench.registry()) for a component collision. */
export function registryVerdict(c, reg) {
  const missing = [c.a, c.b].filter((id) => reg.active?.onlyNext?.includes(id));
  if (missing.length) return verdict("INCONCLUSIVE", `${missing.join(", ")} did not load in the test game`);
  const name = namesIn(c.text)[0];
  if (!name) return verdict("INCONCLUSIVE", "the finding names no component");
  if (c.rule === "registry-collision") return componentVerdict(name, reg.components?.find((x) => x.name === name));
  const ctl = reg.controls?.find((x) => x.name === name);
  return c.rule === "define-over-decorated" ? decoratedVerdict(c, name, ctl) : defineVerdict(c, name, ctl);
}

/** A verdict from the load logs (Modding.log and Database.log lines) for a database or text collision. */
export function logVerdict(c, lines, started) {
  const hits = lines.map((text) => ({ text, sig: classify(text).signature })).filter((h) => DB_ERRORS.has(h.sig ?? ""));
  const quote = hits.slice(0, 3).map((h) => h.text.trim()).join(" | ");
  if (hits.some((h) => ROLLBACK.has(h.sig ?? ""))) return verdict("CONFIRMED", `the database rolled back: ${quote}`);
  if (hits.length) {
    return verdict("CONFIRMED", `database errors with the pair${started ? ", but the game loaded" : ""}: ${quote}`);
  }
  if (!started) return verdict("INCONCLUSIVE", "the game did not start and no database error was logged");
  // A key collision either blocks the game or it does not. For updates and text tags the finding is about which
  // value wins, and a clean load says nothing about that.
  if (c.rule === "db-key-collision") return verdict("REFUTED", "the game loaded with both and logged no rollback");
  return verdict("INCONCLUSIVE", "the game loaded with both; which value won is a question for dbdiff");
}

const LAUNCH_LINE = /Loading Mod - (.+\.modinfo)\s*$/;

/** Same id: Mods.sqlite says which copies are registered and enabled; Modding.log which the last launch loaded. */
export function sameIdVerdict(c, rows, moddingLines) {
  const copies = rows.filter((r) => r.id === c.a);
  const enabled = copies.filter((r) => !r.disabled);
  const loaded = moddingLines.map((l) => l.match(LAUNCH_LINE)?.[1]).filter((p) => copies.some((r) => r.path === p));
  const seen = loaded.length ? `; the last launch read ${loaded.join(", ")}` : "";
  if (copies.length < 2) {
    return verdict("REFUTED", `only ${copies.length} copy of ${c.a} is registered${copies[0] ? ` (${copies[0].path})` : ""}`);
  }
  if (!enabled.length) return verdict("REFUTED", `${copies.length} copies of ${c.a} are registered, none enabled`);
  if (enabled.length > 1) {
    return verdict("CONFIRMED", `${enabled.length} copies of ${c.a} are enabled (${enabled.map((r) => r.path)
      .join(", ")}); which one loads is not defined${seen}`);
  }
  return verdict("CONFIRMED", `${copies.length} copies of ${c.a} are registered; the enabled one is ${enabled[0].path}`
    + `, the other can shadow it if switched on${seen}`);
}

export const bisectCommand = (c) => `tower-bench bisect --mods ${c.a},${c.b} --recipe <a recipe that shows the symptom>`;

const pairKey = (c) => [c.a, c.b].sort().join("\u0001");

/** @returns {Map<string, Finding[]>} */
function byPair(conflicts) {
  const m = new Map();
  for (const c of conflicts) {
    if (!m.has(pairKey(c))) m.set(pairKey(c), []);
    m.get(pairKey(c)).push(c);
  }
  return m;
}

async function judgeInGame(bench, c, game) {
  if (proofKind(c.rule) === "logs") {
    const lines = ["Modding.log", "Database.log"].flatMap((n) => keepLog(bench.paths, game.dir, n));
    return logVerdict(c, lines, game.started);
  }
  if (!game.started) return verdict("INCONCLUSIVE", game.error ?? "the game did not start");
  try {
    return registryVerdict(c, await bench.registry());
  } catch (e) {
    return verdict("INCONCLUSIVE", `could not read the registry: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function pairMods(bench, d, group) {
  const c = group[0];
  const a = copiesOf(bench.paths, d, c.a, c.aRoot);
  const b = copiesOf(bench.paths, d, c.b, c.bRoot);
  const others = d.candidateMods(bench.paths.modsDb);
  const off = [...others, ...a.all, ...b.all];
  return { off, on: [a.chosen, b.chosen].filter((x) => x !== null), missing: [a, b].some((x) => !x.chosen) };
}

async function provePair(bench, d, group, opts) {
  const { off, on, missing } = pairMods(bench, d, group);
  if (missing) return group.map(() => ({ ...verdict("INCONCLUSIVE", "one of the pair is not in the registry"), run: null }));
  const ids = on.map((x) => x.id);
  opts.log(`${ids.join(" + ")}: ${group.length} finding(s), one lab game`);
  const run = await withLabGame(bench.paths, d, { label: "prove", seed: opts.seed, age: opts.age, log: opts.log,
    setMods: () => setModCopies(bench.paths, d, off, on) }, async (game) => {
    const out = [];
    for (const c of group) out.push(await judgeInGame(bench, c, game));
    return out;
  });
  bench.cdp?.close();
  bench.log({ kind: "lab", request: { tool: "prove", mods: ids, seed: opts.seed, age: opts.age },
    result: { dir: run.dir, started: run.started, error: run.error, restored: run.restore?.restored ?? [] } });
  return run.result.map((v) => ({ ...v, run: run.dir }));
}

function offline(bench, d, c) {
  if (proofKind(c.rule) === "registered-copies") {
    const log = path.join(bench.paths.logs, "Modding.log");
    const lines = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split(/\r?\n/) : [];
    return { ...sameIdVerdict(c, d.registryRows(bench.paths.modsDb), lines), run: null };
  }
  return { ...verdict("NOT PROVABLE", "needs a recipe that shows the symptom"), run: null, command: bisectCommand(c) };
}

/** @param {Finding} c @param {any} v @returns {Proof} */
const toProof = (c, v) => ({ date: localDate(), ts: new Date().toISOString(), a: c.a, b: c.b, rule: c.rule,
  severity: c.severity, text: c.text, ...v });

export const proofsDir = (paths) => path.join(path.dirname(paths.evidence), "proofs");
const sameFinding = (p, c) => p.a === c.a && p.b === c.b && p.rule === c.rule && p.text === c.text;

/** Adds proofs to today's store file, replacing earlier proofs of the same finding from today. */
export function saveProofs(paths, proofs) {
  const file = path.join(proofsDir(paths), `${localDate()}.json`);
  let kept = [];
  try { kept = JSON.parse(fs.readFileSync(file, "utf8")); } catch { kept = []; }
  const merged = [...kept.filter((p) => !proofs.some((n) => sameFinding(p, n))), ...proofs];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));
  return file;
}

/** Every stored proof, newest first. @returns {Proof[]} */
export function loadProofs(paths) {
  const dir = proofsDir(paths);
  if (!fs.existsSync(dir)) return [];
  const all = [];
  for (const f of fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))) {
    try { all.push(...JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))); } catch { /* a damaged file is skipped */ }
  }
  return all.sort((x, y) => String(y.ts).localeCompare(String(x.ts)));
}

/** The newest proof of this finding, or null. @param {Proof[]} proofs @param {Finding} c */
export const matchProof = (proofs, c) => proofs.find((p) => sameFinding(p, c)) ?? null;

/** "confirmed on 2026-10-02", for a line next to a finding. @param {Proof | null} p */
export const proofLabel = (p) => (p ? `${p.verdict.toLowerCase()} on ${p.date}` : null);

/**
 * Proves High conflicts (and Medium with level "medium") in lab games, one game per pair. Same-id findings are
 * read from the registry and the last launch's log; findings with no automatic proof get the bisect command.
 * @param {import("./bench.mjs").Bench} bench @param {Finding[]} conflicts
 * @param {{ level?: string, seed?: number, age?: string | null, log?: (line: string) => void,
 *   deps?: Partial<import("./labtools.mjs").LabDeps> }} [options]
 */
export async function proveConflicts(bench, conflicts, options = {}) {
  const opts = { level: "high", seed: 4242, age: null, log: () => {}, ...options };
  const d = labDeps(bench.paths, opts.deps);
  const chosen = conflicts.filter((c) => (LEVELS[opts.level] ?? LEVELS.high).includes(c.severity));
  const warnings = chosen.some((c) => ["registry", "logs"].includes(proofKind(c.rule))) ? refuseIfBusy(bench.paths, d) : [];
  const results = new Map(chosen.filter((c) => !["registry", "logs"].includes(proofKind(c.rule)))
    .map((c) => [c, offline(bench, d, c)]));
  for (const group of byPair(chosen.filter((c) => !results.has(c))).values()) {
    const verdicts = await provePair(bench, d, group, opts);
    group.forEach((c, i) => results.set(c, verdicts[i]));
  }
  const proofs = chosen.map((c) => toProof(c, results.get(c)));
  for (const p of proofs) {
    bench.log({ kind: "prove-conflict", request: { a: p.a, b: p.b, rule: p.rule, text: p.text },
      result: { verdict: p.verdict, detail: p.detail, run: p.run ?? null } });
  }
  const store = proofs.length ? saveProofs(bench.paths, proofs) : null;
  return { proofs, store, warnings, skipped: conflicts.length - chosen.length };
}
