// Command batching: at most one postMessage per worker per tick, in each
// direction. Commands are structured-clone-able plain objects tagged by kind;
// bulk data rides in typed arrays whose ArrayBuffers go in the transfer list.

export interface SimCommand {
  readonly kind: string;
}

export interface CommandBatch {
  readonly tick: bigint | null;
  readonly commands: readonly SimCommand[];
}

export interface WorkerStats {
  /** Messages this worker has posted since boot. */
  readonly posts: number;
}

/** Wire format between main and workers. Exactly one reply envelope per
 * received envelope, matched by seq. */
export interface MessageEnvelope {
  readonly seq: number;
  readonly batch?: CommandBatch;
  readonly stats?: WorkerStats;
  readonly error?: { readonly message: string };
}

export const POOL_SYNC = "pool.sync";
export const POOL_SHUTDOWN = "pool.shutdown";
