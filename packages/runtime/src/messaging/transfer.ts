/** Throws unless every buffer was detached by a postMessage transfer — the
 * zero-copy guarantee. Call immediately after posting with a transfer list. */
export function assertDetached(buffers: readonly ArrayBuffer[]): void {
  for (const b of buffers) {
    if (b.byteLength !== 0) {
      throw new Error(
        "transferred ArrayBuffer was not detached — transfer fell back to copy",
      );
    }
  }
}
