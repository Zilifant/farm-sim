// Benchmark metric definitions. Micro (tinybench): RNG, hash, buffer, and
// snapshot-codec primitives. Macro (custom harness): simulated days/sec for
// the farm — a quiet year (no commands) and a worked year (a full
// plant/fertilize/harvest program), plus a decade run under --full. The
// quick set is what CI re-measures.

import { Bench } from "tinybench";
import {
  Sfc32Stream, decodeSnapshot, encodeSnapshot, fnv1a32, hashBuffers, hashCell,
} from "@sim/runtime";
import {
  CORN, OP_FERTILIZE, OP_HARVEST, OP_PLANT, SOYBEANS, WHEAT,
  createFarmSim, type FarmSim,
} from "../index.js";

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
  const mib = new Uint8Array(1 << 20);
  const mibDst = new Uint8Array(1 << 20);
  let cell = 0;

  const snapshotSim = await createFarmSim({ seed: SEED });
  snapshotSim.run(200);
  const farmState = snapshotSim.captureSnapshot();
  const farmViews = Object.values(farmState.buffers).map((b) => b.data);
  const encoded = encodeSnapshot(farmState);

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
  bench.add("micro.hash.farm-state", () => {
    hashBuffers(farmViews);
  });
  bench.add("micro.buffer.copy-1MiB", () => {
    mibDst.set(mib);
  });
  bench.add("micro.snapshot.encode", () => {
    encodeSnapshot(farmState);
  });
  bench.add("micro.snapshot.decode", () => {
    decodeSnapshot(encoded);
  });

  await bench.run();
  return bench.tasks.map((task) => {
    const result = task.result;
    const mean = result !== undefined && "throughput" in result ? result.throughput.mean : 0;
    return { id: task.name, value: mean, unit: "ops/sec" as const };
  });
}

function measure(sim: FarmSim, id: string, ticks: number): MetricResult {
  sim.run(WARMUP_TICKS);
  const t0 = performance.now();
  sim.run(ticks);
  const elapsed = performance.now() - t0;
  const ops = sim.profiler.report().find((t) => t.systemId === "farm.operations");
  return {
    id,
    value: (ticks / elapsed) * 1000,
    unit: "ticks/sec",
    p95TickMs: ops?.p95Ms ?? 0,
  };
}

/** A quiet farm: the systems tick with an empty work queue. */
async function macroQuietYear(): Promise<MetricResult> {
  const sim = await createFarmSim({ seed: SEED });
  return measure(sim, "macro.farm.quiet-year", 365);
}

/** A worked farm: a full six-field program keeps the operations system busy. */
async function macroWorkedYear(): Promise<MetricResult> {
  const sim = await createFarmSim({ seed: SEED });
  const plan: Array<[number, number]> = [
    [0, CORN], [1, SOYBEANS], [3, CORN], [4, WHEAT], [6, SOYBEANS], [7, CORN],
  ];
  for (const [field, crop] of plan) {
    sim.apply({ kind: "farm.op.schedule", op: OP_PLANT, field, crop });
    sim.apply({ kind: "farm.op.schedule", op: OP_FERTILIZE, field, crop: 0 });
  }
  sim.run(200 - WARMUP_TICKS); // measure() warms the first 30 of these
  for (const [field] of plan) {
    sim.apply({ kind: "farm.op.schedule", op: OP_HARVEST, field, crop: 0 });
  }
  return measure(sim, "macro.farm.worked-year", 165);
}

async function macroDecade(): Promise<MetricResult> {
  const sim = await createFarmSim({ seed: SEED });
  return measure(sim, "macro.farm.decade", 3650);
}

export async function runMacro(full: boolean): Promise<MetricResult[]> {
  const results: MetricResult[] = [];
  // Quick set — what CI re-measures.
  results.push(await macroQuietYear());
  results.push(await macroWorkedYear());
  if (!full) {
    return results;
  }
  results.push(await macroDecade());
  return results;
}

export async function runAll(full: boolean): Promise<MetricResult[]> {
  return [...(await runMicro()), ...(await runMacro(full))];
}
