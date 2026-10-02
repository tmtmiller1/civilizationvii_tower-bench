// Pure: delta debugging (Zeller's ddmin) over an abstract oracle. `fails(seq)` replays a subsequence and says
// whether the same failure still happens; each call is a whole test game, so results are cached by the chosen
// positions and the number of calls is capped. The answer is 1-minimal: removing any single step passes.

export class BudgetExhausted extends Error {
  constructor() { super("the game budget ran out while shrinking"); }
}

function chunksOf(xs, n) {
  const out = [];
  const size = Math.ceil(xs.length / n);
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

function makeTester(seq, fails, maxTests, log) {
  const cache = new Map();
  const state = { tests: 0 };
  const test = async (/** @type {number[]} */ idx) => {
    const key = idx.join(",");
    if (cache.has(key)) return cache.get(key);
    if (state.tests >= maxTests) throw new BudgetExhausted();
    state.tests += 1;
    const r = !!(await fails(idx.map((i) => seq[i])));
    cache.set(key, r);
    log(`shrink test ${state.tests}: ${idx.length} step(s) -> ${r ? "still fails" : "passes"}`);
    return r;
  };
  return { test, state };
}

// One ddmin round at granularity n: a failing chunk, else a failing complement, else null.
async function reduceOnce(test, cur, n) {
  const chunks = chunksOf(cur, n);
  for (const c of chunks) if (c.length < cur.length && (await test(c))) return { cur: c, n: 2 };
  if (n <= 2) return null; // with two chunks each complement is the other chunk, tried above
  for (const c of chunks) {
    const rest = cur.filter((i) => !c.includes(i));
    if (await test(rest)) return { cur: rest, n: Math.max(n - 1, 2) };
  }
  return null;
}

async function ddmin(test, start) {
  let cur = start;
  let n = 2;
  while (cur.length >= 2) {
    const r = await reduceOnce(test, cur, n);
    if (r) ({ cur, n } = r);
    else if (n >= cur.length) break;
    else n = Math.min(cur.length, n * 2);
  }
  return cur;
}

// ddmin is 1-minimal already; this pass re-checks single removals cheaply through the cache.
async function dropSingles(test, start) {
  let cur = start;
  for (let k = cur.length - 1; k >= 0 && cur.length > 1; k--) {
    const rest = cur.filter((_, j) => j !== k);
    if (await test(rest)) cur = rest;
  }
  return cur;
}

/**
 * @template T
 * @param {T[]} seq the failing sequence (assumed to fail; confirm that before shrinking)
 * @param {(sub: T[]) => Promise<boolean> | boolean} fails
 * @param {{ maxTests?: number, log?: (line: string) => void }} [o]
 * @returns {Promise<{ minimal: T[], indices: number[], tests: number, exhausted: boolean }>}
 */
export async function shrink(seq, fails, { maxTests = Infinity, log = () => {} } = {}) {
  const { test, state } = makeTester(seq, fails, maxTests, log);
  let cur = seq.map((_, i) => i);
  let exhausted = false;
  const keep = (/** @type {number[]} */ c) => { cur = c; };
  try {
    const tracked = async (/** @type {number[]} */ c) => {
      const r = await test(c);
      if (r && c.length < cur.length) keep(c);
      return r;
    };
    keep(await ddmin(tracked, cur));
    keep(await dropSingles(tracked, cur));
  } catch (e) {
    if (!(e instanceof BudgetExhausted)) throw e;
    exhausted = true;
  }
  return { minimal: cur.map((i) => seq[i]), indices: cur, tests: state.tests, exhausted };
}
