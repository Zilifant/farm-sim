// SAB-mode Wa-Tor region: operates directly on full-grid views over
// SharedArrayBuffers with global toroidal addressing — no ghost copies, no
// border messages. Cross-region migration is a direct write into the
// neighbor's edge row, safe because the color-phase rule makes every tick's
// write set conflict-free by construction (see region.ts); the plan's
// two-phase intent/resolve/apply pass is unnecessary under this rule. The
// per-tick ordering constraint (all of tick T before any of T+1) is the
// worker loop's Atomics barrier, not this class's concern.

import { hashCell, seedToU32, splitTick, type WriteGuard } from "@sim/runtime";
import { EMPTY, SALT_ACT, actCell, seedCell, type CellWriter } from "./rules.js";
import type { WaTorConfig } from "./wator.js";

export interface SharedRegionOptions {
  readonly cfg: WaTorConfig;
  readonly rowStart: number;
  readonly rowCount: number;
  /** Full-grid views (width × height), typically SAB-backed. */
  readonly species: Uint8Array;
  readonly energy: Int16Array;
  readonly breedAge: Int16Array;
  /** Debug mode: every write is checked against the worker's allowed
   * ranges (owned rows plus one spill row each side). */
  readonly guard?: WriteGuard;
}

export class WaTorSharedRegion {
  readonly cfg: WaTorConfig;
  readonly rowStart: number;
  readonly rowCount: number;
  readonly #species: Uint8Array;
  readonly #energy: Int16Array;
  readonly #breedAge: Int16Array;
  readonly #seedHash: number;
  readonly #write: CellWriter;

  constructor(opts: SharedRegionOptions) {
    const cells = opts.cfg.width * opts.cfg.height;
    if (opts.species.length !== cells || opts.energy.length !== cells || opts.breedAge.length !== cells) {
      throw new Error(`shared views must cover the full grid (${cells} cells)`);
    }
    this.cfg = opts.cfg;
    this.rowStart = opts.rowStart;
    this.rowCount = opts.rowCount;
    this.#species = opts.species;
    this.#energy = opts.energy;
    this.#breedAge = opts.breedAge;
    this.#seedHash = seedToU32(opts.cfg.seed);
    const guard = opts.guard;
    this.#write =
      guard === undefined
        ? (idx, sp, en, ba): void => {
            this.#species[idx] = sp;
            this.#energy[idx] = en;
            this.#breedAge[idx] = ba;
          }
        : (idx, sp, en, ba): void => {
            guard.assert(idx);
            this.#species[idx] = sp;
            this.#energy[idx] = en;
            this.#breedAge[idx] = ba;
          };
  }

  /** Seed this worker's exclusive rows only — together the workers cover the
   * grid, each cell from the same per-cell hash the other modes use. */
  seedOwnRows(): void {
    const w = this.cfg.width;
    const start = this.rowStart * w;
    const end = (this.rowStart + this.rowCount) * w;
    for (let gIdx = start; gIdx < end; gIdx += 1) {
      const { sp, en, ba } = seedCell(this.cfg, this.#seedHash, gIdx);
      this.#species[gIdx] = sp;
      this.#energy[gIdx] = en;
      this.#breedAge[gIdx] = ba;
    }
  }

  runTick(tick: bigint): void {
    const { width: w, height: h } = this.cfg;
    const active = Number(tick % 5n);
    const { lo: tickLo, hi: tickHi } = splitTick(tick);
    for (let r = 0; r < this.rowCount; r += 1) {
      const gy = this.rowStart + r;
      let x0 = (active - ((2 * gy) % 5)) % 5;
      if (x0 < 0) {
        x0 += 5;
      }
      const base = gy * w;
      const upBase = ((gy + h - 1) % h) * w;
      const downBase = ((gy + 1) % h) * w;
      for (let x = x0; x < w; x += 5) {
        const idx = base + x;
        if (this.#species[idx]! === EMPTY) {
          continue;
        }
        const rand = hashCell(this.#seedHash, tickLo, tickHi, idx, SALT_ACT);
        actCell(
          this.cfg,
          this.#species,
          this.#energy,
          this.#breedAge,
          idx,
          upBase + x,
          base + (x === w - 1 ? 0 : x + 1),
          downBase + x,
          base + (x === 0 ? w - 1 : x - 1),
          rand,
          this.#write,
        );
      }
    }
  }
}
