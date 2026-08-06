import { describe, expect, it } from "vitest";
import { AtomicsBarrier } from "@sim/runtime";

describe("AtomicsBarrier", () => {
  it("a single party passes straight through, generation advancing each time", () => {
    const barrier = AtomicsBarrier.allocate(1);
    const gen = new Int32Array(barrier.sab);
    barrier.arrive();
    barrier.arrive();
    barrier.arrive();
    expect(gen[1]).toBe(3);
    expect(gen[0]).toBe(0); // count reset after each generation
  });

  it("times out instead of deadlocking when parties are missing", () => {
    const barrier = AtomicsBarrier.allocate(2);
    const t0 = Date.now();
    expect(() => barrier.arrive(40)).toThrow(/barrier timeout .*1\/2 arrived/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
  });

  it("two barriers over the same SAB complete each other", () => {
    // Simulates two threads' views of the same barrier memory: the second
    // arrival is the release, so neither blocks.
    const a = AtomicsBarrier.allocate(2);
    const b = new AtomicsBarrier(a.sab, 2);
    const arr = new Int32Array(a.sab);
    Atomics.add(arr, 0, 1); // stand-in for the other thread's arrival
    b.arrive(1000); // completes the pair: resets count, bumps generation
    expect(arr[1]).toBe(1);
    expect(arr[0]).toBe(0);
  });

  it("rejects invalid party counts", () => {
    expect(() => AtomicsBarrier.allocate(0)).toThrow(/>= 1/);
  });
});
