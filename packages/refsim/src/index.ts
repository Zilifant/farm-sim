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
  MOVED,
  SPECIES,
  WaTorSystem,
  resolveConfig,
  type CensusEvent,
  type WaTorConfig,
} from "./wator.js";

export * from "./wator.js";

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
  /** FNV-1a over species/energy/breedAge buffers. */
  stateHash(): number;
  populations(): Populations;
}

export async function createWaTorSim(
  config: Partial<WaTorConfig> = {},
): Promise<WaTorSim> {
  const cfg = resolveConfig(config);
  const cells = cfg.width * cfg.height;

  const buffers = new BufferRegistry();
  buffers.define(SPECIES, { type: Uint8Array, length: cells });
  buffers.define(ENERGY, { type: Int16Array, length: cells });
  buffers.define(BREED_AGE, { type: Int16Array, length: cells });
  buffers.define(MOVED, { type: Uint8Array, length: cells });

  const census = new SimEventQueue<CensusEvent>();
  const scheduler = new SystemScheduler(buffers);
  scheduler.register(new WaTorSystem(cfg), { workerGroup: "main" });
  scheduler.register(new CensusSystem(cfg.censusEveryNTicks, census), {
    workerGroup: "main",
  });

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
  const stateViews = [
    buffers.get(SPECIES),
    buffers.get(ENERGY),
    buffers.get(BREED_AGE),
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
      return hashBuffers(stateViews);
    },
    populations(): Populations {
      const species = buffers.get<Uint8Array>(SPECIES);
      let fish = 0;
      let sharks = 0;
      for (let i = 0; i < species.length; i += 1) {
        const s = species[i]!;
        if (s === 1) {
          fish += 1;
        } else if (s === 2) {
          sharks += 1;
        }
      }
      return { fish, sharks };
    },
  };
}
