import { describe, expect, it } from "vitest";
import { FixedStepClock } from "@sim/runtime";

interface Harness {
  clock: FixedStepClock;
  ticks: bigint[];
  /** Advance virtual time, firing scheduled timers as they come due. */
  advance(ms: number): void;
  /** Jump virtual time forward without firing timers (simulates a stall). */
  stall(ms: number): void;
}

function makeHarness(
  opts: { fixedDtMs?: number; maxTicksPerSlice?: number } = {},
): Harness {
  let now = 0;
  let pending: { cb: () => void; at: number } | undefined;
  const ticks: bigint[] = [];
  const clock = new FixedStepClock({
    fixedDtMs: opts.fixedDtMs ?? 10,
    ...(opts.maxTicksPerSlice !== undefined
      ? { maxTicksPerSlice: opts.maxTicksPerSlice }
      : {}),
    onTick: (t) => ticks.push(t),
    now: () => now,
    setTimer: (cb, delayMs) => {
      pending = { cb, at: now + delayMs };
      return pending;
    },
    clearTimer: () => {
      pending = undefined;
    },
  });
  return {
    clock,
    ticks,
    advance(ms: number): void {
      const target = now + ms;
      while (pending !== undefined && pending.at <= target) {
        now = Math.max(now, pending.at);
        const { cb } = pending;
        pending = undefined;
        cb();
      }
      now = target;
    },
    stall(ms: number): void {
      now += ms;
    },
  };
}

describe("FixedStepClock", () => {
  it("ticks at the fixed rate while running", () => {
    const h = makeHarness({ fixedDtMs: 10 });
    h.clock.start();
    h.advance(100);
    expect(h.ticks).toEqual([0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n]);
    expect(h.clock.tick).toBe(10n);
  });

  it("pause stops ticking and start resumes", () => {
    const h = makeHarness({ fixedDtMs: 10 });
    h.clock.start();
    h.advance(30);
    h.clock.pause();
    h.advance(100);
    expect(h.ticks.length).toBe(3);
    h.clock.start();
    h.advance(30);
    expect(h.ticks.length).toBe(6);
  });

  it("speed scales the tick rate", () => {
    const h = makeHarness({ fixedDtMs: 10 });
    h.clock.speed = 2;
    h.clock.start();
    h.advance(100);
    expect(h.ticks.length).toBe(20);
  });

  it("speed 0 idles without ticking while still running", () => {
    const h = makeHarness({ fixedDtMs: 10 });
    h.clock.speed = 0;
    h.clock.start();
    h.advance(200);
    expect(h.ticks.length).toBe(0);
    h.clock.speed = 1;
    h.advance(100);
    expect(h.ticks.length).toBeGreaterThanOrEqual(9);
  });

  it("rejects invalid speeds", () => {
    const h = makeHarness();
    expect(() => {
      h.clock.speed = -1;
    }).toThrow(RangeError);
    expect(() => {
      h.clock.speed = Number.NaN;
    }).toThrow(RangeError);
  });

  it("stepOnce runs exactly one tick while paused", async () => {
    const h = makeHarness();
    await h.clock.stepOnce();
    await h.clock.stepOnce();
    expect(h.ticks).toEqual([0n, 1n]);
    expect(h.clock.tick).toBe(2n);
  });

  it("stepOnce throws while the clock is running", async () => {
    const h = makeHarness();
    h.clock.start();
    await expect(h.clock.stepOnce()).rejects.toThrow(/paused/);
  });

  it("caps catch-up ticks after a long stall instead of spiraling", () => {
    const h = makeHarness({ fixedDtMs: 10, maxTicksPerSlice: 4 });
    h.clock.start();
    h.advance(1); // arm the recurring timer
    h.stall(10_000); // 10s stall with no timer service
    h.advance(0); // fire the overdue timer(s)
    // One capped slice (4) plus at most one immediate catch-up tick from the
    // clamped remainder — not the ~1000 a naive accumulator would run.
    expect(h.ticks.length).toBeLessThanOrEqual(5);
    expect(h.ticks.length).toBeGreaterThanOrEqual(4);
  });

  it("can be paused from inside onTick", () => {
    const h = makeHarness({ fixedDtMs: 10 });
    const clock = h.clock;
    let pauseAt = 2;
    const origPush = h.ticks.push.bind(h.ticks);
    h.ticks.push = (t: bigint): number => {
      const r = origPush(t);
      pauseAt -= 1;
      if (pauseAt === 0) {
        clock.pause();
      }
      return r;
    };
    clock.start();
    h.advance(200);
    expect(h.ticks.length).toBe(2);
    expect(clock.running).toBe(false);
  });
});
