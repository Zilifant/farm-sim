import type { CommandBatch, MessageEnvelope, WorkerStats } from "../messaging/types.js";

export type WorkerBootData = Record<string, unknown>;

/** Minimal structural MessagePort — satisfied by node:worker_threads ports
 * on both sides of a MessageChannel. */
export interface PortLike {
  postMessage(value: unknown, transferList?: readonly ArrayBuffer[]): void;
  on(event: "message", listener: (value: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  close(): void;
}

export interface WorkerHandle {
  readonly port: PortLike;
  /** Messages posted to this worker so far. */
  readonly postCount: number;
  /** Most recent stats the worker attached to a reply envelope. */
  readonly lastWorkerStats: WorkerStats | undefined;
  /** Posts one envelope; returns its seq (the worker echoes it back). */
  postBatch(batch: CommandBatch, transfer?: readonly ArrayBuffer[]): number;
  terminate(): Promise<number>;
  onMessage(cb: (env: MessageEnvelope) => void): void;
  onError(cb: (err: Error) => void): void;
  onExit(cb: (code: number) => void): void;
  /** Resolves with the exit code once the worker has exited. */
  waitExit(): Promise<number>;
}

export interface WorkerAdapter {
  spawn(entry: URL, data: WorkerBootData): WorkerHandle;
}
