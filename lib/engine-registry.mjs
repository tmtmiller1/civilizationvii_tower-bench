/* global Controls, Modding */
// Page side of the registry view. Runs in the game through CdpSession.call, so it must be self-contained.
// Every API is probed before use and reported as unavailable rather than thrown on: the view is only as
// good as what this game version exposes.

/** @param {{ registryModule?: string }} [args] */
export async function registryInfo({ registryModule = "/core/ui-next/services/component-registry.js" } = {}) {
  const modOf = (s) => String(s ?? "").match(/fs:\/\/game\/([^/]+)\//)?.[1] ?? null;
  const fnName = (f) => (typeof f === "function" ? f.name || "(anonymous)" : null);

  // Legacy components: a later Controls.define with an equal or higher priority replaces the definition.
  const readControls = () => Controls.getDefinitions().map((d) => {
    const files = [...(d.styles ?? []), ...(d.images ?? []), d.content].flat().filter((x) => typeof x === "string");
    return {
      name: d.name, priority: d.priority ?? 0, className: fnName(d.createInstance),
      mods: [...new Set(files.map(modOf).filter(Boolean))],
    };
  });

  // ui-next components: the registry keeps one wrapper per name pointing at the highest priority
  // registration; the losers are not recorded anywhere, which is why the static check names them.
  const readComponents = async () => {
    const { ComponentRegistry } = await import(registryModule);
    const map = ComponentRegistry?.componentFactories;
    if (!(map instanceof Map)) return null;
    return [...map].map(([name, w]) => {
      let current = null;
      try { current = fnName(w.factory?.()); } catch { /* a factory accessor that throws stays unnamed */ }
      return { name, priority: w.overridePriority ?? 0, factory: current };
    });
  };

  // The mods this game was built with; Mods.sqlite says what the next launch will load.
  const readActive = () => Modding.getActiveMods().map((h) => {
    const m = Modding.getModInfo(h) ?? {};
    return { id: m.id ?? null, name: m.name ?? null, official: !!(m.official || m.subscriptionType === "OfficialContent") };
  });

  const has = (obj, ...fns) => typeof obj === "object" && obj !== null && fns.every((f) => typeof obj[f] === "function");
  const g = /** @type {any} */ (globalThis);
  const controls = has(g.Controls, "getDefinitions");
  const activeMods = has(g.Modding, "getActiveMods", "getModInfo");
  let components = null;
  let componentRegistryError = null;
  try {
    components = await readComponents();
  } catch (e) {
    componentRegistryError = String(e);
  }
  return {
    apis: { controls, componentRegistry: components !== null, activeMods,
      ...(componentRegistryError ? { componentRegistryError } : {}) },
    controls: controls ? readControls() : null,
    components,
    activeMods: activeMods ? readActive() : null,
  };
}
