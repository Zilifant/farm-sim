// Wa-Tor predator-prey rules on a toroidal grid. All domain logic lives
// here, outside @sim/runtime. State is SoA typed arrays; every random choice
// draws from a seeded stream, so a (seed, config) pair fully determines the
// run.

import {
  bufferId,
  type BufferId,
  type EventQueue,
  type RngStream,
  type System,
  type SystemContext,
} from "@sim/runtime";

export const EMPTY = 0;
export const FISH = 1;
export const SHARK = 2;

export const SPECIES: BufferId = bufferId("wator.species");
export const ENERGY: BufferId = bufferId("wator.energy");
export const BREED_AGE: BufferId = bufferId("wator.breedAge");
export const MOVED: BufferId = bufferId("wator.moved");

export interface WaTorConfig {
  readonly width: number;
  readonly height: number;
  /** Ticks a fish must survive before it reproduces on its next move. */
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
  width: 64,
  height: 64,
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

export function resolveConfig(partial: Partial<WaTorConfig>): WaTorConfig {
  const cfg = { ...DEFAULT_CONFIG, ...partial };
  if (!Number.isInteger(cfg.width) || cfg.width < 2) {
    throw new Error("width must be an integer >= 2");
  }
  if (!Number.isInteger(cfg.height) || cfg.height < 2) {
    throw new Error("height must be an integer >= 2");
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

const COUNTER_MAX = 32767; // Int16 ceiling for ages/energy

/**
 * Full-grid update, one pass in row-major order. Cells that receive an
 * entity this tick are flagged in MOVED so a creature never acts twice when
 * it moves ahead of the scan.
 */
export class WaTorSystem implements System {
  readonly id = "wator.update";
  readonly everyNTicks = 1;
  readonly reads: readonly BufferId[] = [SPECIES, ENERGY, BREED_AGE, MOVED];
  readonly writes: readonly BufferId[] = [SPECIES, ENERGY, BREED_AGE, MOVED];

  readonly #cfg: WaTorConfig;
  readonly #neighbors = new Int32Array(4);
  readonly #candidates = new Int32Array(4);
  #species!: Uint8Array;
  #energy!: Int16Array;
  #breedAge!: Int16Array;
  #moved!: Uint8Array;
  #rng!: RngStream;

  constructor(cfg: WaTorConfig) {
    this.#cfg = cfg;
  }

  init(ctx: SystemContext): void {
    this.#species = ctx.buffer<Uint8Array>(SPECIES);
    this.#energy = ctx.buffer<Int16Array>(ENERGY);
    this.#breedAge = ctx.buffer<Int16Array>(BREED_AGE);
    this.#moved = ctx.buffer<Uint8Array>(MOVED);
    this.#rng = ctx.rng.fork("step");
    this.#seedGrid(ctx.rng.fork("seed"));
  }

  #seedGrid(rng: RngStream): void {
    const { fishDensity, sharkDensity, fishBreedAge, sharkBreedAge, sharkInitialEnergy } = this.#cfg;
    for (let i = 0; i < this.#species.length; i += 1) {
      const r = rng.nextF64();
      if (r < sharkDensity) {
        this.#species[i] = SHARK;
        this.#energy[i] = sharkInitialEnergy;
        this.#breedAge[i] = rng.nextU32() % sharkBreedAge;
      } else if (r < sharkDensity + fishDensity) {
        this.#species[i] = FISH;
        this.#energy[i] = 0;
        this.#breedAge[i] = rng.nextU32() % fishBreedAge;
      } else {
        this.#species[i] = EMPTY;
        this.#energy[i] = 0;
        this.#breedAge[i] = 0;
      }
    }
  }

  update(_ctx: SystemContext): void {
    const species = this.#species;
    const moved = this.#moved;
    moved.fill(0);
    for (let idx = 0; idx < species.length; idx += 1) {
      if (moved[idx]! !== 0) {
        continue;
      }
      const s = species[idx]!;
      if (s === FISH) {
        this.#fishStep(idx);
      } else if (s === SHARK) {
        this.#sharkStep(idx);
      }
    }
  }

  /** Toroidal von Neumann neighborhood in fixed N/E/S/W order. */
  #fillNeighbors(idx: number): void {
    const { width: w, height: h } = this.#cfg;
    const x = idx % w;
    const y = (idx - x) / w;
    const out = this.#neighbors;
    out[0] = x + ((y + h - 1) % h) * w;
    out[1] = ((x + 1) % w) + y * w;
    out[2] = x + ((y + 1) % h) * w;
    out[3] = ((x + w - 1) % w) + y * w;
  }

  #pickNeighbor(target: number): number {
    const candidates = this.#candidates;
    let count = 0;
    for (let n = 0; n < 4; n += 1) {
      const nIdx = this.#neighbors[n]!;
      if (this.#species[nIdx]! === target) {
        candidates[count] = nIdx;
        count += 1;
      }
    }
    if (count === 0) {
      return -1;
    }
    return candidates[this.#rng.nextU32() % count]!;
  }

  #fishStep(idx: number): void {
    this.#fillNeighbors(idx);
    const target = this.#pickNeighbor(EMPTY);
    const age = Math.min(this.#breedAge[idx]! + 1, COUNTER_MAX);
    if (target < 0) {
      this.#breedAge[idx] = age;
      return;
    }
    this.#moved[target] = 1;
    this.#species[target] = FISH;
    if (age >= this.#cfg.fishBreedAge) {
      // Offspring stays behind; both counters restart.
      this.#breedAge[target] = 0;
      this.#species[idx] = FISH;
      this.#breedAge[idx] = 0;
    } else {
      this.#breedAge[target] = age;
      this.#species[idx] = EMPTY;
      this.#breedAge[idx] = 0;
    }
  }

  #sharkStep(idx: number): void {
    const energyAfterMove = this.#energy[idx]! - 1;
    if (energyAfterMove <= 0) {
      this.#species[idx] = EMPTY;
      this.#energy[idx] = 0;
      this.#breedAge[idx] = 0;
      return;
    }
    this.#fillNeighbors(idx);
    let energy = energyAfterMove;
    let target = this.#pickNeighbor(FISH);
    if (target >= 0) {
      energy = Math.min(energy + this.#cfg.sharkEnergyPerFish, this.#cfg.sharkMaxEnergy);
    } else {
      target = this.#pickNeighbor(EMPTY);
    }
    const age = Math.min(this.#breedAge[idx]! + 1, COUNTER_MAX);
    if (target < 0) {
      this.#energy[idx] = energy;
      this.#breedAge[idx] = age;
      return;
    }
    this.#moved[target] = 1;
    this.#species[target] = SHARK;
    this.#energy[target] = energy;
    if (age >= this.#cfg.sharkBreedAge) {
      this.#breedAge[target] = 0;
      this.#species[idx] = SHARK;
      this.#energy[idx] = this.#cfg.sharkInitialEnergy;
      this.#breedAge[idx] = 0;
    } else {
      this.#breedAge[target] = age;
      this.#species[idx] = EMPTY;
      this.#energy[idx] = 0;
      this.#breedAge[idx] = 0;
    }
  }
}

export interface CensusEvent {
  readonly tick: bigint;
  readonly fish: number;
  readonly sharks: number;
}

/** Coarse sanity metric: population counts, emitted every N ticks. */
export class CensusSystem implements System {
  readonly id = "wator.census";
  readonly everyNTicks: number;
  readonly reads: readonly BufferId[] = [SPECIES];
  readonly writes: readonly BufferId[] = [];

  readonly #queue: EventQueue<CensusEvent>;
  #species!: Uint8Array;

  constructor(everyNTicks: number, queue: EventQueue<CensusEvent>) {
    this.everyNTicks = everyNTicks;
    this.#queue = queue;
  }

  init(ctx: SystemContext): void {
    this.#species = ctx.buffer<Uint8Array>(SPECIES);
  }

  update(ctx: SystemContext): void {
    let fish = 0;
    let sharks = 0;
    for (let i = 0; i < this.#species.length; i += 1) {
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
