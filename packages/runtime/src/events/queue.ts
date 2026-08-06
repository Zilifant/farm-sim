// Buffered event queue: emits accumulate during a tick, consumers drain at
// the tick boundary. Events emitted while draining are delivered on the next
// drain, never re-entrantly.

export interface EventQueue<E> {
  emit(e: E): void;
  drain(handler: (e: E) => void): void;
}

export class SimEventQueue<E> implements EventQueue<E> {
  #pending: E[] = [];

  get size(): number {
    return this.#pending.length;
  }

  emit(e: E): void {
    this.#pending.push(e);
  }

  drain(handler: (e: E) => void): void {
    if (this.#pending.length === 0) {
      return;
    }
    const batch = this.#pending;
    this.#pending = [];
    for (const e of batch) {
      handler(e);
    }
  }
}
