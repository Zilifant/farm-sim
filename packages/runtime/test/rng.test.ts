import { describe, expect, it } from "vitest";
import { Sfc32Stream } from "@sim/runtime";

function draw(stream: { nextU32(): number }, n: number): number[] {
  return Array.from({ length: n }, () => stream.nextU32());
}

describe("Sfc32Stream", () => {
  it("is reproducible for the same seed and streamId", () => {
    const a = Sfc32Stream.create("seed-1", "root");
    const b = Sfc32Stream.create("seed-1", "root");
    expect(draw(a, 1000)).toEqual(draw(b, 1000));
  });

  it("differs across seeds and across streamIds", () => {
    expect(draw(Sfc32Stream.create("seed-1"), 8)).not.toEqual(
      draw(Sfc32Stream.create("seed-2"), 8),
    );
    expect(draw(Sfc32Stream.create("seed-1", "a"), 8)).not.toEqual(
      draw(Sfc32Stream.create("seed-1", "b"), 8),
    );
  });

  it("forks deterministically and independently of parent consumption", () => {
    const parent1 = Sfc32Stream.create("seed", "root");
    const parent2 = Sfc32Stream.create("seed", "root");
    draw(parent2, 100); // consuming the parent must not change fork output
    expect(draw(parent1.fork("child"), 100)).toEqual(
      draw(parent2.fork("child"), 100),
    );
  });

  it("gives distinct sequences to parent, child, and siblings", () => {
    const parent = Sfc32Stream.create("seed", "root");
    const a = parent.fork("a");
    const b = parent.fork("b");
    const parentSeq = draw(Sfc32Stream.create("seed", "root"), 8);
    expect(draw(a, 8)).not.toEqual(draw(b, 8));
    expect(draw(parent.fork("a2"), 8)).not.toEqual(parentSeq);
  });

  it("rejects an empty fork id", () => {
    expect(() => Sfc32Stream.create("s").fork("")).toThrow();
  });

  it("nextF64 stays in [0, 1)", () => {
    const stream = Sfc32Stream.create(42);
    for (let i = 0; i < 10_000; i += 1) {
      const v = stream.nextF64();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("nextU32 covers the full 32-bit range roughly uniformly", () => {
    const stream = Sfc32Stream.create("uniformity");
    let high = 0;
    const n = 10_000;
    for (let i = 0; i < n; i += 1) {
      if (stream.nextU32() >= 0x80000000) {
        high += 1;
      }
    }
    expect(high / n).toBeGreaterThan(0.45);
    expect(high / n).toBeLessThan(0.55);
  });
});
