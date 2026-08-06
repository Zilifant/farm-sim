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
import { EMPTY, FISH, SALT_ACT, SHARK, actCell, seedCell } from "./rules.js";
import type { WaTorConfig } from "./wator.js";

export { COUNTER_MAX, EMPTY, FISH, SHARK } from "./rules.js";

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
    const { width: w, height: h } = this.cfg;
    for (let r = 0; r <= this.rowCount + 1; r += 1) {
      const gy = (((this.rowStart + r - 1) % h) + h) % h;
      for (let x = 0; x < w; x += 1) {
        const { sp, en, ba } = seedCell(this.cfg, this.#seedHash, gy * w + x);
        const idx = r * w + x;
        this.species[idx] = sp;
        this.energy[idx] = en;
        this.breedAge[idx] = ba;
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
        if (this.species[idx]! === EMPTY) {
          continue;
        }
        const rand = hashCell(this.#seedHash, tickLo, tickHi, gy * w + x, SALT_ACT);
        // Neighbors in fixed up/right/down/left order; toroidal in x within
        // the row, ±width across rows (ghost rows cover the y wrap).
        actCell(
          this.cfg,
          this.species,
          this.energy,
          this.breedAge,
          idx,
          idx - w,
          base + (x === w - 1 ? 0 : x + 1),
          idx + w,
          base + (x === 0 ? w - 1 : x - 1),
          rand,
          this.#writeCell,
        );
      }
    }
  }

  /** Write a full cell; ghost-row writes are logged as outgoing migrations. */
  readonly #writeCell = (idx: number, sp: number, en: number, ba: number): void => {
    this.species[idx] = sp;
    this.energy[idx] = en;
    this.breedAge[idx] = ba;
    const w = this.cfg.width;
    if (idx < w) {
      logMigration(this.#upLog, idx, sp, en, ba);
    } else if (idx >= (this.rowCount + 1) * w) {
      logMigration(this.#downLog, idx - (this.rowCount + 1) * w, sp, en, ba);
    }
  };

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
