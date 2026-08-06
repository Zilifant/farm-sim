import { describe, expect, it } from "vitest";
import { hashCell, hashU32, seedToU32, splitTick } from "@sim/runtime";

describe("counter-based rng", () => {
  it("hashCell is deterministic and input-sensitive", () => {
    const base = hashCell(1, 2, 3, 4, 5);
    expect(hashCell(1, 2, 3, 4, 5)).toBe(base);
    expect(hashCell(2, 2, 3, 4, 5)).not.toBe(base);
    expect(hashCell(1, 3, 3, 4, 5)).not.toBe(base);
    expect(hashCell(1, 2, 4, 4, 5)).not.toBe(base);
    expect(hashCell(1, 2, 3, 5, 5)).not.toBe(base);
    expect(hashCell(1, 2, 3, 4, 6)).not.toBe(base);
  });

  it("hashCell output is roughly uniform over adjacent cells", () => {
    let high = 0;
    const n = 10_000;
    for (let cell = 0; cell < n; cell += 1) {
      if (hashCell(0xdeadbeef, 0, 0, cell, 1) >= 0x80000000) {
        high += 1;
      }
    }
    expect(high / n).toBeGreaterThan(0.45);
    expect(high / n).toBeLessThan(0.55);
  });

  it("hashU32 distinguishes argument lists", () => {
    expect(hashU32(1, 2)).toBe(hashU32(1, 2));
    expect(hashU32(1, 2)).not.toBe(hashU32(2, 1));
    expect(hashU32(1, 2)).not.toBe(hashU32(1, 2, 0));
  });

  it("seedToU32 is deterministic and seed-sensitive", () => {
    expect(seedToU32("wa-tor")).toBe(seedToU32("wa-tor"));
    expect(seedToU32("wa-tor")).not.toBe(seedToU32("wa-tor2"));
    expect(seedToU32(42)).toBe(seedToU32("42"));
  });

  it("splitTick splits a bigint tick into u32 halves", () => {
    expect(splitTick(0n)).toEqual({ lo: 0, hi: 0 });
    expect(splitTick(0x1_0000_0005n)).toEqual({ lo: 5, hi: 1 });
    expect(splitTick(0xffffffffn)).toEqual({ lo: 0xffffffff, hi: 0 });
  });
});
