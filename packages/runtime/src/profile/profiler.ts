export interface SystemTimings {
  readonly systemId: string;
  /** Samples currently held (ring-buffered; oldest evicted first). */
  readonly samples: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

export interface Profiler {
  /** Start a span; call the returned function to stop and record it. */
  span(systemId: string, tick: bigint): () => void;
  report(): SystemTimings[];
}

interface Ring {
  readonly buf: Float64Array;
  next: number;
  filled: number;
}

export interface RingProfilerOptions {
  /** Samples retained per system (default 1024). */
  readonly capacity?: number;
  /** Injectable for tests; defaults to performance.now. */
  readonly now?: () => number;
}

export class RingProfiler implements Profiler {
  readonly #capacity: number;
  readonly #now: () => number;
  readonly #rings = new Map<string, Ring>();

  constructor(opts: RingProfilerOptions = {}) {
    if (
      opts.capacity !== undefined &&
      (!Number.isInteger(opts.capacity) || opts.capacity < 1)
    ) {
      throw new RangeError("capacity must be an integer >= 1");
    }
    this.#capacity = opts.capacity ?? 1024;
    this.#now = opts.now ?? (() => performance.now());
  }

  span(systemId: string, _tick: bigint): () => void {
    const startMs = this.#now();
    return () => {
      this.#record(systemId, this.#now() - startMs);
    };
  }

  #record(systemId: string, durationMs: number): void {
    let ring = this.#rings.get(systemId);
    if (ring === undefined) {
      ring = { buf: new Float64Array(this.#capacity), next: 0, filled: 0 };
      this.#rings.set(systemId, ring);
    }
    ring.buf[ring.next] = durationMs;
    ring.next = (ring.next + 1) % this.#capacity;
    if (ring.filled < this.#capacity) {
      ring.filled += 1;
    }
  }

  report(): SystemTimings[] {
    const out: SystemTimings[] = [];
    for (const [systemId, ring] of this.#rings) {
      const values = Array.from(ring.buf.subarray(0, ring.filled));
      const n = values.length;
      let sum = 0;
      let max = 0;
      for (const d of values) {
        sum += d;
        if (d > max) {
          max = d;
        }
      }
      out.push({
        systemId,
        samples: n,
        p50Ms: quantile(values, 0.5),
        p95Ms: quantile(values, 0.95),
        maxMs: max,
        meanMs: n > 0 ? sum / n : 0,
      });
    }
    return out;
  }
}

/** Nearest-rank quantile over an unsorted sample (0 for an empty one). */
export function quantile(values: readonly number[], p: number): number {
  const n = values.length;
  if (n === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
  return sorted[idx]!;
}
