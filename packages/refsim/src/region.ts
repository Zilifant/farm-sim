// A horizontal strip of the Wa-Tor torus: owned rows plus one ghost row on
// each side mirroring the neighbors' edge rows.
//
// Update rule (partition-invariant by construction): cells are 5-colored by
// (x + 2y) mod 5 — a coloring in which no two same-color cells are within
// distance 2, so their read/write neighborhoods never overlap. Each tick only
// the color class (tick mod 5) acts, and every random choice is a counter
// hash of (seed, tick, global cell) — never a sequential stream. Together
// this makes the state evolution identical for any region partitioning and
// any scan order, which is what lets 1, 2, and 4 workers produce the same
// state hash. The coloring is only consistent on the torus when width and
// height are multiples of 5 (enforced by resolveConfig).
//
// Border protocol (one exchange per tick): actors in edge rows may write into
// ghost rows — recorded as migrations. After a tick, each side's payload is
// the edge row contents plus the migration log. A receiver refreshes its
// ghost row from the neighbor's edge row, re-applies its own migrations on
// top (the neighbor hadn't seen them when it captured the row), and applies
// the neighbor's migrations to its own edge row. This reconstruction is only
// complete when every strip is at least 2 rows tall (with 1-row strips a
// third worker could also write into the mirrored row), so partitions
// enforce rowCount >= 2 whenever there is more than one region.

import { hashCell, seedToU32, splitTick } from "@sim/runtime";
import type { WaTorConfig } from "./wator.js";

export const EMPTY = 0;
export const FISH = 1;
export const SHARK = 2;

const SALT_ACT = 1;
const SALT_INIT_KIND = 2;
const SALT_INIT_AGE = 3;

const COUNTER_MAX = 32767; // Int16 ceiling for ages/energy
export { COUNTER_MAX };

export interface RegionStorage {
  readonly species: Uint8Array;
  readonly energy: Int16Array;
  readonly breedAge: Int16Array;
}

/** One side's per-tick border data: the sender's edge row plus its writes
 * into the receiver's territory. All typed arrays — transferable. */
export interface BorderPayload {
  readonly species: Uint8Array;
  readonly energy: Int16Array;
  readonly breedAge: Int16Array;
  readonly migCols: Int32Array;
  readonly migSpecies: Uint8Array;
  readonly migEnergy: Int16Array;
  readonly migBreedAge: Int16Array;
}

export function borderTransfers(p: BorderPayload, out: ArrayBuffer[]): void {
  out.push(
    p.species.buffer as ArrayBuffer,
    p.energy.buffer as ArrayBuffer,
    p.breedAge.buffer as ArrayBuffer,
    p.migCols.buffer as ArrayBuffer,
    p.migSpecies.buffer as ArrayBuffer,
    p.migEnergy.buffer as ArrayBuffer,
    p.migBreedAge.buffer as ArrayBuffer,
  );
}

interface MigLog {
  cols: number[];
  species: number[];
  energy: number[];
  breedAge: number[];
}

const emptyLog = (): MigLog => ({ cols: [], species: [], energy: [], breedAge: [] });

export class WaTorRegion {
  readonly cfg: WaTorConfig;
  readonly rowStart: number;
  readonly rowCount: number;
  readonly species: Uint8Array;
  readonly energy: Int16Array;
  readonly breedAge: Int16Array;

  readonly #seedHash: number;
  #upLog: MigLog = emptyLog();
  #downLog: MigLog = emptyLog();

  constructor(
    cfg: WaTorConfig,
    rowStart: number,
    rowCount: number,
    storage?: RegionStorage,
  ) {
    const cells = (rowCount + 2) * cfg.width;
    this.cfg = cfg;
    this.rowStart = rowStart;
    this.rowCount = rowCount;
    this.species = storage?.species ?? new Uint8Array(cells);
    this.energy = storage?.energy ?? new Int16Array(cells);
    this.breedAge = storage?.breedAge ?? new Int16Array(cells);
    if (this.species.length !== cells || this.energy.length !== cells || this.breedAge.length !== cells) {
      throw new Error(`region storage must have length ${cells} (rows+2 ghost rows)`);
    }
    this.#seedHash = seedToU32(cfg.seed);
  }

  /** Seed owned and ghost rows from per-cell hashes of global coordinates —
   * every region derives the identical initial state for the rows it sees. */
  seed(): void {
    const { width: w, height: h, fishDensity, sharkDensity, fishBreedAge, sharkBreedAge, sharkInitialEnergy } = this.cfg;
    for (let r = 0; r <= this.rowCount + 1; r += 1) {
      const gy = (((this.rowStart + r - 1) % h) + h) % h;
      for (let x = 0; x < w; x += 1) {
        const gIdx = gy * w + x;
        const idx = r * w + x;
        const roll = hashCell(this.#seedHash, 0, 0, gIdx, SALT_INIT_KIND) / 4294967296;
        if (roll < sharkDensity) {
          this.species[idx] = SHARK;
          this.energy[idx] = sharkInitialEnergy;
          this.breedAge[idx] = hashCell(this.#seedHash, 0, 0, gIdx, SALT_INIT_AGE) % sharkBreedAge;
        } else if (roll < sharkDensity + fishDensity) {
          this.species[idx] = FISH;
          this.energy[idx] = 0;
          this.breedAge[idx] = hashCell(this.#seedHash, 0, 0, gIdx, SALT_INIT_AGE) % fishBreedAge;
        } else {
          this.species[idx] = EMPTY;
          this.energy[idx] = 0;
          this.breedAge[idx] = 0;
        }
      }
    }
  }

  runTick(tick: bigint): void {
    const w = this.cfg.width;
    const active = Number(tick % 5n);
    const { lo: tickLo, hi: tickHi } = splitTick(tick);
    for (let r = 1; r <= this.rowCount; r += 1) {
      const gy = this.rowStart + r - 1;
      let x0 = (active - ((2 * gy) % 5)) % 5;
      if (x0 < 0) {
        x0 += 5;
      }
      const base = r * w;
      for (let x = x0; x < w; x += 5) {
        const idx = base + x;
        const sp = this.species[idx]!;
        if (sp === EMPTY) {
          continue;
        }
        const rand = hashCell(this.#seedHash, tickLo, tickHi, gy * w + x, SALT_ACT);
        if (sp === FISH) {
          this.#fishStep(idx, x, base, rand);
        } else {
          this.#sharkStep(idx, x, base, rand);
        }
      }
    }
  }

  /** Von Neumann neighbors in fixed up/right/down/left order; toroidal in x
   * within the row, ±width across rows (ghost rows cover the y wrap). */
  #pickNeighbor(idx: number, x: number, base: number, target: number, rand: number): number {
    const w = this.cfg.width;
    const n0 = idx - w;
    const n1 = base + (x === w - 1 ? 0 : x + 1);
    const n2 = idx + w;
    const n3 = base + (x === 0 ? w - 1 : x - 1);
    let c0 = -1;
    let c1 = -1;
    let c2 = -1;
    let c3 = -1;
    let count = 0;
    if (this.species[n0]! === target) { c0 = n0; count += 1; }
    if (this.species[n1]! === target) { if (count === 0) c0 = n1; else if (count === 1) c1 = n1; count += 1; }
    if (this.species[n2]! === target) { if (count === 0) c0 = n2; else if (count === 1) c1 = n2; else c2 = n2; count += 1; }
    if (this.species[n3]! === target) { if (count === 0) c0 = n3; else if (count === 1) c1 = n3; else if (count === 2) c2 = n3; else c3 = n3; count += 1; }
    if (count === 0) {
      return -1;
    }
    const pick = rand % count;
    return pick === 0 ? c0 : pick === 1 ? c1 : pick === 2 ? c2 : c3;
  }

  /** Write a full cell; ghost-row writes are logged as outgoing migrations. */
  #writeCell(idx: number, sp: number, en: number, ba: number): void {
    this.species[idx] = sp;
    this.energy[idx] = en;
    this.breedAge[idx] = ba;
    const w = this.cfg.width;
    if (idx < w) {
      logMigration(this.#upLog, idx, sp, en, ba);
    } else if (idx >= (this.rowCount + 1) * w) {
      logMigration(this.#downLog, idx - (this.rowCount + 1) * w, sp, en, ba);
    }
  }

  #fishStep(idx: number, x: number, base: number, rand: number): void {
    const target = this.#pickNeighbor(idx, x, base, EMPTY, rand);
    const age = Math.min(this.breedAge[idx]! + 1, COUNTER_MAX);
    if (target < 0) {
      this.breedAge[idx] = age;
      return;
    }
    if (age >= this.cfg.fishBreedAge) {
      this.#writeCell(target, FISH, 0, 0);
      // Offspring stays behind; both counters restart.
      this.breedAge[idx] = 0;
    } else {
      this.#writeCell(target, FISH, 0, age);
      this.species[idx] = EMPTY;
      this.breedAge[idx] = 0;
    }
  }

  #sharkStep(idx: number, x: number, base: number, rand: number): void {
    const energy = this.energy[idx]! - 1;
    if (energy <= 0) {
      this.species[idx] = EMPTY;
      this.energy[idx] = 0;
      this.breedAge[idx] = 0;
      return;
    }
    let fed = energy;
    let target = this.#pickNeighbor(idx, x, base, FISH, rand);
    if (target >= 0) {
      fed = Math.min(energy + this.cfg.sharkEnergyPerFish, this.cfg.sharkMaxEnergy);
    } else {
      target = this.#pickNeighbor(idx, x, base, EMPTY, rand);
    }
    const age = Math.min(this.breedAge[idx]! + 1, COUNTER_MAX);
    if (target < 0) {
      this.energy[idx] = fed;
      this.breedAge[idx] = age;
      return;
    }
    if (age >= this.cfg.sharkBreedAge) {
      this.#writeCell(target, SHARK, fed, 0);
      this.species[idx] = SHARK;
      this.energy[idx] = this.cfg.sharkInitialEnergy;
      this.breedAge[idx] = 0;
    } else {
      this.#writeCell(target, SHARK, fed, age);
      this.species[idx] = EMPTY;
      this.energy[idx] = 0;
      this.breedAge[idx] = 0;
    }
  }

  /** Fresh copies for transfer: up = data the up-neighbor needs, down = data
   * the down-neighbor needs. Migration logs are retained until borders are
   * applied (they must be re-applied over the neighbor's edge row). */
  collectBorders(): { up: BorderPayload; down: BorderPayload } {
    const w = this.cfg.width;
    return {
      up: this.#payload(w, this.#upLog),
      down: this.#payload(this.rowCount * w, this.#downLog),
    };
  }

  #payload(rowOffset: number, log: MigLog): BorderPayload {
    const w = this.cfg.width;
    return {
      species: this.species.slice(rowOffset, rowOffset + w),
      energy: this.energy.slice(rowOffset, rowOffset + w),
      breedAge: this.breedAge.slice(rowOffset, rowOffset + w),
      migCols: Int32Array.from(log.cols),
      migSpecies: Uint8Array.from(log.species),
      migEnergy: Int16Array.from(log.energy),
      migBreedAge: Int16Array.from(log.breedAge),
    };
  }

  /** Apply the neighbors' post-tick border data (multi-region case). */
  applyBorders(upIn: BorderPayload, downIn: BorderPayload): void {
    const w = this.cfg.width;
    // Neighbors' migrations land in my edge rows.
    this.#applyMigrations(upIn, w);
    this.#applyMigrations(downIn, this.rowCount * w);
    // Ghost rows: neighbor's edge row, plus my own migrations the neighbor
    // hadn't seen when it captured that row.
    this.#setRow(0, upIn);
    this.#replayLog(this.#upLog, 0);
    this.#setRow(this.rowCount + 1, downIn);
    this.#replayLog(this.#downLog, (this.rowCount + 1) * w);
    this.#clearLogs();
  }

  /** Single-region case: ghost rows mirror my own opposite edge rows. */
  applySelfBorders(): void {
    const w = this.cfg.width;
    // ghostTop mirrors my bottom owned row; ghostBottom mirrors my top row.
    this.#replayLog(this.#upLog, this.rowCount * w);
    this.#replayLog(this.#downLog, w);
    this.#copyRow(this.rowCount, 0);
    this.#copyRow(1, this.rowCount + 1);
    this.#clearLogs();
  }

  #applyMigrations(p: BorderPayload, rowOffset: number): void {
    for (let i = 0; i < p.migCols.length; i += 1) {
      const idx = rowOffset + p.migCols[i]!;
      this.species[idx] = p.migSpecies[i]!;
      this.energy[idx] = p.migEnergy[i]!;
      this.breedAge[idx] = p.migBreedAge[i]!;
    }
  }

  #replayLog(log: MigLog, rowOffset: number): void {
    for (let i = 0; i < log.cols.length; i += 1) {
      const idx = rowOffset + log.cols[i]!;
      this.species[idx] = log.species[i]!;
      this.energy[idx] = log.energy[i]!;
      this.breedAge[idx] = log.breedAge[i]!;
    }
  }

  #setRow(row: number, p: BorderPayload): void {
    const w = this.cfg.width;
    this.species.set(p.species, row * w);
    this.energy.set(p.energy, row * w);
    this.breedAge.set(p.breedAge, row * w);
  }

  #copyRow(fromRow: number, toRow: number): void {
    const w = this.cfg.width;
    this.species.copyWithin(toRow * w, fromRow * w, (fromRow + 1) * w);
    this.energy.copyWithin(toRow * w, fromRow * w, (fromRow + 1) * w);
    this.breedAge.copyWithin(toRow * w, fromRow * w, (fromRow + 1) * w);
  }

  #clearLogs(): void {
    this.#upLog = emptyLog();
    this.#downLog = emptyLog();
  }

  /** Fresh copies of the owned rows (no ghosts) — safe to transfer. */
  snapshotOwned(): RegionStorage {
    const w = this.cfg.width;
    const start = w;
    const end = (this.rowCount + 1) * w;
    return {
      species: this.species.slice(start, end),
      energy: this.energy.slice(start, end),
      breedAge: this.breedAge.slice(start, end),
    };
  }

  populationsOwned(): { fish: number; sharks: number } {
    const w = this.cfg.width;
    const end = (this.rowCount + 1) * w;
    let fish = 0;
    let sharks = 0;
    for (let i = w; i < end; i += 1) {
      const s = this.species[i]!;
      if (s === FISH) {
        fish += 1;
      } else if (s === SHARK) {
        sharks += 1;
      }
    }
    return { fish, sharks };
  }
}

function logMigration(log: MigLog, col: number, sp: number, en: number, ba: number): void {
  log.cols.push(col);
  log.species.push(sp);
  log.energy.push(en);
  log.breedAge.push(ba);
}
