import { describe, expect, it } from "vitest";
import { RowRegionMap } from "@sim/runtime";

const W = 10;

describe("RowRegionMap", () => {
  const map = new RowRegionMap({
    width: W,
    height: 30,
    strips: [
      { start: 0, count: 10 },
      { start: 10, count: 10 },
      { start: 20, count: 10 },
    ],
  });

  it("maps element indices to their owning worker", () => {
    expect(map.ownerOf(0)).toBe(0);
    expect(map.ownerOf(9 * W + 9)).toBe(0);
    expect(map.ownerOf(10 * W)).toBe(1);
    expect(map.ownerOf(29 * W + 5)).toBe(2);
    expect(() => map.ownerOf(30 * W)).toThrow(/outside/);
  });

  it("gives each worker an exclusive write range", () => {
    expect(map.writeRange(0)).toEqual({ start: 0, end: 100 });
    expect(map.writeRange(1)).toEqual({ start: 100, end: 200 });
    expect(map.writeRange(2)).toEqual({ start: 200, end: 300 });
  });

  it("ghost ranges are the toroidally adjacent border rows", () => {
    // Worker 0's up-neighbor row wraps to row 29; down-neighbor is row 10.
    expect(map.ghostRanges(0)).toEqual([
      { start: 290, end: 300 },
      { start: 100, end: 110 },
    ]);
    expect(map.ghostRanges(1)).toEqual([
      { start: 90, end: 100 },
      { start: 200, end: 210 },
    ]);
  });

  it("writable ranges merge owned rows with spill rows", () => {
    // Worker 1: spill row 9 + owned rows 10..19 + spill row 20 → contiguous.
    expect(map.writableRanges(1)).toEqual([{ start: 90, end: 210 }]);
    // Worker 0: wrap splits the writable set.
    expect(map.writableRanges(0)).toEqual([
      { start: 0, end: 110 },
      { start: 290, end: 300 },
    ]);
  });

  it("a single worker owning everything has no ghosts", () => {
    const solo = new RowRegionMap({ width: W, height: 10, strips: [{ start: 0, count: 10 }] });
    expect(solo.ghostRanges(0)).toEqual([]);
    expect(solo.writableRanges(0)).toEqual([{ start: 0, end: 100 }]);
  });

  it("rejects gaps, overlaps, and short coverage", () => {
    expect(
      () => new RowRegionMap({ width: W, height: 10, strips: [{ start: 0, count: 4 }, { start: 5, count: 5 }] }),
    ).toThrow(/contiguous/);
    expect(
      () => new RowRegionMap({ width: W, height: 10, strips: [{ start: 0, count: 5 }] }),
    ).toThrow(/grid has 10 rows/);
  });
});
