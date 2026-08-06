import { describe, expect, it } from "vitest";
import {
  BufferRegistry,
  RingProfiler,
  Sfc32Stream,
  SystemScheduler,
  TickExecutor,
  bufferId,
  type BufferId,
  type System,
  type SystemContext,
} from "@sim/runtime";

const A = bufferId("a");
const B = bufferId("b");

function makeRegistry(): BufferRegistry {
  const buffers = new BufferRegistry();
  buffers.define(A, { type: Uint8Array, length: 4 });
  buffers.define(B, { type: Float64Array, length: 4 });
  return buffers;
}

function makeSystem(
  id: string,
  opts: {
    everyNTicks?: number;
    reads?: BufferId[];
    writes?: BufferId[];
    onUpdate?: (ctx: SystemContext) => void;
    onInit?: (ctx: SystemContext) => void;
  } = {},
): System {
  return {
    id,
    everyNTicks: opts.everyNTicks ?? 1,
    reads: opts.reads ?? [],
    writes: opts.writes ?? [],
    init: (ctx) => opts.onInit?.(ctx),
    update: (ctx) => opts.onUpdate?.(ctx),
  };
}

async function makeExecutor(
  systems: System[],
  opts: { profiler?: RingProfiler; seed?: string } = {},
): Promise<TickExecutor> {
  const buffers = makeRegistry();
  const scheduler = new SystemScheduler(buffers);
  for (const s of systems) {
    scheduler.register(s);
  }
  const executor = new TickExecutor({
    plan: scheduler.plan(),
    buffers,
    rng: Sfc32Stream.create(opts.seed ?? "test"),
    fixedDtMs: 10,
    ...(opts.profiler ? { profiler: opts.profiler } : {}),
  });
  await executor.init();
  return executor;
}

describe("SystemScheduler", () => {
  it("plans systems in registration order", () => {
    const scheduler = new SystemScheduler(makeRegistry());
    scheduler.register(makeSystem("one"));
    scheduler.register(makeSystem("two"));
    scheduler.register(makeSystem("three"));
    expect(scheduler.plan().systems.map((e) => e.system.id)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("rejects duplicate system ids", () => {
    const scheduler = new SystemScheduler(makeRegistry());
    scheduler.register(makeSystem("dup"));
    expect(() => scheduler.register(makeSystem("dup"))).toThrow(/already registered/);
  });

  it("rejects systems declaring unknown buffers", () => {
    const scheduler = new SystemScheduler(makeRegistry());
    expect(() =>
      scheduler.register(makeSystem("bad", { reads: [bufferId("nope")] })),
    ).toThrow(/unknown buffer/);
  });

  it("rejects invalid everyNTicks", () => {
    const scheduler = new SystemScheduler(makeRegistry());
    expect(() => scheduler.register(makeSystem("zero", { everyNTicks: 0 }))).toThrow();
    expect(() =>
      scheduler.register(makeSystem("frac", { everyNTicks: 1.5 })),
    ).toThrow();
  });
});

describe("TickExecutor", () => {
  it("runs systems only on their everyNTicks cadence", async () => {
    const calls: Array<[string, bigint]> = [];
    const executor = await makeExecutor([
      makeSystem("every", { onUpdate: (ctx) => calls.push(["every", ctx.tick]) }),
      makeSystem("third", {
        everyNTicks: 3,
        onUpdate: (ctx) => calls.push(["third", ctx.tick]),
      }),
    ]);
    for (let t = 0n; t < 7n; t += 1n) {
      executor.runTick(t);
    }
    expect(calls.filter(([id]) => id === "every")).toHaveLength(7);
    expect(calls.filter(([id]) => id === "third").map(([, t]) => t)).toEqual([
      0n,
      3n,
      6n,
    ]);
  });

  it("provides declared buffers and rejects undeclared access", async () => {
    let ctxRef: SystemContext | undefined;
    const executor = await makeExecutor([
      makeSystem("sys", {
        reads: [A],
        writes: [A],
        onUpdate: (ctx) => {
          ctxRef = ctx;
          ctx.buffer<Uint8Array>(A)[0] = 7;
        },
      }),
    ]);
    executor.runTick(0n);
    expect(ctxRef?.buffer<Uint8Array>(A)[0]).toBe(7);
    expect(() => ctxRef?.buffer(B)).toThrow(/undeclared buffer/);
  });

  it("gives each system a deterministic, distinct rng stream", async () => {
    const seen = new Map<string, number>();
    const build = async (): Promise<Map<string, number>> => {
      const out = new Map<string, number>();
      await makeExecutor([
        makeSystem("s1", { onInit: (ctx) => out.set("s1", ctx.rng.nextU32()) }),
        makeSystem("s2", { onInit: (ctx) => out.set("s2", ctx.rng.nextU32()) }),
      ]);
      return out;
    };
    const run1 = await build();
    const run2 = await build();
    expect(run1).toEqual(run2);
    expect(run1.get("s1")).not.toBe(run1.get("s2"));
    seen.clear();
  });

  it("refuses to run before init and to init twice", async () => {
    const buffers = makeRegistry();
    const scheduler = new SystemScheduler(buffers);
    const executor = new TickExecutor({
      plan: scheduler.plan(),
      buffers,
      rng: Sfc32Stream.create("x"),
      fixedDtMs: 10,
    });
    expect(() => executor.runTick(0n)).toThrow(/before init/);
    await executor.init();
    await expect(executor.init()).rejects.toThrow(/twice/);
  });

  it("records a profiler span per system update", async () => {
    const profiler = new RingProfiler();
    const executor = await makeExecutor(
      [makeSystem("timed"), makeSystem("skipped", { everyNTicks: 100 })],
      { profiler },
    );
    executor.runTick(1n);
    executor.runTick(2n);
    const report = profiler.report();
    expect(report.map((t) => t.systemId)).toEqual(["timed"]);
    expect(report.find((t) => t.systemId === "timed")?.samples).toBe(2);
  });
});
