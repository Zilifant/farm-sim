import {
  POOL_SHUTDOWN,
  POOL_SYNC,
  type CommandBatch,
  type MessageEnvelope,
} from "../messaging/types.js";
import type { WorkerAdapter, WorkerBootData, WorkerHandle } from "./types.js";

export interface WorkerPool {
  readonly size: number;
  spawnAll(): Promise<void>;
  /** Resolves when every worker has acknowledged — all at a tick boundary. */
  barrier(): Promise<void>;
  broadcast(batch: CommandBatch): void;
  shutdown(opts: { graceful: boolean; timeoutMs: number }): Promise<number[]>;
}

export interface WorkerPoolOptions {
  readonly adapter: WorkerAdapter;
  readonly entry: URL;
  readonly size: number;
  readonly boot: (index: number) => WorkerBootData;
}

export interface ExchangeRequest {
  readonly batch: CommandBatch;
  readonly transfer?: readonly ArrayBuffer[];
}

interface Pending {
  resolve(env: MessageEnvelope): void;
  reject(err: Error): void;
}

export class DefaultWorkerPool implements WorkerPool {
  readonly size: number;
  readonly #opts: WorkerPoolOptions;
  readonly #handles: WorkerHandle[] = [];
  readonly #pending: Array<Map<number, Pending>> = [];

  constructor(opts: WorkerPoolOptions) {
    if (!Number.isInteger(opts.size) || opts.size < 1) {
      throw new Error("pool size must be an integer >= 1");
    }
    this.size = opts.size;
    this.#opts = opts;
  }

  get handles(): readonly WorkerHandle[] {
    return this.#handles;
  }

  async spawnAll(): Promise<void> {
    if (this.#handles.length > 0) {
      throw new Error("spawnAll() called twice");
    }
    for (let i = 0; i < this.size; i += 1) {
      const handle = this.#opts.adapter.spawn(this.#opts.entry, this.#opts.boot(i));
      const pending = new Map<number, Pending>();
      this.#handles.push(handle);
      this.#pending.push(pending);
      handle.onMessage((env) => {
        const entry = pending.get(env.seq);
        if (entry === undefined) {
          return;
        }
        pending.delete(env.seq);
        if (env.error !== undefined) {
          entry.reject(new Error(`worker ${i}: ${env.error.message}`));
        } else {
          entry.resolve(env);
        }
      });
      const failAll = (err: Error): void => {
        for (const [seq, entry] of pending) {
          pending.delete(seq);
          entry.reject(err);
        }
      };
      handle.onError((err) => failAll(new Error(`worker ${i} errored: ${err.message}`)));
      handle.onExit((code) => failAll(new Error(`worker ${i} exited (code ${code}) with replies pending`)));
    }
  }

  /** One round: post a batch to every worker, await one reply from each.
   * This is the pool's synchronization primitive — resolving means every
   * worker finished its batch. */
  exchange(make: (index: number) => ExchangeRequest): Promise<MessageEnvelope[]> {
    this.#assertSpawned();
    return Promise.all(
      this.#handles.map((handle, i) => {
        const { batch, transfer } = make(i);
        return new Promise<MessageEnvelope>((resolve, reject) => {
          const seq = handle.postBatch(batch, transfer ?? []);
          this.#pending[i]!.set(seq, { resolve, reject });
        });
      }),
    );
  }

  async barrier(): Promise<void> {
    await this.exchange(() => ({
      batch: { tick: null, commands: [{ kind: POOL_SYNC }] },
    }));
  }

  broadcast(batch: CommandBatch): void {
    this.#assertSpawned();
    for (const handle of this.#handles) {
      handle.postBatch(batch);
    }
  }

  async shutdown(opts: { graceful: boolean; timeoutMs: number }): Promise<number[]> {
    this.#assertSpawned();
    if (!opts.graceful) {
      return Promise.all(this.#handles.map((h) => h.terminate()));
    }
    this.broadcast({ tick: null, commands: [{ kind: POOL_SHUTDOWN }] });
    return Promise.all(
      this.#handles.map(async (handle) => {
        const code = await withTimeout(handle.waitExit(), opts.timeoutMs);
        if (code !== undefined) {
          return code;
        }
        return handle.terminate();
      }),
    );
  }

  #assertSpawned(): void {
    if (this.#handles.length === 0) {
      throw new Error("pool not spawned — call spawnAll() first");
    }
  }
}

/** Resolves with the promise's value, or undefined after timeoutMs. */
function withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
