import { describe, expect, it } from "vitest";
import { WriteGuard, guardView } from "@sim/runtime";

describe("WriteGuard", () => {
  const guard = new WriteGuard([
    { start: 0, end: 10 },
    { start: 20, end: 30 },
  ], "worker 1");

  it("allows writes inside any range", () => {
    expect(guard.allows(0)).toBe(true);
    expect(guard.allows(9)).toBe(true);
    expect(guard.allows(20)).toBe(true);
    expect(guard.allows(29)).toBe(true);
  });

  it("throws on out-of-range writes with a diagnostic", () => {
    expect(guard.allows(10)).toBe(false);
    expect(guard.allows(15)).toBe(false);
    expect(guard.allows(30)).toBe(false);
    expect(() => guard.assert(15)).toThrow(/worker 1: out-of-range write at element 15/);
  });
});

describe("guardView", () => {
  it("enforces the guard on indexed stores, passes reads through", () => {
    const raw = new Int16Array(40);
    const guarded = guardView(raw, new WriteGuard([{ start: 0, end: 10 }]));
    guarded[5] = 123;
    expect(raw[5]).toBe(123);
    expect(guarded[5]).toBe(123);
    expect(guarded.length).toBe(40);
    expect(() => {
      guarded[10] = 1;
    }).toThrow(/out-of-range write at element 10/);
    expect(raw[10]).toBe(0);
  });
});
