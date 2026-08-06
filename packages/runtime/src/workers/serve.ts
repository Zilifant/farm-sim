import { SimCommandBuffer } from "../messaging/command-buffer.js";
import { assertDetached } from "../messaging/transfer.js";
import {
  POOL_CRASH,
  POOL_SHUTDOWN,
  POOL_SYNC,
  type MessageEnvelope,
  type PoolCrashCommand,
  type SimCommand,
} from "../messaging/types.js";
import type { PortLike } from "./types.js";

export interface ServeContext {
  /** Queue a command for the single reply envelope of this batch. */
  reply(cmd: SimCommand): void;
  /** Mark buffers for zero-copy transfer with the reply. */
  transfer(...buffers: ArrayBuffer[]): void;
}

export type CommandHandler = (
  cmd: SimCommand,
  ctx: ServeContext,
) => void | Promise<void>;

export interface ServeOptions {
  readonly handlers: Readonly<Record<string, CommandHandler>>;
  readonly onShutdown?: () => void;
}

/**
 * Worker-side protocol loop: for every received envelope, dispatch its
 * commands to handlers and post exactly one reply (or one error envelope).
 * `pool.sync` yields an empty ack; `pool.shutdown` closes the port without
 * replying — the resulting worker exit is the acknowledgement. Batches are
 * processed strictly in arrival order.
 */
export function serveWorker(port: PortLike, opts: ServeOptions): void {
  let posts = 0;
  let chain: Promise<void> = Promise.resolve();

  port.on("message", (value) => {
    chain = chain.then(() => handleEnvelope(value));
  });

  async function handleEnvelope(value: unknown): Promise<void> {
    const env = value as MessageEnvelope;
    const out = new SimCommandBuffer();
    const transfers: ArrayBuffer[] = [];
    const ctx: ServeContext = {
      reply: (cmd) => out.push(cmd),
      transfer: (...buffers) => transfers.push(...buffers),
    };
    let shutdown = false;
    try {
      for (const cmd of env.batch?.commands ?? []) {
        if (cmd.kind === POOL_SHUTDOWN) {
          shutdown = true;
          continue;
        }
        if (cmd.kind === POOL_SYNC) {
          continue;
        }
        if (cmd.kind === POOL_CRASH) {
          // Fault injection: die without replying, like a real crash. In a
          // worker thread process.exit() stops only that thread. NEVER send
          // this to an in-process TestWorkerAdapter — it would exit the
          // host process; use TestWorkerHandle.simulateCrash() there.
          process.exit((cmd as PoolCrashCommand).code ?? 1);
        }
        const handler = opts.handlers[cmd.kind];
        if (handler === undefined) {
          throw new Error(`no handler for command kind "${cmd.kind}"`);
        }
        await handler(cmd, ctx);
      }
    } catch (err) {
      posts += 1;
      const reply: MessageEnvelope = {
        seq: env.seq,
        error: { message: err instanceof Error ? err.message : String(err) },
        stats: { posts },
      };
      port.postMessage(reply);
      return;
    }
    if (shutdown) {
      opts.onShutdown?.();
      port.close();
      return;
    }
    posts += 1;
    const reply: MessageEnvelope = {
      seq: env.seq,
      batch: out.flush(env.batch?.tick ?? null),
      stats: { posts },
    };
    port.postMessage(reply, transfers);
    assertDetached(transfers);
  }
}
