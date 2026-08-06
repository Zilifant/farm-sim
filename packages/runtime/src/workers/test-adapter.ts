import { MessageChannel } from "node:worker_threads";
import { BaseWorkerHandle } from "./handle.js";
import type { PortLike, WorkerAdapter, WorkerBootData, WorkerHandle } from "./types.js";

export type TestWorkerFactory = (
  port: PortLike,
  boot: WorkerBootData,
  entry: URL,
) => void;

/**
 * Runs "workers" in-process over real MessageChannels — same protocol, no
 * threads. Keeps concurrency tests fast and debuggable; jitter or fault
 * injection lives in the factory the test supplies.
 */
export class TestWorkerAdapter implements WorkerAdapter {
  readonly #factory: TestWorkerFactory;
  readonly spawned: TestWorkerHandle[] = [];

  constructor(factory: TestWorkerFactory) {
    this.#factory = factory;
  }

  spawn(entry: URL, data: WorkerBootData): WorkerHandle {
    const { port1, port2 } = new MessageChannel();
    this.#factory(port2 as unknown as PortLike, data, entry);
    const handle = new TestWorkerHandle(port1 as unknown as PortLike);
    this.spawned.push(handle);
    return handle;
  }
}

export class TestWorkerHandle extends BaseWorkerHandle {
  #terminated = false;

  constructor(port: PortLike) {
    super(port);
    port.on("close", () => {
      this.fireExit(this.#terminated ? 1 : 0);
    });
  }

  terminate(): Promise<number> {
    if (!this.exited) {
      this.#terminated = true;
      this.port.close();
    }
    return this.waitExit();
  }

  /** Test seam: emulate a worker crash — an error event followed by an
   * abrupt nonzero exit (the in-process stand-in for pool.crash). */
  simulateCrash(err = new Error("simulated crash")): Promise<number> {
    this.fireError(err);
    return this.terminate();
  }
}
