import type { BufferId, TypedArray } from "../memory/buffer-registry.js";
import type { RngStream } from "../rng/stream.js";

/** Handed to systems at init/update. Buffer access is validated against the
 * system's declared reads/writes. */
export interface SystemContext {
  readonly tick: bigint;
  readonly fixedDtMs: number;
  readonly rng: RngStream;
  buffer<T extends TypedArray = TypedArray>(id: BufferId): T;
}

/** Domain logic lives in systems, outside the runtime. */
export interface System {
  readonly id: string;
  /** 1 = every tick. */
  readonly everyNTicks: number;
  readonly reads: readonly BufferId[];
  readonly writes: readonly BufferId[];
  init(ctx: SystemContext): void | Promise<void>;
  /** Synchronous inside a tick. */
  update(ctx: SystemContext): void;
}

export interface SystemPlacement {
  readonly workerGroup: string;
}

export interface ScheduledSystem {
  readonly system: System;
  readonly placement: SystemPlacement;
}

/** Deterministic tick ordering. */
export interface TickPlan {
  readonly systems: readonly ScheduledSystem[];
}
