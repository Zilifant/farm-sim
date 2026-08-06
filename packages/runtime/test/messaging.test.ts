import { MessageChannel } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { SimCommandBuffer, assertDetached } from "@sim/runtime";

describe("SimCommandBuffer", () => {
  it("accumulates commands and flushes them as one batch", () => {
    const buf = new SimCommandBuffer();
    buf.push({ kind: "a" });
    buf.push({ kind: "b" });
    expect(buf.size).toBe(2);
    const batch = buf.flush(7n);
    expect(batch.tick).toBe(7n);
    expect(batch.commands.map((c) => c.kind)).toEqual(["a", "b"]);
    expect(buf.size).toBe(0);
    expect(buf.flush().commands).toEqual([]);
  });
});

describe("zero-copy transfer", () => {
  it("detaches the sender's buffer (byteLength === 0 after transfer)", async () => {
    const { port1, port2 } = new MessageChannel();
    const payload = new Uint8Array([1, 2, 3, 4]);
    const received = new Promise<Uint8Array>((resolve) => {
      port2.on("message", (v) => resolve((v as { data: Uint8Array }).data));
    });
    const buffer = payload.buffer;
    port1.postMessage({ data: payload }, [buffer]);
    expect(buffer.byteLength).toBe(0); // detached — moved, not copied
    expect(() => assertDetached([buffer])).not.toThrow();
    expect(Array.from(await received)).toEqual([1, 2, 3, 4]);
    port1.close();
    port2.close();
  });

  it("assertDetached flags buffers that were cloned instead of moved", () => {
    const untransferred = new ArrayBuffer(8);
    expect(() => assertDetached([untransferred])).toThrow(/not detached/);
  });
});
