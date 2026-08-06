import { MessageChannel, Worker } from "node:worker_threads";
import { BaseWorkerHandle } from "./handle.js";
import type { PortLike, WorkerAdapter, WorkerBootData, WorkerHandle } from "./types.js";

/**
 * Spawns real node:worker_threads workers. Each worker receives, via
 * workerData, `{ port, boot }` where `port` is its end of a dedicated
 * MessageChannel — worker entry files pass both to their setup function.
 * Entry files must be compiled .js (the repo's build-first workflow).
 */
export class NodeWorkerAdapter implements WorkerAdapter {
  readonly #execArgv: readonly string[];

  /** Workers run plain compiled ESM: the parent's execArgv (test-runner
   * flags, --input-type, loaders) is not inherited unless explicitly given. */
  constructor(opts: { execArgv?: readonly string[] } = {}) {
    this.#execArgv = opts.execArgv ?? [];
  }

  spawn(entry: URL, data: WorkerBootData): WorkerHandle {
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(entry, {
      workerData: { port: port2, boot: data },
      transferList: [port2],
      execArgv: [...this.#execArgv],
    });
    return new NodeWorkerHandle(worker, port1 as unknown as PortLike);
  }
}

class NodeWorkerHandle extends BaseWorkerHandle {
  readonly #worker: Worker;

  constructor(worker: Worker, port: PortLike) {
    super(port);
    this.#worker = worker;
    worker.on("error", (err) => this.fireError(err));
    worker.on("messageerror", (err) => this.fireError(err));
    worker.on("exit", (code) => {
      this.port.close();
      this.fireExit(code);
    });
  }

  async terminate(): Promise<number> {
    if (this.exited) {
      return this.waitExit();
    }
    await this.#worker.terminate();
    return this.waitExit();
  }
}
