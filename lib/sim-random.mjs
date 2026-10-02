// A small seeded generator, so a fuzz run or a bootstrap can be repeated exactly from its seed.

/** A 32-bit hash of any number of strings or numbers, for deriving one seed from several. */
export function seedOf(...parts) {
  let h = 2166136261;
  for (const ch of parts.map(String).join("\u0000")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * mulberry32: fast, 32-bit state, good enough for test generation and resampling.
 * @param {number} seed
 */
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    /** an integer in [lo, hi] */
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    /** @template T @param {T[]} xs @returns {T | undefined} */
    pick: (xs) => (xs.length ? xs[Math.floor(next() * xs.length)] : undefined),
    chance: (p) => next() < p,
  };
}

/** @typedef {ReturnType<typeof makeRng>} Rng */
