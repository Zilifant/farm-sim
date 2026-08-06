// Benchmark metric definitions. Micro (tinybench): RNG, hash, buffer ops.
// Macro (custom harness): ticks/sec and p95 tick time per execution mode,
// grid size, and worker count — the message-passing vs SAB rows ARE the
// postMessage+transfer vs SAB border-exchange comparison. The quick set is
// what CI re-measures; --full adds the large-grid matrix. Grid sizes are
// multiples of 5 (255/1020/2040 standing in for 256²/1024²/2048²).

import { Bench } from "tinybench";
import { Sfc32Stream, fnv1a32, hashBuffers, hashCell, quantile } from "@sim/runtime";
import { createWaTorSim } from "../index.js";
import { createParallelWaTorSim } from "../parallel.js";
import { createSharedWaTorSim } from "../parallel-shared.js";

export interface MetricResult {
  readonly id: string;
  /** Primary throughput figure — the regression-checked number. */
  readonly value: number;
  readonly unit: "ops/sec" | "ticks/sec";
  /** Informational p95 tick time where the mode exposes per-tick timing. */
  readonly p95TickMs?: number;
}

const SEED = "bench";
const WARMUP_TICKS = 30;

export async function runMicro(): Promise<MetricResult[]> {
  const bench = new Bench({ time: 120, warmupTime: 40 });
  const stream = Sfc32Stream.create(SEED);
  const buf64k = new Uint8Array(1 << 16);
  for (let i = 0; i < buf64k.length; i += 1) {
    buf64k[i] = (i * 7) & 0xff;
  }
  const grid = {
    species: new Uint8Array(900),
    energy: new Int16Array(900),
    breedAge: new Int16Array(900),
  };
  const mib = new Uint8Array(1 << 20);
  const mibDst = new Uint8Array(1 << 20);
  let cell = 0;

  bench.add("micro.rng.nextU32", () => {
    stream.nextU32();
  });
  bench.add("micro.rng.nextF64", () => {
    stream.nextF64();
  });
  bench.add("micro.rng.hashCell", () => {
    cell = (cell + 1) & 0xffff;
    hashCell(0x12345678, 42, 0, cell, 1);
  });
  bench.add("micro.hash.fnv1a32-64KiB", () => {
    fnv1a32(buf64k);
  });
  bench.add("micro.hash.wator-grid-30x30", () => {
    hashBuffers([grid.species, grid.energy, grid.breedAge]);
  });
  bench.add("micro.buffer.copy-1MiB", () => {
    mibDst.set(mib);
  });

  await bench.run();
  return bench.tasks.map((task) => {
    const result = task.result;
    const mean = result !== undefined && "throughput" in result ? result.throughput.mean : 0;
    return { id: task.name, value: mean, unit: "ops/sec" as const };
  });
}

async function macroSequential(grid: number, ticks: number): Promise<MetricResult> {
  const sim = await createWaTorSim({ width: grid, height: grid, seed: SEED });
  sim.run(WARMUP_TICKS);
  const t0 = performance.now();
  sim.run(ticks);
  const elapsed = performance.now() - t0;
  const update = sim.profiler.report().find((t) => t.systemId === "wator.update");
  return {
    id: `macro.seq.g${grid}`,
    value: (ticks / elapsed) * 1000,
    unit: "ticks/sec",
    p95TickMs: update?.p95Ms ?? 0,
  };
}

async function macroMessage(grid: number, workers: number, ticks: number): Promise<MetricResult> {
  const sim = await createParallelWaTorSim({ width: grid, height: grid, seed: SEED, workers });
  await sim.run(WARMUP_TICKS);
  const durations: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < ticks; i += 1) {
    const s = performance.now();
    await sim.run(1);
    durations.push(performance.now() - s);
  }
  const elapsed = performance.now() - t0;
  await sim.shutdown();
  return {
    id: `macro.msg.g${grid}.w${workers}`,
    value: (ticks / elapsed) * 1000,
    unit: "ticks/sec",
    p95TickMs: quantile(durations, 0.95),
  };
}

async function macroSab(grid: number, workers: number, ticks: number): Promise<MetricResult> {
  const sim = await createSharedWaTorSim({
    width: grid,
    height: grid,
    seed: SEED,
    workers,
    batchTicks: Math.max(50, Math.min(ticks, 250)),
    profileTicks: true,
  });
  await sim.run(WARMUP_TICKS);
  const skip = sim.tickTimingsMs().length;
  const t0 = performance.now();
  await sim.run(ticks);
  const elapsed = performance.now() - t0;
  const timings = sim.tickTimingsMs().slice(skip);
  await sim.shutdown();
  return {
    id: `macro.sab.g${grid}.w${workers}`,
    value: (ticks / elapsed) * 1000,
    unit: "ticks/sec",
    // Compute time only (barrier wait excluded), max across workers per tick.
    p95TickMs: quantile(timings, 0.95),
  };
}

export async function runMacro(full: boolean): Promise<MetricResult[]> {
  const results: MetricResult[] = [];
  // Quick set — what CI re-measures.
  results.push(await macroSequential(255, 300));
  results.push(await macroMessage(255, 4, 200));
  results.push(await macroSab(255, 4, 600));
  if (!full) {
    return results;
  }
  for (const [grid, ticks] of [
    [1020, 60],
    [2040, 20],
  ] as const) {
    results.push(await macroSequential(grid, ticks));
    for (const workers of [1, 2, 4, 8]) {
      results.push(await macroMessage(grid, workers, ticks));
      results.push(await macroSab(grid, workers, Math.max(ticks, 40)));
    }
  }
  return results;
}

export async function runAll(full: boolean): Promise<MetricResult[]> {
  return [...(await runMicro()), ...(await runMacro(full))];
}
