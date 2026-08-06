import type { CommandBatch } from "../messaging/types.js";

/** Records externally injected command batches by tick; playback re-yields
 * them in order so a run can be reproduced from (seed, log). */
export interface ReplayLog {
  record(tick: bigint, batch: CommandBatch): void;
  playback(): AsyncIterable<[bigint, CommandBatch]>;
}

export class InMemoryReplayLog implements ReplayLog {
  readonly #entries: Array<[bigint, CommandBatch]> = [];

  get size(): number {
    return this.#entries.length;
  }

  record(tick: bigint, batch: CommandBatch): void {
    const last = this.#entries.at(-1);
    if (last !== undefined && tick < last[0]) {
      throw new Error(`replay log ticks must be non-decreasing: ${tick} after ${last[0]}`);
    }
    this.#entries.push([tick, batch]);
  }

  entries(): ReadonlyArray<[bigint, CommandBatch]> {
    return this.#entries;
  }

  async *playback(): AsyncIterable<[bigint, CommandBatch]> {
    for (const entry of this.#entries) {
      yield entry;
    }
  }
}
