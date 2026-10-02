// Page side of the instrumentation route. The counting copies of a mod's files keep their counts in
// globalThis.__tbCoverage (installed by the first one to run); these read, dump and zero them. Each runs
// in the game through CdpSession.call, so each is self-contained.

// Every registered file with its counts, and when this page's counter started.
export function coverageRead() {
  const c = /** @type {any} */ (globalThis).__tbCoverage;
  if (!c) return { installed: false, href: String(globalThis.location?.href ?? "") };
  const files = {};
  for (const [id, e] of Object.entries(c.files ?? {})) {
    const x = /** @type {any} */ (e);
    files[id] = { m: x.m, p: x.p, n: x.n, c: { ...x.c } };
  }
  return { installed: true, started: c.started, href: String(globalThis.location?.href ?? ""), files };
}

// Writes the counts to UI.log as [TB-COVERAGE] lines, which outlive the page and a crash.
export function coverageDump() {
  const g = /** @type {any} */ (globalThis);
  if (typeof g.__tbCovDump !== "function") return { installed: false, lines: 0 };
  return { installed: true, lines: g.__tbCovDump() };
}

// Zeroes the counts, so a read covers only what happens after this.
export function coverageReset() {
  const c = /** @type {any} */ (globalThis).__tbCoverage;
  if (!c) return { installed: false };
  for (const e of Object.values(c.files ?? {})) /** @type {any} */ (e).c = {};
  c.started = Date.now();
  return { installed: true, started: c.started };
}
