// Finds which mod a failure needs, by isolation. Crashes in this game are not fully deterministic
// (four 40-turn runs on one config faulted on different signatures), so every configuration runs
// `replicates` times: it counts as failing if ANY replicate fails and clean only if ALL are clean.
//
// `trial(enabled)` runs one test game with exactly the candidate mods in `enabled` switched on and
// resolves to { failed, detail }.

export async function bisect({ candidates, trial, replicates = 2, log = () => {} }) {
  const trials = [];
  const run = async (enabled, label) => {
    const reps = [];
    for (let k = 0; k < replicates; k++) {
      const r = await trial(enabled);
      reps.push(r);
      trials.push({ label, enabled: [...enabled], replicate: k + 1, ...r });
      log(`${label} [${enabled.length} on] replicate ${k + 1}/${replicates}: ${r.failed ? "FAILED" : "clean"}${r.detail ? ` (${r.detail})` : ""}`);
      if (r.failed) break;
    }
    return reps.some((r) => r.failed);
  };

  if (!(await run(candidates, "baseline, all candidates on"))) {
    return { verdict: "NOT REPRODUCED", detail: `no failure in ${replicates} run(s) with every candidate on, so nothing to isolate`, trials };
  }
  if (await run([], "control, all candidates off")) {
    return { verdict: "NOT A CANDIDATE", detail: "fails with every candidate off: the cause is outside this mod set (another mod, the base game, or the test)", trials };
  }
  let suspects = [...candidates];
  while (suspects.length > 1) {
    const half = Math.ceil(suspects.length / 2);
    const [a, b] = [suspects.slice(0, half), suspects.slice(half)];
    if (await run(a, `only ${a.join(", ")}`)) { suspects = a; continue; }
    if (await run(b, `only ${b.join(", ")}`)) { suspects = b; continue; }
    return { verdict: "INTERACTION", detail: `fails with ${suspects.join(", ")} together but with neither half alone: the failure needs mods from both halves`, suspects, trials };
  }
  const [culprit] = suspects;
  const rest = candidates.filter((m) => m !== culprit);
  const withoutIt = await run(rest, `every candidate except ${culprit}`);
  return {
    verdict: withoutIt ? "INCONCLUSIVE" : "ISOLATED",
    culprit,
    detail: withoutIt
      ? `${culprit} alone fails, but the others fail without it too: more than one cause`
      : `${culprit} alone fails and everything else without it is clean`,
    trials,
  };
}
