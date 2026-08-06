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

/**
 * Crash policy: fail-fast. A worker error or unexpected exit rejects every
 * pending reply, terminates the remaining workers (no orphans), and poisons
 * the pool — later exchanges throw the failure diagnostic. Recovery
 * (restart-from-snapshot) is a driver concern layered on top via
 * onFailure(); the pool itself stays dead once failed. shutdown() is always
 * allowed so callers can collect exit codes.
 */
export class DefaultWorkerPool implements WorkerPool {
  readonly size: number;
  readonly #opts: WorkerPoolOptions;
  readonly #handles: WorkerHandle[] = [];
  readonly #pending: Array<Map<number, Pending>> = [];
  readonly #failureCbs: Array<(err: Error) => void> = [];
  #failure: Error | null = null;
  #shuttingDown = false;

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

  /** The diagnostic that poisoned the pool, if a worker has crashed. */
  get failure(): Error | null {
    return this.#failure;
  }

  onFailure(cb: (err: Error) => void): void {
    this.#failureCbs.push(cb);
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
      handle.onError((err) => {
        this.#rejectPending(i, new Error(`worker ${i} errored: ${err.message}`));
        this.#failFast(new Error(`worker ${i} crashed: ${err.message}`));
      });
      handle.onExit((code) => {
        this.#rejectPending(i, new Error(`worker ${i} exited (code ${code}) with replies pending`));
        this.#failFast(new Error(`worker ${i} exited unexpectedly with code ${code}`));
      });
    }
  }

  /** One round: post a batch to every worker, await one reply from each.
   * This is the pool's synchronization primitive — resolving means every
   * worker finished its batch. Async so a poisoned pool rejects rather
   * than throwing synchronously. */
  async exchange(make: (index: number) => ExchangeRequest): Promise<MessageEnvelope[]> {
    this.#assertUsable();
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
    this.#assertUsable();
    for (const handle of this.#handles) {
      handle.postBatch(batch);
    }
  }

  async shutdown(opts: { graceful: boolean; timeoutMs: number }): Promise<number[]> {
    this.#assertSpawned();
    this.#shuttingDown = true;
    if (!opts.graceful || this.#failure !== null) {
      return Promise.all(this.#handles.map((h) => h.terminate()));
    }
    for (const handle of this.#handles) {
      handle.postBatch({ tick: null, commands: [{ kind: POOL_SHUTDOWN }] });
    }
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

  #rejectPending(worker: number, err: Error): void {
    const pending = this.#pending[worker]!;
    for (const [seq, entry] of pending) {
      pending.delete(seq);
      entry.reject(err);
    }
  }

  /** One crash poisons the pool: reject everything in flight, terminate the
   * survivors so no worker outlives the failure. */
  #failFast(cause: Error): void {
    if (this.#failure !== null || this.#shuttingDown) {
      return;
    }
    const err = new Error(`worker pool failed: ${cause.message} — terminating remaining workers`);
    this.#failure = err;
    for (let i = 0; i < this.#handles.length; i += 1) {
      this.#rejectPending(i, err);
      void this.#handles[i]!.terminate().catch(() => undefined);
    }
    for (const cb of this.#failureCbs) {
      cb(err);
    }
  }

  #assertSpawned(): void {
    if (this.#handles.length === 0) {
      throw new Error("pool not spawned — call spawnAll() first");
    }
  }

  #assertUsable(): void {
    this.#assertSpawned();
    if (this.#failure !== null) {
      throw this.#failure;
    }
    if (this.#shuttingDown) {
      throw new Error("pool is shutting down");
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
