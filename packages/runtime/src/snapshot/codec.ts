// Binary snapshot serialization. Little-endian layout:
//   "SNAP" magic · u32 schemaVersion · u64 tick · u32 metaLen · meta JSON
//   · u32 bufferCount · per buffer: u32 idLen · id UTF-8 · u8 ctorCode
//   · u32 byteLength · data
// The schema version sits in the header from day one so a reader can route
// old saves through migration before touching the payload.

import type { TypedArray } from "../memory/buffer-registry.js";
import type { TypedArrayCtorName } from "../memory/layout.js";
import { viewBytes } from "../memory/hash.js";
import type { Snapshot, SnapshotBuffer } from "./types.js";

const MAGIC = [0x53, 0x4e, 0x41, 0x50] as const; // "SNAP"

const CTOR_NAMES: readonly TypedArrayCtorName[] = [
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
];

const CTORS: Record<TypedArrayCtorName, new (buffer: ArrayBuffer) => TypedArray> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
};

/** Copy a typed array's bytes into a SnapshotBuffer. */
export function snapshotBuffer(view: TypedArray): SnapshotBuffer {
  return {
    ctor: view.constructor.name as TypedArrayCtorName,
    data: viewBytes(view).slice(),
  };
}

/** Copy snapshot bytes back into an existing view (types must match). */
export function restoreInto(view: TypedArray, buf: SnapshotBuffer): void {
  if (view.constructor.name !== buf.ctor) {
    throw new Error(`buffer type mismatch: view is ${view.constructor.name}, snapshot holds ${buf.ctor}`);
  }
  if (view.byteLength !== buf.data.byteLength) {
    throw new Error(`buffer size mismatch: view is ${view.byteLength} bytes, snapshot holds ${buf.data.byteLength}`);
  }
  viewBytes(view).set(buf.data);
}

/** Materialize a snapshot buffer as a standalone typed array. */
export function viewFromSnapshotBuffer<T extends TypedArray = TypedArray>(buf: SnapshotBuffer): T {
  const copy = new ArrayBuffer(buf.data.byteLength);
  new Uint8Array(copy).set(buf.data);
  return new CTORS[buf.ctor](copy) as T;
}

export function encodeSnapshot(s: Snapshot): Uint8Array {
  const enc = new TextEncoder();
  const metaBytes = enc.encode(JSON.stringify(s.meta));
  const entries = Object.entries(s.buffers).map(([id, buf]) => {
    const code = CTOR_NAMES.indexOf(buf.ctor);
    if (code < 0) {
      throw new Error(`unknown typed array constructor "${buf.ctor}"`);
    }
    return { idBytes: enc.encode(id), code, data: buf.data };
  });

  let total = 4 + 4 + 8 + 4 + metaBytes.length + 4;
  for (const e of entries) {
    total += 4 + e.idBytes.length + 1 + 4 + e.data.length;
  }
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let o = 0;
  for (const b of MAGIC) {
    out[o] = b;
    o += 1;
  }
  dv.setUint32(o, s.schemaVersion, true);
  o += 4;
  dv.setBigUint64(o, s.tick, true);
  o += 8;
  dv.setUint32(o, metaBytes.length, true);
  o += 4;
  out.set(metaBytes, o);
  o += metaBytes.length;
  dv.setUint32(o, entries.length, true);
  o += 4;
  for (const e of entries) {
    dv.setUint32(o, e.idBytes.length, true);
    o += 4;
    out.set(e.idBytes, o);
    o += e.idBytes.length;
    out[o] = e.code;
    o += 1;
    dv.setUint32(o, e.data.length, true);
    o += 4;
    out.set(e.data, o);
    o += e.data.length;
  }
  return out;
}

export function decodeSnapshot(bytes: Uint8Array): Snapshot {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const need = (n: number): void => {
    if (o + n > bytes.length) {
      throw new Error("truncated snapshot");
    }
  };
  need(4);
  for (const b of MAGIC) {
    if (bytes[o] !== b) {
      throw new Error("not a snapshot: bad magic");
    }
    o += 1;
  }
  need(4 + 8 + 4);
  const schemaVersion = dv.getUint32(o, true);
  o += 4;
  const tick = dv.getBigUint64(o, true);
  o += 8;
  const metaLen = dv.getUint32(o, true);
  o += 4;
  need(metaLen);
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(o, o + metaLen))) as Record<string, unknown>;
  o += metaLen;
  need(4);
  const bufferCount = dv.getUint32(o, true);
  o += 4;
  const buffers: Record<string, SnapshotBuffer> = {};
  for (let i = 0; i < bufferCount; i += 1) {
    need(4);
    const idLen = dv.getUint32(o, true);
    o += 4;
    need(idLen + 1 + 4);
    const id = new TextDecoder().decode(bytes.subarray(o, o + idLen));
    o += idLen;
    const ctor = CTOR_NAMES[bytes[o]!];
    if (ctor === undefined) {
      throw new Error(`unknown constructor code ${bytes[o]}`);
    }
    o += 1;
    const dataLen = dv.getUint32(o, true);
    o += 4;
    need(dataLen);
    buffers[id] = { ctor, data: bytes.slice(o, o + dataLen) };
    o += dataLen;
  }
  return { schemaVersion, tick, meta, buffers };
}
