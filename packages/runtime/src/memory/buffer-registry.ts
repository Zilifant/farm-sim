// SoA state lives in typed arrays keyed by BufferId. Phase 1 allocates plain
// (worker-local) arrays; SAB-backed shared buffers arrive in Phase 3 behind
// the same ids.

export type BufferId = string & { readonly __brand: "BufferId" };

export function bufferId(id: string): BufferId {
  if (id.length === 0) {
    throw new Error("BufferId must be a non-empty string");
  }
  return id as BufferId;
}

export type TypedArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

export interface TypedArrayCtor {
  new (length: number): TypedArray;
  readonly BYTES_PER_ELEMENT: number;
}

export interface BufferSpec {
  readonly type: TypedArrayCtor;
  readonly length: number;
}

export class BufferRegistry {
  readonly #specs = new Map<BufferId, BufferSpec>();
  readonly #views = new Map<BufferId, TypedArray>();

  define(id: BufferId, spec: BufferSpec): void {
    if (this.#specs.has(id)) {
      throw new Error(`buffer "${id}" is already defined`);
    }
    if (!Number.isInteger(spec.length) || spec.length <= 0) {
      throw new Error(`buffer "${id}" length must be a positive integer`);
    }
    this.#specs.set(id, spec);
    this.#views.set(id, new spec.type(spec.length));
  }

  has(id: BufferId): boolean {
    return this.#specs.has(id);
  }

  spec(id: BufferId): BufferSpec {
    const spec = this.#specs.get(id);
    if (spec === undefined) {
      throw new Error(`unknown buffer "${id}"`);
    }
    return spec;
  }

  get<T extends TypedArray = TypedArray>(id: BufferId): T {
    const view = this.#views.get(id);
    if (view === undefined) {
      throw new Error(`unknown buffer "${id}"`);
    }
    return view as T;
  }

  ids(): BufferId[] {
    return [...this.#specs.keys()];
  }
}
