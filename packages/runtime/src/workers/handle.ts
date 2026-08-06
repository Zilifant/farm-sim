import type { CommandBatch, MessageEnvelope, WorkerStats } from "../messaging/types.js";
import { assertDetached } from "../messaging/transfer.js";
import type { PortLike, WorkerHandle } from "./types.js";

export abstract class BaseWorkerHandle implements WorkerHandle {
  readonly port: PortLike;
  #seq = 0;
  #postCount = 0;
  #lastWorkerStats: WorkerStats | undefined;
  #exited = false;
  #exitCode = 0;
  readonly #messageCbs: Array<(env: MessageEnvelope) => void> = [];
  readonly #errorCbs: Array<(err: Error) => void> = [];
  readonly #exitCbs: Array<(code: number) => void> = [];
  readonly #exitPromise: Promise<number>;
  #resolveExit!: (code: number) => void;

  protected constructor(port: PortLike) {
    this.port = port;
    this.#exitPromise = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
    port.on("message", (value) => {
      const env = value as MessageEnvelope;
      if (env.stats !== undefined) {
        this.#lastWorkerStats = env.stats;
      }
      for (const cb of this.#messageCbs) {
        cb(env);
      }
    });
  }

  get postCount(): number {
    return this.#postCount;
  }

  get lastWorkerStats(): WorkerStats | undefined {
    return this.#lastWorkerStats;
  }

  get exited(): boolean {
    return this.#exited;
  }

  postBatch(batch: CommandBatch, transfer: readonly ArrayBuffer[] = []): number {
    this.#seq += 1;
    this.#postCount += 1;
    const env: MessageEnvelope = { seq: this.#seq, batch };
    this.port.postMessage(env, transfer);
    assertDetached(transfer);
    return this.#seq;
  }

  onMessage(cb: (env: MessageEnvelope) => void): void {
    this.#messageCbs.push(cb);
  }

  onError(cb: (err: Error) => void): void {
    this.#errorCbs.push(cb);
  }

  onExit(cb: (code: number) => void): void {
    if (this.#exited) {
      cb(this.#exitCode);
      return;
    }
    this.#exitCbs.push(cb);
  }

  waitExit(): Promise<number> {
    return this.#exitPromise;
  }

  protected fireError(err: Error): void {
    for (const cb of this.#errorCbs) {
      cb(err);
    }
  }

  protected fireExit(code: number): void {
    if (this.#exited) {
      return;
    }
    this.#exited = true;
    this.#exitCode = code;
    this.#resolveExit(code);
    for (const cb of this.#exitCbs) {
      cb(code);
    }
  }

  abstract terminate(): Promise<number>;
}
