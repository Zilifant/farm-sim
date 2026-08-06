// @sim/refsim — Wa-Tor predator-prey reference simulation.

import {
  BufferRegistry,
  RingProfiler,
  Sfc32Stream,
  SimEventQueue,
  SystemScheduler,
  TickExecutor,
  hashBuffers,
} from "@sim/runtime";
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

export interface WaTorSim {
  readonly config: WaTorConfig;
  /** Completed ticks. */
  readonly tick: bigint;
  readonly census: SimEventQueue<CensusEvent>;
  readonly profiler: RingProfiler;
  step(): void;
  run(ticks: number): void;
  /** FNV-1a over the owned rows of species/energy/breedAge (ghost rows
   * excluded) — directly comparable with ParallelWaTorSim.stateHash(). */
  stateHash(): number;
  populations(): Populations;
}

export async function createWaTorSim(
  config: Partial<WaTorConfig> = {},
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
  scheduler.register(new WaTorSystem(cfg), { workerGroup: "main" });
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
  const ownedStart = cfg.width;
  const ownedEnd = (cfg.height + 1) * cfg.width;
  const ownedViews = [
    buffers.get(SPECIES).subarray(ownedStart, ownedEnd),
    buffers.get(ENERGY).subarray(ownedStart, ownedEnd),
    buffers.get(BREED_AGE).subarray(ownedStart, ownedEnd),
  ];

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
      return hashBuffers(ownedViews);
    },
    populations(): Populations {
      const species = buffers.get<Uint8Array>(SPECIES);
      let fish = 0;
      let sharks = 0;
      for (let i = ownedStart; i < ownedEnd; i += 1) {
        const s = species[i]!;
        if (s === FISH) {
          fish += 1;
        } else if (s === SHARK) {
          sharks += 1;
        }
      }
      return { fish, sharks };
    },
  };
}
