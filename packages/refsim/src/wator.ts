// Wa-Tor predator-prey on a toroidal grid. Domain logic lives here, outside
// @sim/runtime. The update rule and all randomness are partition-invariant
// (see region.ts) — the single-threaded system below is literally the
// one-region case of the same code the workers run.

import {
  bufferId,
  type BufferId,
  type EventQueue,
  type System,
  type SystemContext,
} from "@sim/runtime";
import { FISH, SHARK, WaTorRegion } from "./region.js";

export { EMPTY, FISH, SHARK } from "./region.js";

export const SPECIES: BufferId = bufferId("wator.species");
export const ENERGY: BufferId = bufferId("wator.energy");
export const BREED_AGE: BufferId = bufferId("wator.breedAge");

export interface WaTorConfig {
  readonly width: number;
  readonly height: number;
  /** Activations a fish must survive before it reproduces on its next move. */
  readonly fishBreedAge: number;
  readonly sharkBreedAge: number;
  readonly sharkInitialEnergy: number;
  readonly sharkEnergyPerFish: number;
  /** Energy ceiling — sharks cannot stockpile past this, which keeps famine
   * lethal and the predator-prey oscillation bounded (classic Wa-Tor resets
   * the starvation clock on eating rather than banking energy). */
  readonly sharkMaxEnergy: number;
  /** Initial cell probabilities; must sum to <= 1. */
  readonly fishDensity: number;
  readonly sharkDensity: number;
  readonly seed: number | string;
  readonly censusEveryNTicks: number;
}

export const DEFAULT_CONFIG: WaTorConfig = {
  width: 60,
  height: 60,
  fishBreedAge: 3,
  sharkBreedAge: 10,
  sharkInitialEnergy: 3,
  sharkEnergyPerFish: 3,
  sharkMaxEnergy: 3,
  fishDensity: 0.3,
  sharkDensity: 0.05,
  seed: "wa-tor",
  censusEveryNTicks: 10,
};

const COUNTER_MAX = 32767;

export function resolveConfig(partial: Partial<WaTorConfig>): WaTorConfig {
  const cfg = { ...DEFAULT_CONFIG, ...partial };
  if (!Number.isInteger(cfg.width) || cfg.width < 5 || cfg.width % 5 !== 0) {
    throw new Error("width must be a positive multiple of 5 (the 5-phase cell coloring must be consistent across the torus wrap)");
  }
  if (!Number.isInteger(cfg.height) || cfg.height < 5 || cfg.height % 5 !== 0) {
    throw new Error("height must be a positive multiple of 5 (the 5-phase cell coloring must be consistent across the torus wrap)");
  }
  if (cfg.fishDensity < 0 || cfg.sharkDensity < 0 || cfg.fishDensity + cfg.sharkDensity > 1) {
    throw new Error("fishDensity + sharkDensity must be within [0, 1]");
  }
  for (const key of ["fishBreedAge", "sharkBreedAge", "sharkInitialEnergy", "sharkEnergyPerFish", "sharkMaxEnergy", "censusEveryNTicks"] as const) {
    if (!Number.isInteger(cfg[key]) || cfg[key] < 1) {
      throw new Error(`${key} must be an integer >= 1`);
    }
  }
  if (cfg.sharkMaxEnergy < cfg.sharkInitialEnergy) {
    throw new Error("sharkMaxEnergy must be >= sharkInitialEnergy");
  }
  if (cfg.sharkMaxEnergy > COUNTER_MAX) {
    throw new Error(`sharkMaxEnergy must be <= ${COUNTER_MAX}`);
  }
  return cfg;
}

/** Single-threaded Wa-Tor: one region spanning the whole grid. Buffers are
 * ghost-inclusive ((height+2) rows); owned state lives in rows 1..height. */
export class WaTorSystem implements System {
  readonly id = "wator.update";
  readonly everyNTicks = 1;
  readonly reads: readonly BufferId[] = [SPECIES, ENERGY, BREED_AGE];
  readonly writes: readonly BufferId[] = [SPECIES, ENERGY, BREED_AGE];

  readonly #cfg: WaTorConfig;
  #region!: WaTorRegion;

  constructor(cfg: WaTorConfig) {
    this.#cfg = cfg;
  }

  init(ctx: SystemContext): void {
    this.#region = new WaTorRegion(this.#cfg, 0, this.#cfg.height, {
      species: ctx.buffer<Uint8Array>(SPECIES),
      energy: ctx.buffer<Int16Array>(ENERGY),
      breedAge: ctx.buffer<Int16Array>(BREED_AGE),
    });
    this.#region.seed();
  }

  update(ctx: SystemContext): void {
    this.#region.runTick(ctx.tick);
    this.#region.applySelfBorders();
  }

  /** Re-mirror edge rows into the ghost rows after out-of-band state writes
   * (snapshot restore, spawn commands). Only valid at a tick boundary, where
   * the migration logs are empty. */
  syncGhosts(): void {
    this.#region.applySelfBorders();
  }
}

export interface CensusEvent {
  readonly tick: bigint;
  readonly fish: number;
  readonly sharks: number;
}

/** Coarse sanity metric: population counts over the owned rows, emitted
 * every N ticks. */
export class CensusSystem implements System {
  readonly id = "wator.census";
  readonly everyNTicks: number;
  readonly reads: readonly BufferId[] = [SPECIES];
  readonly writes: readonly BufferId[] = [];

  readonly #cfg: WaTorConfig;
  readonly #queue: EventQueue<CensusEvent>;
  #species!: Uint8Array;

  constructor(cfg: WaTorConfig, queue: EventQueue<CensusEvent>) {
    this.everyNTicks = cfg.censusEveryNTicks;
    this.#cfg = cfg;
    this.#queue = queue;
  }

  init(ctx: SystemContext): void {
    this.#species = ctx.buffer<Uint8Array>(SPECIES);
  }

  update(ctx: SystemContext): void {
    const w = this.#cfg.width;
    const end = (this.#cfg.height + 1) * w;
    let fish = 0;
    let sharks = 0;
    for (let i = w; i < end; i += 1) {
      const s = this.#species[i]!;
      if (s === FISH) {
        fish += 1;
      } else if (s === SHARK) {
        sharks += 1;
      }
    }
    this.#queue.emit({ tick: ctx.tick, fish, sharks });
  }
}
