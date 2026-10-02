import { BenchError } from "../bench.mjs";
import { out } from "./common.mjs";
import { libraryWithRuns, loadTechniques, searchTechniques } from "../techniques.mjs";

// Each optional part prints only when the entry has it.
const PARTS = [
  (t) => t.when && [`When: ${t.when}`],
  (t) => t.whenNot && [`Not when: ${t.whenNot}`],
  (t) => t.statusNote && [`Status: ${t.statusNote}`],
  (t) => t.snippet && ["", ...t.snippet.split("\n").map((l) => `    ${l}`)],
  (t) => t.pitfalls?.length && ["", "Pitfalls:", ...t.pitfalls.map((p) => `  - ${p}`)],
  (t) => t.evidence?.note && ["", `Evidence: ${t.evidence.note}`],
  (t) => t.watched && [`Watched by the bench: recipe ${t.watched.recipe ?? "(unnamed)"} passed in a lab game on game `
    + `${t.watched.version ?? "?"}, ${t.watched.date.slice(0, 10)}${t.lastRun && !t.lastRun.passed ? "; the latest run FAILED" : ""}`],
  (t) => t.related?.length && [`Related: ${t.related.join(", ")}`],
];

function showEntry(t) {
  const head = [`${t.title}  (${t.id}, ${t.kind === "avoid" ? "avoid" : t.status} on the current game)`, "", t.purpose, "",
    `Why: ${t.why}`];
  return [...head, ...PARTS.flatMap((part) => part(t) || [])].join("\n");
}

const tag = (t) => (t.kind === "avoid" ? "[avoid] " : t.status === "dead" ? "[dead] " : "");

function listHits(hits) {
  if (!hits.length) return out("No technique matches. Try a purpose (\"persist\", \"lens\") or an object (\"LensManager\").");
  for (const t of hits) out(`${t.id.padEnd(30)} ${tag(t)}${t.title}: ${t.purpose}`);
}

/** @type {Record<string, import("./common.mjs").Handler>} */
export const LIBRARY_COMMANDS = {
  techniques({ opt, paths }, args) {
    const lib = loadTechniques();
    if (!lib.entries.length) throw new BenchError("the techniques library is missing (lib/techniques/techniques.json)");
    if (args[0] === "show") {
      const t = libraryWithRuns(paths, lib).entries.find((x) => x.id === (args[1] ?? ""));
      if (!t) throw new BenchError(`no technique "${args[1] ?? ""}"; run "techniques" to list them`);
      return out(opt.json ? t : showEntry(t));
    }
    const hits = searchTechniques(args.join(" "));
    return opt.json ? out(hits) : listHits(hits);
  },
};
