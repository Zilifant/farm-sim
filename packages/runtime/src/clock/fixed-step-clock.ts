export interface SimClock {
  /** Completed ticks. */
  readonly tick: bigint;
  readonly fixedDtMs: number;
  /** 0 = paused accumulation while the loop keeps running; 0.25–8 typical. */
  speed: number;
  start(): void;
  pause(): void;
  /** Run exactly one tick; requires a stopped clock. */
  stepOnce(): Promise<void>;
}

export interface FixedStepClockOptions {
  readonly fixedDtMs: number;
  /** Receives the index of the tick being executed (starts at 0n). */
  readonly onTick: (tick: bigint) => void;
  /** Injectable for tests; defaults to performance.now / setTimeout. */
  readonly now?: () => number;
  readonly setTimer?: (cb: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Backlog cap per loop iteration — bounds the catch-up spiral after a
   * stall; excess backlog beyond one tick is dropped. */
  readonly maxTicksPerSlice?: number;
}

/**
 * Fixed-timestep driver: wall-clock time scaled by `speed` accumulates, and
 * each `fixedDtMs` of accumulated sim time runs one tick. Simulation results
 * never depend on wall-clock timing — only how fast ticks are dispatched.
 */
export class FixedStepClock implements SimClock {
  readonly fixedDtMs: number;
  readonly #onTick: (tick: bigint) => void;
  readonly #now: () => number;
  readonly #setTimer: (cb: () => void, delayMs: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #maxTicksPerSlice: number;

  #tick = 0n;
  #speed = 1;
  #accMs = 0;
  #lastMs = 0;
  #running = false;
  #timer: unknown;

  constructor(opts: FixedStepClockOptions) {
    if (!Number.isFinite(opts.fixedDtMs) || opts.fixedDtMs <= 0) {
      throw new RangeError("fixedDtMs must be a finite number > 0");
    }
    if (
      opts.maxTicksPerSlice !== undefined &&
      (!Number.isInteger(opts.maxTicksPerSlice) || opts.maxTicksPerSlice < 1)
    ) {
      throw new RangeError("maxTicksPerSlice must be an integer >= 1");
    }
    this.fixedDtMs = opts.fixedDtMs;
    this.#onTick = opts.onTick;
    this.#now = opts.now ?? (() => performance.now());
    this.#setTimer =
      opts.setTimer ?? ((cb, delayMs) => setTimeout(cb, delayMs));
    this.#clearTimer =
      opts.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.#maxTicksPerSlice = opts.maxTicksPerSlice ?? 8;
  }

  get tick(): bigint {
    return this.#tick;
  }

  get running(): boolean {
    return this.#running;
  }

  get speed(): number {
    return this.#speed;
  }

  set speed(value: number) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError("speed must be a finite number >= 0");
    }
    this.#speed = value;
  }

  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#lastMs = this.#now();
    this.#schedule(0);
  }

  pause(): void {
    if (!this.#running) {
      return;
    }
    this.#running = false;
    this.#accMs = 0;
    if (this.#timer !== undefined) {
      this.#clearTimer(this.#timer);
      this.#timer = undefined;
    }
  }

  async stepOnce(): Promise<void> {
    if (this.#running) {
      throw new Error("stepOnce() requires the clock to be paused");
    }
    this.#runTick();
  }

  #schedule(delayMs: number): void {
    this.#timer = this.#setTimer(this.#advance, delayMs);
  }

  readonly #advance = (): void => {
    if (!this.#running) {
      return;
    }
    const nowMs = this.#now();
    const elapsed = Math.max(0, nowMs - this.#lastMs);
    this.#lastMs = nowMs;
    this.#accMs += elapsed * this.#speed;

    let ran = 0;
    while (this.#accMs >= this.fixedDtMs && ran < this.#maxTicksPerSlice) {
      this.#runTick();
      this.#accMs -= this.fixedDtMs;
      ran += 1;
    }
    if (!this.#running) {
      return; // paused from inside onTick
    }
    if (this.#accMs > this.fixedDtMs) {
      this.#accMs = this.fixedDtMs;
    }
    const delayMs =
      this.#speed > 0
        ? Math.max(0, (this.fixedDtMs - this.#accMs) / this.#speed)
        : this.fixedDtMs;
    this.#schedule(delayMs);
  };

  #runTick(): void {
    const current = this.#tick;
    this.#tick = current + 1n;
    this.#onTick(current);
  }
}
