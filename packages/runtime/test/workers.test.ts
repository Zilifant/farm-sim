import { describe, expect, it } from "vitest";
import {
  DefaultWorkerPool,
  TestWorkerAdapter,
  serveWorker,
  type MessageEnvelope,
  type PortLike,
  type SimCommand,
} from "@sim/runtime";

const ENTRY = new URL("test://worker");

function echoAdapter(): TestWorkerAdapter {
  return new TestWorkerAdapter((port, boot) => {
    serveWorker(port, {
      handlers: {
        echo: (cmd, ctx) => {
          ctx.reply({ kind: "echo", index: boot["index"], value: (cmd as SimCommand & { value: unknown }).value } as SimCommand);
        },
        boom: () => {
          throw new Error("kaboom");
        },
      },
    });
  });
}

function makePool(adapter: TestWorkerAdapter, size: number): DefaultWorkerPool {
  return new DefaultWorkerPool({
    adapter,
    entry: ENTRY,
    size,
    boot: (index) => ({ index }),
  });
}

describe("DefaultWorkerPool with TestWorkerAdapter", () => {
  it("exchange posts one batch per worker and collects one reply from each", async () => {
    const pool = makePool(echoAdapter(), 3);
    await pool.spawnAll();
    const replies = await pool.exchange((i) => ({
      batch: { tick: 1n, commands: [{ kind: "echo", value: i * 10 } as SimCommand] },
    }));
    const values = replies.map(
      (env) => (env.batch?.commands[0] as SimCommand & { index: number; value: number }),
    );
    expect(values.map((v) => v.index)).toEqual([0, 1, 2]);
    expect(values.map((v) => v.value)).toEqual([0, 10, 20]);
    expect(replies.every((env) => env.stats?.posts === 1)).toBe(true);
    await pool.shutdown({ graceful: true, timeoutMs: 1000 });
  });

  it("barrier resolves only after every worker replies, despite jitter", async () => {
    const delays = [25, 1, 12];
    let replied = 0;
    const adapter = new TestWorkerAdapter((port, boot) => {
      const delay = delays[boot["index"] as number]!;
      port.on("message", (value) => {
        const env = value as MessageEnvelope;
        setTimeout(() => {
          replied += 1;
          port.postMessage({ seq: env.seq, batch: { tick: null, commands: [] } });
        }, delay);
      });
    });
    const pool = makePool(adapter, 3);
    await pool.spawnAll();
    for (let round = 0; round < 3; round += 1) {
      const before = replied;
      await pool.barrier();
      expect(replied - before).toBe(3); // nobody skipped, nobody double-counted
    }
    await pool.shutdown({ graceful: false, timeoutMs: 100 });
  });

  it("rejects the exchange when a worker handler throws", async () => {
    const pool = makePool(echoAdapter(), 2);
    await pool.spawnAll();
    await expect(
      pool.exchange((i) => ({
        batch: { tick: null, commands: [{ kind: i === 1 ? "boom" : "echo", value: 0 } as SimCommand] },
      })),
    ).rejects.toThrow(/worker 1: kaboom/);
    await pool.shutdown({ graceful: false, timeoutMs: 100 });
  });

  it("rejects the exchange when there is no handler for a command", async () => {
    const pool = makePool(echoAdapter(), 1);
    await pool.spawnAll();
    await expect(
      pool.exchange(() => ({ batch: { tick: null, commands: [{ kind: "nope" }] } })),
    ).rejects.toThrow(/no handler/);
    await pool.shutdown({ graceful: false, timeoutMs: 100 });
  });

  it("rejects pending replies when a worker exits mid-exchange", async () => {
    const adapter = new TestWorkerAdapter(() => {
      // Worker never replies.
    });
    const pool = makePool(adapter, 1);
    await pool.spawnAll();
    const exchange = pool.exchange(() => ({ batch: { tick: null, commands: [{ kind: "echo" }] } }));
    const handle = adapter.spawned[0]!;
    await handle.terminate();
    await expect(exchange).rejects.toThrow(/exited .* with replies pending/);
  });

  it("graceful shutdown lets workers close their ports and exit 0", async () => {
    const pool = makePool(echoAdapter(), 2);
    await pool.spawnAll();
    const codes = await pool.shutdown({ graceful: true, timeoutMs: 1000 });
    expect(codes).toEqual([0, 0]);
  });

  it("graceful shutdown terminates workers that ignore the request", async () => {
    const adapter = new TestWorkerAdapter((port) => {
      port.on("message", () => {
        // Ignores pool.shutdown: never closes its port.
      });
    });
    const pool = makePool(adapter, 1);
    await pool.spawnAll();
    const codes = await pool.shutdown({ graceful: true, timeoutMs: 50 });
    expect(codes).toEqual([1]); // fell back to terminate()
  });

  it("counts posts and detaches transferred buffers on the sender side", async () => {
    const pool = makePool(echoAdapter(), 1);
    await pool.spawnAll();
    const handle = pool.handles[0]!;
    const payload = new Uint8Array([9, 9, 9]);
    const buffer = payload.buffer;
    await pool.exchange(() => ({
      batch: { tick: null, commands: [{ kind: "echo", value: 1 } as SimCommand] },
      transfer: [buffer],
    }));
    expect(buffer.byteLength).toBe(0); // moved, not copied
    expect(handle.postCount).toBe(1);
    expect(handle.lastWorkerStats?.posts).toBe(1);
    await pool.shutdown({ graceful: true, timeoutMs: 1000 });
  });

  it("refuses use before spawnAll", () => {
    const pool = makePool(echoAdapter(), 1);
    expect(() => pool.broadcast({ tick: null, commands: [] })).toThrow(/spawnAll/);
  });
});

describe("serveWorker", () => {
  it("processes batches strictly in arrival order", async () => {
    const order: number[] = [];
    const adapter = new TestWorkerAdapter((port: PortLike) => {
      serveWorker(port, {
        handlers: {
          slow: async (cmd) => {
            await new Promise((r) => setTimeout(r, 15));
            order.push((cmd as SimCommand & { n: number }).n);
          },
          fast: (cmd) => {
            order.push((cmd as SimCommand & { n: number }).n);
          },
        },
      });
    });
    const pool = makePool(adapter, 1);
    await pool.spawnAll();
    const handle = pool.handles[0]!;
    const seq1 = handle.postBatch({ tick: null, commands: [{ kind: "slow", n: 1 } as SimCommand] });
    const seq2 = handle.postBatch({ tick: null, commands: [{ kind: "fast", n: 2 } as SimCommand] });
    const got = new Set<number>();
    await new Promise<void>((resolve) => {
      handle.onMessage((env) => {
        got.add(env.seq);
        if (got.has(seq1) && got.has(seq2)) {
          resolve();
        }
      });
    });
    expect(order).toEqual([1, 2]); // slow batch finished before fast started
    await pool.shutdown({ graceful: true, timeoutMs: 1000 });
  });
});
