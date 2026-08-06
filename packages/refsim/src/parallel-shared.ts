// Main-thread driver for the SAB path. State lives in SharedArrayBuffers
// built once by SharedMemoryLayout; workers own exclusive row ranges
// (RowRegionMap) and coordinate ticks among themselves with an Atomics
// barrier, so main only exchanges one message per worker per *batch* of
// ticks. Main never touches Atomics.wait — awaiting the batch replies is its
// barrier — and it reads state directly from the SABs while workers sit
// idle between batches.

import {
  AtomicsBarrier,
  DefaultWorkerPool,
  NodeWorkerAdapter,
  RowRegionMap,
  SharedMemoryLayout,
  hashBuffers,
  type ReplayLog,
  type Snapshot,
  type WorkerAdapter,
} from "@sim/runtime";
import { WATOR_SPAWN, makeSpawnCommand, type SpawnOptions, type WaTorSpawnCommand } from "./commands.js";
import { partitionRows } from "./parallel.js";
import { FISH, SHARK } from "./rules.js";
import { makeWaTorSnapshot, prepareWaTorRestore } from "./snapshot.js";
import { BREED_AGE, ENERGY, SPECIES, resolveConfig, type WaTorConfig } from "./wator.js";
import { CMD_SAB_RUN, type SabRunCommand, type WaTorSharedBoot } from "./wator-shared-worker.js";

export interface SharedWaTorOptions extends Partial<WaTorConfig> {
  readonly workers: number;
  readonly adapter?: WorkerAdapter;
  /** Enforce per-worker write ranges on every cell write (slow). */
  readonly debug?: boolean;
  /** Ticks per exchange round trip (default 256). */
  readonly batchTicks?: number;
  readonly barrierTimeoutMs?: number;
  /** Externally injected commands (spawn) are recorded here for replay. */
  readonly record?: ReplayLog;
}

export interface SharedWaTorSim {
  readonly config: WaTorConfig;
  readonly workers: number;
  readonly tick: bigint;
  readonly regionMap: RowRegionMap;
  run(ticks: number): Promise<void>;
  /** Read directly from the SABs (workers are idle between batches) — same
   * buffer order as the sequential and message-passing sims. */
  stateHash(): number;
  populations(): { fish: number; sharks: number };
  snapshot(): { species: Uint8Array; energy: Int16Array; breedAge: Int16Array };
  /** Place (or clear) a creature before the next tick — only between run()
   * calls, while workers are idle. Recorded if a ReplayLog was supplied. */
  spawn(cmd: SpawnOptions | WaTorSpawnCommand): void;
  /** Barrier-consistent capture: workers are idle between batches. */
  captureSnapshot(): Snapshot;
  /** Migrates if needed, validates config, overwrites the SABs directly. */
  restoreSnapshot(s: Snapshot): void;
  stats(): { ticks: number; batches: number; perWorker: { mainPosts: number; workerPosts: number }[] };
  shutdown(): Promise<number[]>;
}

export async function createSharedWaTorSim(opts: SharedWaTorOptions): Promise<SharedWaTorSim> {
  const { workers, adapter, debug = false, batchTicks = 256, barrierTimeoutMs, record, ...partial } = opts;
  const cfg = resolveConfig(partial);
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error("workers must be an integer >= 1");
  }
  if (!Number.isInteger(batchTicks) || batchTicks < 1) {
    throw new Error("batchTicks must be an integer >= 1");
  }
  const strips = partitionRows(cfg.height, workers);
  const regionMap = new RowRegionMap({ width: cfg.width, height: cfg.height, strips });
  const cells = cfg.width * cfg.height;

  const layout = new SharedMemoryLayout();
  layout.defineShared(SPECIES, { type: Uint8Array, length: cells });
  layout.defineShared(ENERGY, { type: Int16Array, length: cells });
  layout.defineShared(BREED_AGE, { type: Int16Array, length: cells });
  const handles = layout.build();
  const species = handles.view<Uint8Array>(SPECIES);
  const energy = handles.view<Int16Array>(ENERGY);
  const breedAge = handles.view<Int16Array>(BREED_AGE);

  const barrier = AtomicsBarrier.allocate(workers, barrierTimeoutMs);
  const pool = new DefaultWorkerPool({
    adapter: adapter ?? new NodeWorkerAdapter(),
    entry: new URL("./wator-shared-worker-entry.js", import.meta.url),
    size: workers,
    boot: (i): WaTorSharedBoot => ({
      cfg,
      workerIndex: i,
      strips,
      manifest: handles.manifest(),
      barrierSab: barrier.sab,
      parties: workers,
      debug,
      ...(barrierTimeoutMs !== undefined ? { barrierTimeoutMs } : {}),
    }),
  });
  await pool.spawnAll();
  // Seeding happens synchronously in each worker's boot; this round trip
  // guarantees all rows are seeded before the first tick reads any of them.
  await pool.barrier();

  let tick = 0n;
  let ticksRun = 0;
  let batches = 0;

  return {
    config: cfg,
    workers,
    regionMap,
    get tick(): bigint {
      return tick;
    },
    async run(ticks: number): Promise<void> {
      if (!Number.isInteger(ticks) || ticks < 0) {
        throw new Error("ticks must be an integer >= 0");
      }
      let remaining = ticks;
      while (remaining > 0) {
        const count = Math.min(batchTicks, remaining);
        const cmd: SabRunCommand = { kind: CMD_SAB_RUN, startTick: tick, count };
        await pool.exchange(() => ({ batch: { tick, commands: [cmd] } }));
        tick += BigInt(count);
        ticksRun += count;
        batches += 1;
        remaining -= count;
      }
    },
    stateHash(): number {
      return hashBuffers([species, energy, breedAge]);
    },
    populations(): { fish: number; sharks: number } {
      let fish = 0;
      let sharks = 0;
      for (let i = 0; i < species.length; i += 1) {
        const s = species[i]!;
        if (s === FISH) {
          fish += 1;
        } else if (s === SHARK) {
          sharks += 1;
        }
      }
      return { fish, sharks };
    },
    snapshot(): { species: Uint8Array; energy: Int16Array; breedAge: Int16Array } {
      return {
        species: species.slice(),
        energy: energy.slice(),
        breedAge: breedAge.slice(),
      };
    },
    spawn(cmd: SpawnOptions | WaTorSpawnCommand): void {
      const spawn = "kind" in cmd && cmd.kind === WATOR_SPAWN ? cmd : makeSpawnCommand(cfg, cmd);
      const idx = spawn.y * cfg.width + spawn.x;
      species[idx] = spawn.species;
      energy[idx] = spawn.energy;
      breedAge[idx] = spawn.breedAge;
      record?.record(tick, { tick, commands: [spawn] });
    },
    captureSnapshot(): Snapshot {
      return makeWaTorSnapshot(cfg, tick, { species, energy, breedAge });
    },
    restoreSnapshot(s: Snapshot): void {
      const { tick: restoredTick, state } = prepareWaTorRestore(cfg, s);
      species.set(state.species);
      energy.set(state.energy);
      breedAge.set(state.breedAge);
      tick = restoredTick;
    },
    stats(): { ticks: number; batches: number; perWorker: { mainPosts: number; workerPosts: number }[] } {
      return {
        ticks: ticksRun,
        batches,
        perWorker: pool.handles.map((h) => ({
          mainPosts: h.postCount,
          workerPosts: h.lastWorkerStats?.posts ?? 0,
        })),
      };
    },
    shutdown(): Promise<number[]> {
      return pool.shutdown({ graceful: true, timeoutMs: 5000 });
    },
  };
}
