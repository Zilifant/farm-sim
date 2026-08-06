// Sense-reversing tick barrier over a SharedArrayBuffer. Workers block in
// Atomics.wait between ticks — no main-thread round trip per tick. The main
// thread must never be a party (Atomics.wait would block its event loop);
// it synchronizes with workers at batch boundaries via the message protocol.
// Every wait carries a timeout so a lost worker surfaces as an error, not a
// deadlock.

const COUNT = 0;
const GEN = 1;

export class AtomicsBarrier {
  static readonly BYTES = 8;

  readonly sab: SharedArrayBuffer;
  readonly parties: number;
  readonly #arr: Int32Array;
  readonly #defaultTimeoutMs: number;

  constructor(sab: SharedArrayBuffer, parties: number, defaultTimeoutMs = 10_000) {
    if (!Number.isInteger(parties) || parties < 1) {
      throw new Error("parties must be an integer >= 1");
    }
    this.sab = sab;
    this.parties = parties;
    this.#arr = new Int32Array(sab, 0, 2);
    this.#defaultTimeoutMs = defaultTimeoutMs;
  }

  static allocate(parties: number, defaultTimeoutMs?: number): AtomicsBarrier {
    return new AtomicsBarrier(new SharedArrayBuffer(AtomicsBarrier.BYTES), parties, defaultTimeoutMs);
  }

  /** Blocks until all parties arrive. Worker threads only (except the
   * degenerate single-party case, which returns immediately). */
  arrive(timeoutMs = this.#defaultTimeoutMs): void {
    const arr = this.#arr;
    const gen = Atomics.load(arr, GEN);
    const arrived = Atomics.add(arr, COUNT, 1) + 1;
    if (arrived === this.parties) {
      Atomics.store(arr, COUNT, 0);
      Atomics.add(arr, GEN, 1);
      Atomics.notify(arr, GEN);
      return;
    }
    const deadline = Date.now() + timeoutMs;
    while (Atomics.load(arr, GEN) === gen) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `barrier timeout after ${timeoutMs}ms (${Atomics.load(arr, COUNT)}/${this.parties} arrived)`,
        );
      }
      Atomics.wait(arr, GEN, gen, remaining);
    }
  }
}
