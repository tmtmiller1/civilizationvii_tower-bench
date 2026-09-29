import { BenchError } from "../bench.mjs";
import { localDate, toMarkdown } from "../evidence.mjs";
import { Lab, gamePid } from "../lab.mjs";
import { LogTail, readRecent } from "../logs.mjs";
import { filterMods, modHealth, readMods } from "../mods.mjs";
import { recipeFromEvidence, runRecipe } from "../recipes.mjs";
import { loadRecipe, out } from "./common.mjs";
import { printWrite } from "./game.mjs";

/** @typedef {import("./common.mjs").Ctx} Ctx */

const LOG_RANK = { noise: 0, info: 1, warn: 2, error: 3 };

function printMod(m) {
  out(`${m.enabled ? "on " : "off"}  ${m.id}${m.name !== m.id ? `  (${m.name})` : ""}${m.authors ? `  by ${m.authors}` : ""}`);
  for (const c of m.copies) out(`       ${c.enabled ? "live" : "    "}  ${c.source.label}  v${c.version}`);
  for (const i of m.issues) out(`       ${i.severity}: ${i.text}`);
}

/** @param {Ctx} ctx */
function logPrinter({ opt }) {
  const min = LOG_RANK[opt.level ?? "warn"] ?? 2;
  return (lines) => {
    for (const l of lines) {
      if (LOG_RANK[l.severity] < min || (opt.mod && l.mod !== opt.mod)) continue;
      out(`[${l.severity}] ${l.file}: ${l.text.trim()}`);
      if (l.hint) out(`        ${l.hint}`);
    }
  };
}

/** @param {Ctx} ctx @param {string} dir */
async function proveCommand({ bench }, dir) {
  const pr = await bench.prove(dir);
  if (pr.refuse) out(`note: ${pr.refuse}`);
  for (const f of pr.files) out(`  ${f.live.padEnd(18)} ${f.rel}`);
  const stale = pr.files.filter((f) => f.live !== "SERVED").length;
  process.exitCode = stale ? 1 : 0;
  return out(stale
    ? `${stale} of ${pr.files.length} UI file(s) are not what the game serves`
    : `all ${pr.files.length} UI file(s) are what the game serves`);
}

function reloadVerdict(reloaded) {
  if (reloaded) return "the page reloaded after the copy, so SERVED files are now the running code";
  if (reloaded === false) {
    return "the page did NOT reload: SERVED files are on disk but the old code is still running (--no-reload, or not in a game)";
  }
  return "could not tell whether the page reloaded";
}

function printApplied(r) {
  for (const f of r.files) out(`  ${f.live.padEnd(18)} ${f.state.padEnd(8)} ${f.rel}`);
  if (!r.connected) return out("copied. The game is not running, so nothing could be proven live yet.");
  return out(reloadVerdict(r.reloaded));
}

/** @param {Ctx} ctx @param {string} dir */
async function deployCommand({ bench, opt }, dir) {
  const r = await bench.deploy(dir, { yes: !!opt.yes, reload: !opt["no-reload"] });
  const p = r.plan;
  if (p.refuse) throw new BenchError(p.refuse);
  out(`${p.modId}: live copy is ${p.liveLabel} (${p.liveDir})`);
  if (p.ownDeploy) {
    out(`note: this mod has its own deploy (${p.ownDeploy}). Prefer it: it can ship files the modinfo does not declare, such as images. Then run "deploy ${dir} --prove".`);
  }
  if (p.inPlace) return out("that folder IS the live copy, so edits there are already on disk; nothing to copy");
  const changes = p.changes ?? [];
  for (const m of p.missing ?? []) out(`  declared but missing in the source: ${m}`);
  if (!changes.length) return out("the live copy already matches the source");
  if (!r.applied) {
    for (const c of changes) out(`  would copy (${c.state}) ${c.rel}`);
    return out(`${changes.length} file(s) differ; add --yes to copy them`);
  }
  return printApplied(r);
}

/** @param {Ctx} ctx @param {string} file */
async function recipeRun({ bench, paths, opt }, file) {
  if (!opt.yes) throw new BenchError("a recipe changes the running game; add --yes");
  bench.armed = true;
  const lab = new Lab(paths);
  const inLab = lab.current?.pid && gamePid() === lab.current.pid;
  const endTurns = inLab ? (n) => lab.endTurns(n) : null;
  const r = await runRecipe(bench, loadRecipe(file), { endTurns, log: (m) => out(m) });
  process.exitCode = r.passed ? 0 : 1;
  return out(r.passed ? "recipe passed" : "recipe FAILED");
}

/** @param {Ctx} ctx */
function listMods({ paths, opt }) {
  const mods = modHealth(readMods(paths.modsDb), paths);
  const matched = filterMods(mods, opt.filter);
  const shown = opt.all || opt.filter ? matched : matched.filter((m) => m.issues.length);
  for (const m of shown) printMod(m);
  const enabled = mods.filter((m) => m.enabled).length;
  const noted = mods.filter((m) => m.issues.length).length;
  const hint = opt.all || opt.filter ? "" : " (--all lists every mod, --filter <text> searches id, name and author)";
  return out(`${mods.length} mod ids, ${enabled} enabled, ${noted} with notes${hint}`);
}

/** @param {Ctx} ctx @param {string[]} args */
function changeMods({ bench, opt }, [op, id, ...copy]) {
  if (!["on", "off", "live"].includes(op) || !id) throw new BenchError("usage: mods on|off <id> [copy] | mods live <id> <copy>");
  if (!opt.yes) throw new BenchError("this changes which mods the game loads at its next launch; add --yes");
  bench.armed = true;
  return printWrite(bench.setMods({ op, id, copy: copy.join(" ") || undefined }));
}

/** @type {Record<string, import("./common.mjs").Handler>} */
export const FILE_COMMANDS = {
  mods: (ctx, args) => (args.length ? changeMods(ctx, args) : listMods(ctx)),
  logs: (ctx) => {
    const show = logPrinter(ctx);
    show(readRecent(ctx.paths.logs));
    if (!ctx.opt.follow) return undefined;
    const tail = new LogTail(ctx.paths.logs);
    tail.seekToEnd();
    setInterval(() => show(tail.poll()), 700);
    return new Promise(() => {});
  },
  evidence: ({ bench, opt }) => {
    const entries = bench.evidence.read(opt.date ?? localDate());
    if (opt.md) return out(toMarkdown(entries) || "(no writes recorded that day)");
    for (const e of entries) {
      const verdict = e.result?.verdict ?? e.result?.error ?? "";
      out(`${e.ts.slice(11, 19)}  ${e.kind.padEnd(5)}  ${JSON.stringify(e.request).slice(0, 90)}  ${verdict}`);
    }
    return out(`${entries.length} entries in ${bench.evidence.fileFor(opt.date ?? localDate())}`);
  },
  deploy: (ctx, args) => {
    if (!args[0]) throw new BenchError("deploy <mod-folder> [--yes | --prove]");
    return ctx.opt.prove ? proveCommand(ctx, args[0]) : deployCommand(ctx, args[0]);
  },
  recipe: (ctx, args) => {
    const [sub, file] = args;
    if (sub === "record") return out(recipeFromEvidence(ctx.bench.evidence.read(localDate()), { since: ctx.opt.since }));
    if (sub === "run") return recipeRun(ctx, file);
    throw new BenchError("recipe run <file> --yes | recipe record [--since HH:MM]");
  },
};
