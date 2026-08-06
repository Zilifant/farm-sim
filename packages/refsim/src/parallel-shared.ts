// Main-thread driver for the SAB path. State lives in SharedArrayBuffers
// built once by SharedMemoryLayout; workers own exclusive row ranges
// (RowRegionMap) and coordinate ticks among themselves with an Atomics
// barrier, so main only exchanges one message per worker per *batch* of
// ticks. Main never touches Atomics.wait — awaiting the batch replies is its
// barrier — and it reads state directly from the SABs while workers sit
// idle between batches.
//
// Crash handling: the pool fails fast (one crash terminates all workers,
// no orphans). With `recovery` enabled the driver additionally keeps
// periodic snapshots and, on a crash, respawns a fresh pool with a fresh
// barrier, restores the last snapshot, and deterministically re-simulates
// the lost ticks — the plan's restart-from-last-snapshot policy.

import {
  AtomicsBarrier,
  DefaultWorkerPool,
  NodeWorkerAdapter,
  POOL_CRASH,
  RowRegionMap,
  SharedMemoryLayout,
  hashBuffers,
  type PoolCrashCommand,
  type ReplayLog,
  type Snapshot,
  type WorkerAdapter,
} from "@sim/runtime";
import { WATOR_SPAWN, makeSpawnCommand, type SpawnOptions, type WaTorSpawnCommand } from "./commands.js";
import { partitionRows } from "./parallel.js";
import { FISH, SHARK } from "./rules.js";
import { makeWaTorSnapshot, prepareWaTorRestore } from "./snapshot.js";
import { BREED_AGE, ENERGY, SPECIES, resolveConfig, type WaTorConfig } from "./wator.js";
import {
  CMD_SAB_RUN,
  CMD_SAB_TIMINGS,
  type SabRunCommand,
  type SabTimingsReply,
  type WaTorSharedBoot,
} from "./wator-shared-worker.js";

export interface SharedRecoveryOptions {
  /** Capture a snapshot each time this many ticks have elapsed. */
  readonly snapshotEveryTicks: number;
  /** Crash budget before giving up and rethrowing (default 1). */
  readonly maxRestarts?: number;
  // Note: spawn commands injected after the last snapshot are not replayed
  // by recovery — re-simulation covers only the closed-system rules. Keep a
  // ReplayLog and replay it externally if commands must survive a crash.
}

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
  /** Restart-from-last-snapshot on worker crash. Without this the pool's
   * fail-fast policy stands: the first crash poisons the sim. */
  readonly recovery?: SharedRecoveryOptions;
  /** Collect per-tick compute timings from the workers (benchmarking). */
  readonly profileTicks?: boolean;
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
  /** Fault injection (tests): make a worker die abruptly with this exit
   * code. Real-thread adapters only. */
  injectCrash(workerIndex: number, code?: number): void;
  /** With profileTicks: per-tick compute durations (ms), each the max
   * across workers — the slowest worker gates the tick. */
  tickTimingsMs(): readonly number[];
  stats(): {
    ticks: number;
    batches: number;
    restarts: number;
    perWorker: { mainPosts: number; workerPosts: number }[];
  };
  shutdown(): Promise<number[]>;
}

export async function createSharedWaTorSim(opts: SharedWaTorOptions): Promise<SharedWaTorSim> {
  const {
    workers,
    adapter,
    debug = false,
    batchTicks = 256,
    barrierTimeoutMs,
    record,
    recovery,
    profileTicks = false,
    ...partial
  } = opts;
  const cfg = resolveConfig(partial);
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error("workers must be an integer >= 1");
  }
  if (!Number.isInteger(batchTicks) || batchTicks < 1) {
    throw new Error("batchTicks must be an integer >= 1");
  }
  if (recovery !== undefined && (!Number.isInteger(recovery.snapshotEveryTicks) || recovery.snapshotEveryTicks < 1)) {
    throw new Error("recovery.snapshotEveryTicks must be an integer >= 1");
  }
  const maxRestarts = recovery?.maxRestarts ?? 1;
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

  const workerAdapter = adapter ?? new NodeWorkerAdapter();
  let pool!: DefaultWorkerPool;

  async function spawnPool(): Promise<void> {
    // A fresh barrier every (re)spawn: a crash can leave the old one
    // mid-generation with a stale arrival count.
    const barrier = AtomicsBarrier.allocate(workers, barrierTimeoutMs);
    pool = new DefaultWorkerPool({
      adapter: workerAdapter,
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
  }
  await spawnPool();

  let tick = 0n;
  let ticksRun = 0;
  let batches = 0;
  let restarts = 0;
  let lastSnapshot: Snapshot | null = null;
  const tickTimings: number[] = [];

  function capture(): Snapshot {
    return makeWaTorSnapshot(cfg, tick, { species, energy, breedAge });
  }

  function restore(s: Snapshot): void {
    const { tick: restoredTick, state } = prepareWaTorRestore(cfg, s);
    species.set(state.species);
    energy.set(state.energy);
    breedAge.set(state.breedAge);
    tick = restoredTick;
  }

  if (recovery !== undefined) {
    lastSnapshot = capture(); // tick 0 baseline — a crash is always recoverable
  }
  let lastSnapshotTick = 0n;

  async function recover(cause: unknown): Promise<void> {
    if (recovery === undefined || lastSnapshot === null || restarts >= maxRestarts) {
      throw cause;
    }
    restarts += 1;
    // Fail-fast already terminated the workers; collect them so none orphan.
    await pool.shutdown({ graceful: false, timeoutMs: 2000 });
    await spawnPool(); // respawned workers re-seed; the restore overwrites it
    restore(lastSnapshot);
  }

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
      const target = tick + BigInt(ticks);
      while (tick < target) {
        const count = Math.min(batchTicks, Number(target - tick));
        const cmd: SabRunCommand = {
          kind: CMD_SAB_RUN,
          startTick: tick,
          count,
          ...(profileTicks ? { profile: true } : {}),
        };
        let replies;
        try {
          replies = await pool.exchange(() => ({ batch: { tick, commands: [cmd] } }));
        } catch (err) {
          await recover(err); // rolls tick back to the last snapshot
          continue;
        }
        if (profileTicks) {
          const perWorker = replies.map(
            (env) =>
              (env.batch?.commands.find((c) => c.kind === CMD_SAB_TIMINGS) as SabTimingsReply | undefined)
                ?.durations ?? new Float64Array(count),
          );
          for (let i = 0; i < count; i += 1) {
            let max = 0;
            for (const d of perWorker) {
              if (d[i]! > max) {
                max = d[i]!;
              }
            }
            tickTimings.push(max);
          }
        }
        tick += BigInt(count);
        ticksRun += count;
        batches += 1;
        if (recovery !== undefined && tick - lastSnapshotTick >= BigInt(recovery.snapshotEveryTicks)) {
          lastSnapshot = capture();
          lastSnapshotTick = tick;
        }
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
    captureSnapshot: capture,
    restoreSnapshot: restore,
    injectCrash(workerIndex: number, code = 1): void {
      const handle = pool.handles[workerIndex];
      if (handle === undefined) {
        throw new Error(`no worker ${workerIndex}`);
      }
      const crash: PoolCrashCommand = { kind: POOL_CRASH, code };
      handle.postBatch({ tick: null, commands: [crash] });
    },
    tickTimingsMs(): readonly number[] {
      return tickTimings;
    },
    stats(): {
      ticks: number;
      batches: number;
      restarts: number;
      perWorker: { mainPosts: number; workerPosts: number }[];
    } {
      return {
        ticks: ticksRun,
        batches,
        restarts,
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
