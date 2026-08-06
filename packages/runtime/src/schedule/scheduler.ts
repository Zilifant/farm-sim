import type { BufferRegistry } from "../memory/buffer-registry.js";
import type { ScheduledSystem, System, SystemPlacement, TickPlan } from "./types.js";

const MAIN_GROUP: SystemPlacement = { workerGroup: "main" };

/**
 * Registers systems and produces a deterministic TickPlan. Phase 1 ordering
 * is registration order (stable and explicit); reads/writes-derived ordering
 * and cross-region write validation land with workers in later phases.
 */
export class SystemScheduler {
  readonly #buffers: BufferRegistry;
  readonly #entries: ScheduledSystem[] = [];
  readonly #ids = new Set<string>();

  constructor(buffers: BufferRegistry) {
    this.#buffers = buffers;
  }

  register(system: System, placement: SystemPlacement = MAIN_GROUP): void {
    if (system.id.length === 0) {
      throw new Error("system id must be a non-empty string");
    }
    if (this.#ids.has(system.id)) {
      throw new Error(`system "${system.id}" is already registered`);
    }
    if (!Number.isInteger(system.everyNTicks) || system.everyNTicks < 1) {
      throw new Error(
        `system "${system.id}" everyNTicks must be an integer >= 1, got ${system.everyNTicks}`,
      );
    }
    for (const id of [...system.reads, ...system.writes]) {
      if (!this.#buffers.has(id)) {
        throw new Error(`system "${system.id}" declares unknown buffer "${id}"`);
      }
    }
    this.#ids.add(system.id);
    this.#entries.push({ system, placement });
  }

  plan(): TickPlan {
    return { systems: [...this.#entries] };
  }
}
