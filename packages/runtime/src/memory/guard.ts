// Debug-mode write enforcement: a WriteGuard checks element indices against
// a worker's allowed ranges and throws on violations. Hot paths call
// guard.assert() explicitly; guardView wraps a typed array in a Proxy for
// code that can't be instrumented.

import type { TypedArray } from "./buffer-registry.js";
import type { ElementRange } from "./region-map.js";

export class WriteGuard {
  readonly #ranges: readonly ElementRange[];
  readonly #label: string;

  /** Ranges must be sorted and non-overlapping (RowRegionMap.writableRanges
   * output qualifies). */
  constructor(ranges: readonly ElementRange[], label = "write guard") {
    this.#ranges = ranges;
    this.#label = label;
  }

  allows(index: number): boolean {
    for (const r of this.#ranges) {
      if (index < r.start) {
        return false;
      }
      if (index < r.end) {
        return true;
      }
    }
    return false;
  }

  assert(index: number): void {
    if (!this.allows(index)) {
      throw new Error(
        `${this.#label}: out-of-range write at element ${index} (allowed: ${this.#ranges
          .map((r) => `[${r.start}, ${r.end})`)
          .join(", ")})`,
      );
    }
  }
}

/** Proxy wrapper enforcing the guard on every indexed store. Debug use only —
 * every write costs a trap. */
export function guardView<T extends TypedArray>(view: T, guard: WriteGuard): T {
  return new Proxy(view, {
    set(target, prop, value): boolean {
      if (typeof prop === "string") {
        const index = Number(prop);
        if (Number.isInteger(index)) {
          guard.assert(index);
        }
      }
      Reflect.set(target, prop, value);
      return true;
    },
    get(target, prop): unknown {
      // Read with the real typed array as receiver — internal-slot accessors
      // (length, byteOffset, …) and methods reject a Proxy receiver.
      const value = Reflect.get(target, prop);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as T;
}
