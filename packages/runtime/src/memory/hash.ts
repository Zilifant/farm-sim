// FNV-1a over raw buffer bytes — the state-hash primitive behind the
// determinism suite. Byte order follows the host's typed-array endianness
// (little-endian on all supported targets), so hashes compare within, not
// across, architectures.

export const FNV1A_32_OFFSET_BASIS = 0x811c9dc5;
const FNV1A_32_PRIME = 0x01000193;

export function fnv1a32(bytes: Uint8Array, hash = FNV1A_32_OFFSET_BASIS): number {
  let h = hash >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i]!;
    h = Math.imul(h, FNV1A_32_PRIME);
  }
  return h >>> 0;
}

export function viewBytes(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/** Chained FNV-1a over each view's bytes, in iteration order. */
export function hashBuffers(views: Iterable<ArrayBufferView>): number {
  let h = FNV1A_32_OFFSET_BASIS;
  for (const view of views) {
    h = fnv1a32(viewBytes(view), h);
  }
  return h;
}
