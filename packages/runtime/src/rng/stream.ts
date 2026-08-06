// Seeded, forkable RNG streams — one per (system, region); never Math.random.
// A stream's state is derived purely from (rootSeed, streamId), so forking is
// independent of how much the parent has been consumed.

import { seedToU32 } from "./counter.js";

export interface RngStream {
  readonly streamId: string;
  nextU32(): number;
  /** [0, 1), built from two u32 draws (53 mantissa bits) for determinism. */
  nextF64(): number;
  fork(childId: string): RngStream;
}

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

export class Sfc32Stream implements RngStream {
  readonly streamId: string;
  readonly #rootSeed: string;
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  private constructor(rootSeed: string, streamId: string) {
    this.#rootSeed = rootSeed;
    this.streamId = streamId;
    const mix = splitmix32(seedToU32(`${rootSeed}\u001f${streamId}`));
    this.#a = mix();
    this.#b = mix();
    this.#c = mix();
    this.#d = mix();
    for (let i = 0; i < 12; i += 1) {
      this.nextU32();
    }
  }

  static create(seed: number | string, streamId = "root"): Sfc32Stream {
    return new Sfc32Stream(String(seed), streamId);
  }

  nextU32(): number {
    const t = (((this.#a + this.#b) | 0) + this.#d) | 0;
    this.#d = (this.#d + 1) | 0;
    this.#a = this.#b ^ (this.#b >>> 9);
    this.#b = (this.#c + (this.#c << 3)) | 0;
    this.#c = ((this.#c << 21) | (this.#c >>> 11)) | 0;
    this.#c = (this.#c + t) | 0;
    return t >>> 0;
  }

  nextF64(): number {
    const hi = this.nextU32() >>> 5;
    const lo = this.nextU32() >>> 6;
    return (hi * 67108864 + lo) / 9007199254740992;
  }

  fork(childId: string): Sfc32Stream {
    if (childId.length === 0) {
      throw new Error("fork childId must be a non-empty string");
    }
    return new Sfc32Stream(this.#rootSeed, `${this.streamId}/${childId}`);
  }
}
