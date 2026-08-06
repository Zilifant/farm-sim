import { describe, expect, it } from "vitest";
import { RingProfiler, quantile } from "@sim/runtime";

function makeProfiler(capacity?: number): {
  profiler: RingProfiler;
  record: (systemId: string, durationMs: number) => void;
} {
  let now = 0;
  const profiler = new RingProfiler({
    ...(capacity !== undefined ? { capacity } : {}),
    now: () => now,
  });
  return {
    profiler,
    record(systemId, durationMs): void {
      const stop = profiler.span(systemId, 0n);
      now += durationMs;
      stop();
    },
  };
}

describe("RingProfiler", () => {
  it("reports p50/p95/max/mean per system", () => {
    const { profiler, record } = makeProfiler();
    for (let d = 1; d <= 100; d += 1) {
      record("sys", d);
    }
    const [timings] = profiler.report();
    expect(timings).toBeDefined();
    expect(timings?.systemId).toBe("sys");
    expect(timings?.samples).toBe(100);
    expect(timings?.p50Ms).toBe(50);
    expect(timings?.p95Ms).toBe(95);
    expect(timings?.maxMs).toBe(100);
    expect(timings?.meanMs).toBeCloseTo(50.5);
  });

  it("keeps systems separate", () => {
    const { profiler, record } = makeProfiler();
    record("a", 1);
    record("b", 9);
    const ids = profiler.report().map((t) => t.systemId);
    expect(ids).toEqual(["a", "b"]);
  });

  it("ring-buffers samples, evicting the oldest", () => {
    const { profiler, record } = makeProfiler(4);
    for (const d of [100, 100, 1, 2, 3, 4]) {
      record("sys", d);
    }
    const [timings] = profiler.report();
    expect(timings?.samples).toBe(4);
    expect(timings?.maxMs).toBe(4); // the two 100s were evicted
  });

  it("rejects invalid capacity", () => {
    expect(() => new RingProfiler({ capacity: 0 })).toThrow(RangeError);
  });
});

describe("quantile", () => {
  it("computes nearest-rank quantiles on unsorted input", () => {
    const values = [5, 1, 4, 2, 3];
    expect(quantile(values, 0.5)).toBe(3);
    expect(quantile(values, 0.95)).toBe(5);
    expect(quantile(values, 0.01)).toBe(1);
    expect(quantile([], 0.5)).toBe(0);
    expect(quantile([7], 0.99)).toBe(7);
    expect(values).toEqual([5, 1, 4, 2, 3]); // input untouched
  });
});
