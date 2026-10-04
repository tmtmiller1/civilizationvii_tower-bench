// Node side of the registry view: what the running game applied, set against Mods.sqlite, which is what
// the game will load at its next launch. The two disagree for ordinary reasons, each named here.

const REASONS = {
  onlyNow: "applied to this game but switched off for the next launch, or re-enabled by loading a save that lists it",
  onlyNext: "enabled for the next launch but not in this game: none of its action groups met their criteria in this game "
    + "(Modding.log lists the mod with no group under it), switched on after the game started, or a save loaded with its "
    + "own mod list. The first launch after a game update also loads no mods.",
};

/**
 * @param {{ id: string | null, official: boolean }[]} active from Modding.getActiveMods()
 * @param {{ id: string, disabled: number | null, path: string }[]} rows from Mods.sqlite
 * @param {(row: any) => boolean} isOfficial
 */
export function compareActive(active, rows, isOfficial) {
  const now = new Set(active.filter((m) => !m.official && m.id).map((m) => String(m.id)));
  const next = new Set(rows.filter((r) => !r.disabled && !isOfficial(r)).map((r) => r.id));
  const onlyNow = [...now].filter((id) => !next.has(id)).sort();
  const onlyNext = [...next].filter((id) => !now.has(id)).sort();
  return {
    now: now.size, next: next.size, onlyNow, onlyNext,
    notes: [onlyNow.length ? REASONS.onlyNow : null, onlyNext.length ? REASONS.onlyNext : null].filter(Boolean),
  };
}

// Official content that is always there, whatever the game reports as active.
const BASE_ROOTS = ["core", "base-standard", "age-antiquity", "age-exploration", "age-modern"];

/**
 * Components a mod replaced: a legacy definition or a ui-next registration above the base priority of 0,
 * or a definition whose files come from a mod. Official module ids come from the game's own active list.
 */
export function overridden(info) {
  const official = new Set([...BASE_ROOTS, ...(info.activeMods ?? []).filter((m) => m.official).map((m) => m.id)]);
  const controls = (info.controls ?? []).map((c) => ({ ...c, mods: c.mods.filter((m) => !official.has(m)) }));
  return {
    controls: controls.filter((c) => c.priority > 0 || c.mods.length)
      .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name)),
    components: (info.components ?? []).filter((c) => c.priority > 0)
      .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name)),
  };
}
