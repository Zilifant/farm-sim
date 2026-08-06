// MemoryLayout: SABs created once on the main thread, views distributed at
// boot. Shared buffers are passed to workers via a manifest (SharedArrayBuffer
// clones share memory; constructors travel by name) and re-attached with
// attachSharedViews. Local buffers are per-thread scratch.

import {
  bufferId,
  type BufferId,
  type BufferSpec,
  type TypedArray,
} from "./buffer-registry.js";

const CTORS = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
} as const;

export type TypedArrayCtorName = keyof typeof CTORS;

export interface SharedBufferEntry {
  readonly ctor: TypedArrayCtorName;
  readonly length: number;
  readonly sab: SharedArrayBuffer;
}

export type SharedBufferManifest = Record<string, SharedBufferEntry>;

export interface MemoryHandles {
  view<T extends TypedArray = TypedArray>(id: BufferId): T;
  isShared(id: BufferId): boolean;
  ids(): BufferId[];
  /** Shared entries only — ship to workers via boot data. */
  manifest(): SharedBufferManifest;
}

export class SharedMemoryLayout {
  readonly #specs = new Map<BufferId, { spec: BufferSpec; shared: boolean }>();
  #built = false;

  defineShared(id: BufferId, spec: BufferSpec): void {
    this.#define(id, spec, true);
  }

  defineLocal(id: BufferId, spec: BufferSpec): void {
    this.#define(id, spec, false);
  }

  #define(id: BufferId, spec: BufferSpec, shared: boolean): void {
    if (this.#built) {
      throw new Error("layout already built — define buffers before build()");
    }
    if (this.#specs.has(id)) {
      throw new Error(`buffer "${id}" is already defined`);
    }
    if (!Number.isInteger(spec.length) || spec.length <= 0) {
      throw new Error(`buffer "${id}" length must be a positive integer`);
    }
    if (shared && !(spec.type.name in CTORS)) {
      throw new Error(`buffer "${id}" type ${spec.type.name} cannot be shared`);
    }
    this.#specs.set(id, { spec, shared });
  }

  build(): MemoryHandles {
    if (this.#built) {
      throw new Error("build() called twice — SABs are created exactly once");
    }
    this.#built = true;
    const views = new Map<BufferId, TypedArray>();
    const shared = new Map<BufferId, SharedBufferEntry>();
    for (const [id, { spec, shared: isShared }] of this.#specs) {
      if (isShared) {
        const ctorName = spec.type.name as TypedArrayCtorName;
        const sab = new SharedArrayBuffer(spec.length * spec.type.BYTES_PER_ELEMENT);
        views.set(id, new CTORS[ctorName](sab as unknown as ArrayBuffer) as unknown as TypedArray);
        shared.set(id, { ctor: ctorName, length: spec.length, sab });
      } else {
        views.set(id, new spec.type(spec.length));
      }
    }
    return {
      view<T extends TypedArray = TypedArray>(id: BufferId): T {
        const v = views.get(id);
        if (v === undefined) {
          throw new Error(`unknown buffer "${id}"`);
        }
        return v as T;
      },
      isShared: (id) => shared.has(id),
      ids: () => [...views.keys()],
      manifest(): SharedBufferManifest {
        const out: Record<string, SharedBufferEntry> = {};
        for (const [id, entry] of shared) {
          out[id] = entry;
        }
        return out;
      },
    };
  }
}

/** Worker-side: rebuild typed-array views over the shared buffers. */
export function attachSharedViews(
  manifest: SharedBufferManifest,
): Map<BufferId, TypedArray> {
  const views = new Map<BufferId, TypedArray>();
  for (const [id, entry] of Object.entries(manifest)) {
    const ctor = CTORS[entry.ctor] as (typeof CTORS)[TypedArrayCtorName] | undefined;
    if (ctor === undefined) {
      throw new Error(`unknown typed array constructor "${entry.ctor}"`);
    }
    const view = new ctor(entry.sab as unknown as ArrayBuffer) as unknown as TypedArray;
    if (view.length !== entry.length) {
      throw new Error(
        `buffer "${id}" length mismatch: manifest says ${entry.length}, SAB holds ${view.length}`,
      );
    }
    views.set(bufferId(id), view);
  }
  return views;
}
