// @sim/refsim — Wa-Tor predator-prey reference simulation.

import {
  BufferRegistry,
  RingProfiler,
  Sfc32Stream,
  SimEventQueue,
  SystemScheduler,
  TickExecutor,
  hashBuffers,
  type ReplayLog,
  type Snapshot,
} from "@sim/runtime";
import { WATOR_SPAWN, makeSpawnCommand, type SpawnOptions, type WaTorSpawnCommand } from "./commands.js";
import { makeWaTorSnapshot, prepareWaTorRestore } from "./snapshot.js";
import {
  BREED_AGE,
  CensusSystem,
  ENERGY,
  FISH,
  SHARK,
  SPECIES,
  WaTorSystem,
  resolveConfig,
  type CensusEvent,
  type WaTorConfig,
} from "./wator.js";

export * from "./wator.js";
export * from "./region.js";
export * from "./rules.js";
export * from "./commands.js";
export * from "./snapshot.js";
export * from "./replay.js";
export * from "./wator-worker.js";
export * from "./parallel.js";
export * from "./wator-shared.js";
export * from "./wator-shared-worker.js";
export * from "./parallel-shared.js";

export const REFSIM_NAME = "@sim/refsim";
export const FIXED_DT_MS = 1000 / 60;

export interface Populations {
  readonly fish: number;
  readonly sharks: number;
}

export interface WaTorSimOptions {
  /** Externally injected commands (spawn) are recorded here for replay. */
  readonly record?: ReplayLog;
}

export interface WaTorSim {
  readonly config: WaTorConfig;
  /** Completed ticks. */
  readonly tick: bigint;
  readonly census: SimEventQueue<CensusEvent>;
  readonly profiler: RingProfiler;
  step(): void;
  run(ticks: number): void;
  /** FNV-1a over the owned rows of species/energy/breedAge (ghost rows
   * excluded) — directly comparable with the parallel sims. */
  stateHash(): number;
  populations(): Populations;
  /** Place (or clear) a creature at a cell before the next tick. Accepts
   * SpawnOptions or an already-built command (replay). Recorded if a
   * ReplayLog was supplied. */
  spawn(cmd: SpawnOptions | WaTorSpawnCommand): void;
  /** Barrier-consistent capture: sim is always at a tick boundary here. */
  captureSnapshot(): Snapshot;
  /** Migrates the snapshot if needed, validates config, overwrites state. */
  restoreSnapshot(s: Snapshot): void;
}

export async function createWaTorSim(
  config: Partial<WaTorConfig> = {},
  opts: WaTorSimOptions = {},
): Promise<WaTorSim> {
  const cfg = resolveConfig(config);
  // Ghost-inclusive storage: rows 0 and height+1 mirror the torus wrap.
  const cells = cfg.width * (cfg.height + 2);

  const buffers = new BufferRegistry();
  buffers.define(SPECIES, { type: Uint8Array, length: cells });
  buffers.define(ENERGY, { type: Int16Array, length: cells });
  buffers.define(BREED_AGE, { type: Int16Array, length: cells });

  const census = new SimEventQueue<CensusEvent>();
  const scheduler = new SystemScheduler(buffers);
  const watorSystem = new WaTorSystem(cfg);
  scheduler.register(watorSystem, { workerGroup: "main" });
  scheduler.register(new CensusSystem(cfg, census), { workerGroup: "main" });

  const profiler = new RingProfiler();
  const executor = new TickExecutor({
    plan: scheduler.plan(),
    buffers,
    rng: Sfc32Stream.create(cfg.seed, "wator"),
    fixedDtMs: FIXED_DT_MS,
    profiler,
  });
  await executor.init();

  let tick = 0n;
  const w = cfg.width;
  const ownedStart = w;
  const ownedEnd = (cfg.height + 1) * w;
  const owned = {
    species: buffers.get<Uint8Array>(SPECIES).subarray(ownedStart, ownedEnd),
    energy: buffers.get<Int16Array>(ENERGY).subarray(ownedStart, ownedEnd),
    breedAge: buffers.get<Int16Array>(BREED_AGE).subarray(ownedStart, ownedEnd),
  };

  return {
    config: cfg,
    get tick(): bigint {
      return tick;
    },
    census,
    profiler,
    step(): void {
      executor.runTick(tick);
      tick += 1n;
    },
    run(ticks: number): void {
      if (!Number.isInteger(ticks) || ticks < 0) {
        throw new Error("ticks must be an integer >= 0");
      }
      for (let i = 0; i < ticks; i += 1) {
        executor.runTick(tick);
        tick += 1n;
      }
    },
    stateHash(): number {
      return hashBuffers([owned.species, owned.energy, owned.breedAge]);
    },
    populations(): Populations {
      let fish = 0;
      let sharks = 0;
      for (let i = 0; i < owned.species.length; i += 1) {
        const s = owned.species[i]!;
        if (s === FISH) {
          fish += 1;
        } else if (s === SHARK) {
          sharks += 1;
        }
      }
      return { fish, sharks };
    },
    spawn(cmd: SpawnOptions | WaTorSpawnCommand): void {
      const spawn = "kind" in cmd && cmd.kind === WATOR_SPAWN ? cmd : makeSpawnCommand(cfg, cmd);
      const idx = spawn.y * w + spawn.x;
      owned.species[idx] = spawn.species;
      owned.energy[idx] = spawn.energy;
      owned.breedAge[idx] = spawn.breedAge;
      watorSystem.syncGhosts();
      opts.record?.record(tick, { tick, commands: [spawn] });
    },
    captureSnapshot(): Snapshot {
      return makeWaTorSnapshot(cfg, tick, owned);
    },
    restoreSnapshot(s: Snapshot): void {
      const { tick: restoredTick, state } = prepareWaTorRestore(cfg, s);
      owned.species.set(state.species);
      owned.energy.set(state.energy);
      owned.breedAge.set(state.breedAge);
      watorSystem.syncGhosts();
      tick = restoredTick;
    },
  };
}
