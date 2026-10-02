// A mod's database statements against what an update changed in the schema: tables and columns it writes
// that are gone, columns that became required, and modifier effect types that were removed. Types rows are
// not checked: the Debug copy holds the loaded game's age and enabled mods, so they differ between any two
// snapshots for reasons that are not the update.
import { code, listMore } from "./static/util.mjs";
import { patchFinding } from "./patch-impact.mjs";

/**
 * @typedef {import("./static/mod.mjs").Mod} Mod
 * @typedef {import("./static/mod.mjs").ModDbOp} ModDbOp
 * @typedef {import("./patch-impact.mjs").Findings} Findings
 */

const TEXT_TABLES = new Set(["localizedtext", "englishtext"]);
const isFullInsert = (op) => (op.op === "row" || op.op === "replace") && !op.select && !op.partial && !op.positional;
const usedColumns = (op) => [op.values, op.set, op.where].flatMap((o) => Object.keys(o ?? {}));

/** Type names this mod inserts itself (an effect type it defines is its own). */
function ownTypes(mod) {
  const own = new Set();
  for (const { op } of mod.dbOps) {
    if (op.op === "create" || !op.values) continue;
    if (op.table.toLowerCase() === "types" && op.values.type) own.add(String(op.values.type));
    if (op.table.toLowerCase() === "modifiers" && op.partial) own.add(String(op.values.modifierid));
  }
  return own;
}

class DbImpact {
  /** @param {Mod} mod @param {any} ctx @param {Findings} out */
  constructor(mod, ctx, out) {
    this.mod = mod;
    this.ctx = ctx;
    this.out = out;
    this.own = ownTypes(mod);
    this.effects = new Set(ctx.diff.effectTypes.removed);
  }

  run() {
    for (const e of this.mod.dbOps) if (e.op.op !== "create") this.visit(e);
  }

  /** @param {ModDbOp} e */
  visit(e) {
    const t = e.op.table.toLowerCase();
    const before = this.ctx.a.schema?.[e.db]?.[t];
    const after = this.ctx.b.schema?.[e.db]?.[t];
    if (before && !after && !this.mod.createdTables.has(t)) this.removedTable(e, before.name);
    if (before && after) this.columns(e, before, after);
    this.effectRefs(e);
  }

  /** @param {ModDbOp} e */
  removedTable(e, name) {
    const { a, b } = this.ctx;
    this.out.add(`removed-table\u0001${e.db}\u0001${name}`, e.file, () => patchFinding("High", "removed-table", {
      text: `writes table ${code(name)}, which ${b.version} removed from the ${e.db} database; those statements fail and the game rolls the database back.`,
      was: `${a.version}: ${e.db}.${name}`, now: `${b.version}: no such table`,
      fix: `remove the ${code(name)} statements, or port them to the table that replaced it (see game diff: tables added)`,
    }));
  }

  /** @param {ModDbOp} e */
  columns(e, before, after) {
    const { a, b } = this.ctx;
    const gone = [...new Set(usedColumns(e.op))].filter((c) => before.cols.includes(c) && !after.cols.includes(c))
      .sort();
    if (gone.length) {
      this.out.add(`removed-column\u0001${e.db}\u0001${after.name}\u0001${gone}`, e.file, () => patchFinding("High", "removed-column", {
        text: `uses column(s) ${gone.map(code).join(", ")} on ${code(after.name)}, which ${b.version} removed; those statements fail.`,
        was: `${a.version}: ${after.name}(${gone.join(", ")})`, now: `${b.version}: ${after.name} has no ${gone.join(", ")}`,
        fix: `drop or rename those columns; ${after.name} now has ${listMore(after.cols.filter((c) => !before.cols.includes(c)), 5, code) || "no new columns"}`,
      }));
    }
    if (!isFullInsert(e.op) || TEXT_TABLES.has(after.name.toLowerCase())) return;
    const miss = after.required.filter((c) => !before.required.includes(c) && !(c in (e.op.values ?? {})));
    if (!miss.length) return;
    this.out.add(`newly-required-column\u0001${e.db}\u0001${after.name}\u0001${miss}`, e.file, () => patchFinding("High", "newly-required-column", {
      text: `inserts into ${code(after.name)} without ${miss.map(code).join(", ")}, which ${b.version} made required (NOT NULL, no default); the insert fails and the game rolls the database back.`,
      was: `${a.version}: ${after.name}.${miss.join(", ")} ${miss.every((c) => before.cols.includes(c)) ? "optional" : "did not exist"}`,
      now: `${b.version}: ${after.name}.${miss.join(", ")} NOT NULL without a default`,
      fix: `add ${miss.map(code).join(", ")} to every ${code(after.name)} row`,
    }));
  }

  /** @param {ModDbOp} e */
  effectRefs(e) {
    const { op } = e;
    const dyn = op.table.toLowerCase() === "dynamicmodifiers"
      ? [op.values?.effecttype, op.values?.collectiontype] : [];
    const used = [op.effect, op.collection, ...dyn]
      .filter((v) => v && this.effects.has(String(v)) && !this.own.has(String(v)));
    const gated = op.conditional ? " (its action group is gated by criteria, so only when those hold)" : "";
    for (const v of used) {
      const { a, b } = this.ctx;
      this.out.add(`removed-effect-type\u0001${v}`, e.file, () => patchFinding("High", "removed-effect-type", {
        text: `uses modifier effect ${code(v)}, which ${b.version} removed; the reference check on DynamicModifiers rejects the database and a game cannot start${gated}.`,
        was: `${a.version}: ${v}`, now: `${b.version}: no such effect type`,
        fix: "rewrite or remove the modifiers that use it",
      }));
    }
  }
}

/** @param {Mod} mod @param {any} ctx @param {Findings} out */
export function dbFindings(mod, ctx, out) {
  if (!ctx.diff.schema.available) return;
  new DbImpact(mod, ctx, out).run();
}
