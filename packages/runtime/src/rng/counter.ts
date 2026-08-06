// Counter-based (stateless) randomness: a hash of (seed, tick, cell, salt)
// rather than a sequential stream. Systems that must produce identical
// results regardless of region partitioning or iteration order draw from
// this — a stream's value depends on how many draws preceded it, a counter
// hash does not.

/** FNV-1a over a seed string (both bytes of each UTF-16 code unit). */
export function seedToU32(seed: string | number): number {
  const s = String(seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h ^= c & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= c >>> 8;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mixRound(h: number, k: number): number {
  k = Math.imul(k, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, 0x1b873593);
  h ^= k;
  h = (h << 13) | (h >>> 19);
  h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  return h;
}

function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Murmur3-style hash of (seed, tickLo, tickHi, cell, salt) → u32. */
export function hashCell(
  seed: number,
  tickLo: number,
  tickHi: number,
  cell: number,
  salt: number,
): number {
  let h = seed | 0;
  h = mixRound(h, tickLo);
  h = mixRound(h, tickHi);
  h = mixRound(h, cell);
  h = mixRound(h, salt);
  return fmix32(h);
}

/** General-purpose variadic variant of hashCell. */
export function hashU32(...parts: number[]): number {
  let h = 0x9e3779b9;
  for (const p of parts) {
    h = mixRound(h, p | 0);
  }
  h ^= parts.length;
  return fmix32(h);
}

export function splitTick(tick: bigint): { lo: number; hi: number } {
  return {
    lo: Number(tick & 0xffffffffn),
    hi: Number((tick >> 32n) & 0xffffffffn),
  };
}
