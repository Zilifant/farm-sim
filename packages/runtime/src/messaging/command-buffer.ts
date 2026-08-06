import type { CommandBatch, SimCommand } from "./types.js";

/** Accumulates commands during a tick; flush() hands them off as a single
 * batch so callers post at most one message per worker per tick. */
export class SimCommandBuffer {
  #commands: SimCommand[] = [];

  get size(): number {
    return this.#commands.length;
  }

  push(cmd: SimCommand): void {
    this.#commands.push(cmd);
  }

  flush(tick: bigint | null = null): CommandBatch {
    const commands = this.#commands;
    this.#commands = [];
    return { tick, commands };
  }
}
