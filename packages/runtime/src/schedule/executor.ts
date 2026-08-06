import type { BufferId, BufferRegistry, TypedArray } from "../memory/buffer-registry.js";
import type { Profiler } from "../profile/profiler.js";
import type { RngStream } from "../rng/stream.js";
import type { System, SystemContext, TickPlan } from "./types.js";

export interface TickExecutorOptions {
  readonly plan: TickPlan;
  readonly buffers: BufferRegistry;
  /** Root stream; each system gets a fork keyed by its id. */
  readonly rng: RngStream;
  readonly fixedDtMs: number;
  readonly profiler?: Profiler;
}

interface Entry {
  readonly system: System;
  readonly ctx: SystemContext;
  readonly interval: bigint;
}

/** Runs a TickPlan single-threaded: filters by everyNTicks, builds validated
 * per-system contexts, and profiles each update. */
export class TickExecutor {
  readonly #entries: Entry[] = [];
  readonly #profiler: Profiler | undefined;
  #currentTick = 0n;
  #initialized = false;

  constructor(opts: TickExecutorOptions) {
    this.#profiler = opts.profiler;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const executor = this;
    for (const { system } of opts.plan.systems) {
      const declared = new Set<BufferId>([...system.reads, ...system.writes]);
      const rng = opts.rng.fork(system.id);
      const ctx: SystemContext = {
        get tick(): bigint {
          return executor.#currentTick;
        },
        fixedDtMs: opts.fixedDtMs,
        rng,
        buffer<T extends TypedArray = TypedArray>(id: BufferId): T {
          if (!declared.has(id)) {
            throw new Error(
              `system "${system.id}" accessed undeclared buffer "${id}"`,
            );
          }
          return opts.buffers.get<T>(id);
        },
      };
      this.#entries.push({ system, ctx, interval: BigInt(system.everyNTicks) });
    }
  }

  async init(): Promise<void> {
    if (this.#initialized) {
      throw new Error("TickExecutor.init() called twice");
    }
    this.#initialized = true;
    for (const entry of this.#entries) {
      await entry.system.init(entry.ctx);
    }
  }

  runTick(tick: bigint): void {
    if (!this.#initialized) {
      throw new Error("TickExecutor.runTick() before init()");
    }
    this.#currentTick = tick;
    for (const entry of this.#entries) {
      if (tick % entry.interval !== 0n) {
        continue;
      }
      const stop = this.#profiler?.span(entry.system.id, tick);
      entry.system.update(entry.ctx);
      stop?.();
    }
  }
}
