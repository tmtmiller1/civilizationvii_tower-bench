// Extensions: a separate tool can add commands, flags, server routes and a page tab to the bench by
// registering here and then importing tower-bench.mjs. The bench itself registers none.

/**
 * @typedef {{
 *   name: string,
 *   help?: string,
 *   commands?: Record<string, import("./cli/common.mjs").Handler>,
 *   options?: Record<string, { type: "string" | "boolean", short?: string }>,
 *   routes?: Record<string, (bench: import("./bench.mjs").Bench, req: any, query: URLSearchParams,
 *     readBody: () => Promise<any>) => any>,
 *   uiDir?: string,
 *   uiModules?: string[],
 * }} Extension
 */

/** @type {Extension[]} */
const EXTENSIONS = [];

/** @param {Extension} ext */
export function registerExtension(ext) {
  if (!/^[a-z][a-z0-9-]*$/.test(ext.name)) throw new Error(`extension name "${ext.name}" must be lowercase letters, digits and -`);
  if (EXTENSIONS.some((e) => e.name === ext.name)) throw new Error(`extension "${ext.name}" is already registered`);
  EXTENSIONS.push(ext);
}

export const extensions = () => EXTENSIONS;

/** Every extension's entries of one kind, merged. */
export const merged = (key) => Object.assign({}, ...EXTENSIONS.map((e) => e[key] ?? {}));

// The page loads an extension's modules from /ext/<name>/<file>; only the .js files directly in its uiDir are served.
export const extensionModuleUrls = () => EXTENSIONS.flatMap((e) => (e.uiModules ?? []).map((f) => `/ext/${e.name}/${f}`));
