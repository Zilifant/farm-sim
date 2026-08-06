// Row-strip ownership over a toroidal grid: each worker owns an exclusive
// row range (its write range), may additionally write into the single
// adjacent edge row on each side (spill — cross-region migration; safe for
// rules whose per-tick write sets are disjoint by construction), and reads
// the adjacent rows as ghosts.

export type WorkerId = number;

export interface ElementRange {
  /** Inclusive. */
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
}

export interface RowStrip {
  readonly start: number;
  readonly count: number;
}

export interface RowRegionMapOptions {
  /** Elements per row. */
  readonly width: number;
  /** Total rows in the grid. */
  readonly height: number;
  /** One contiguous strip per worker, covering all rows in order. */
  readonly strips: readonly RowStrip[];
}

export class RowRegionMap {
  readonly width: number;
  readonly height: number;
  readonly strips: readonly RowStrip[];
  readonly #rowOwner: Int32Array;

  constructor(opts: RowRegionMapOptions) {
    const { width, height, strips } = opts;
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
      throw new Error("width and height must be positive integers");
    }
    this.width = width;
    this.height = height;
    this.strips = strips;
    this.#rowOwner = new Int32Array(height).fill(-1);
    let next = 0;
    for (let w = 0; w < strips.length; w += 1) {
      const { start, count } = strips[w]!;
      if (start !== next || !Number.isInteger(count) || count < 1) {
        throw new Error("strips must be contiguous, in order, and at least 1 row each");
      }
      for (let r = start; r < start + count; r += 1) {
        this.#rowOwner[r] = w;
      }
      next = start + count;
    }
    if (next !== height) {
      throw new Error(`strips cover rows [0, ${next}) but the grid has ${height} rows`);
    }
  }

  get workers(): number {
    return this.strips.length;
  }

  ownerOf(index: number): WorkerId {
    const row = Math.floor(index / this.width);
    if (row < 0 || row >= this.height) {
      throw new Error(`element index ${index} is outside the grid`);
    }
    return this.#rowOwner[row]!;
  }

  /** The worker's exclusive owned range. */
  writeRange(worker: WorkerId): ElementRange {
    const strip = this.#strip(worker);
    return { start: strip.start * this.width, end: (strip.start + strip.count) * this.width };
  }

  /** Read-only neighbor border rows (toroidal); excludes self-owned rows. */
  ghostRanges(worker: WorkerId): ElementRange[] {
    return this.#adjacentRows(worker).map((row) => ({
      start: row * this.width,
      end: (row + 1) * this.width,
    }));
  }

  /** Rows this worker may additionally write into for cross-region
   * migration — the same adjacent edge rows it reads as ghosts. */
  spillRanges(worker: WorkerId): ElementRange[] {
    return this.ghostRanges(worker);
  }

  /** Owned range plus spill rows, merged and sorted — the exact write set to
   * enforce in debug mode. */
  writableRanges(worker: WorkerId): ElementRange[] {
    const ranges = [this.writeRange(worker), ...this.spillRanges(worker)];
    ranges.sort((a, b) => a.start - b.start);
    const merged: Array<{ start: number; end: number }> = [];
    for (const r of ranges) {
      const last = merged.at(-1);
      if (last !== undefined && r.start <= last.end) {
        last.end = Math.max(last.end, r.end);
      } else {
        merged.push({ start: r.start, end: r.end });
      }
    }
    return merged;
  }

  #strip(worker: WorkerId): RowStrip {
    const strip = this.strips[worker];
    if (strip === undefined) {
      throw new Error(`unknown worker ${worker}`);
    }
    return strip;
  }

  #adjacentRows(worker: WorkerId): number[] {
    const strip = this.#strip(worker);
    const up = (strip.start - 1 + this.height) % this.height;
    const down = (strip.start + strip.count) % this.height;
    const rows: number[] = [];
    if (this.#rowOwner[up] !== worker) {
      rows.push(up);
    }
    if (this.#rowOwner[down] !== worker && down !== up) {
      rows.push(down);
    }
    return rows;
  }
}
