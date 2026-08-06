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
      const sorted = Array.from(ring.buf.subarray(0, ring.filled)).sort(
        (a, b) => a - b,
      );
      const n = sorted.length;
      let sum = 0;
      for (const d of sorted) {
        sum += d;
      }
      out.push({
        systemId,
        samples: n,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        maxMs: n > 0 ? sorted[n - 1]! : 0,
        meanMs: n > 0 ? sum / n : 0,
      });
    }
    return out;
  }
}

function percentile(sorted: readonly number[], p: number): number {
  const n = sorted.length;
  if (n === 0) {
    return 0;
  }
  const idx = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
  return sorted[idx]!;
}
