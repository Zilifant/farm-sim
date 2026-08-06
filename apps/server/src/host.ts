// Owns the running simulation: a Wa-Tor sim driven continuously by a
// FixedStepClock. Deliberately independent of HTTP — the Express app and the
// WebSocket layer hold a reference to a SimHost, never the other way around,
// so closing the server leaves the simulation ticking. Uses only the public
// @sim/runtime and @sim/refsim APIs.

import { FixedStepClock, decodeSnapshot, encodeSnapshot, viewFromSnapshotBuffer } from "@sim/runtime";
import {
  BREED_AGE,
  ENERGY,
  SPECIES,
  createWaTorSim,
  type CensusEvent,
  type SpawnOptions,
  type WaTorConfig,
  type WaTorSim,
} from "@sim/refsim";

export interface SimHostOptions extends Partial<WaTorConfig> {
  /** Sim-time per tick; wall pace = fixedDtMs / speed. Default 60 tps. */
  readonly fixedDtMs?: number;
}

export interface SimStatus {
  readonly tick: string;
  readonly running: boolean;
  readonly speed: number;
  readonly fish: number;
  readonly sharks: number;
  readonly stateHash: string;
  readonly lastCensus: { tick: string; fish: number; sharks: number } | null;
}

/** One census reading, sequenced for the renderer's event feed. */
export interface CensusRecord {
  readonly seq: number;
  readonly type: "census";
  readonly tick: number;
  readonly fish: number;
  readonly sharks: number;
}

const CENSUS_RING_LIMIT = 512;

export class SimHost {
  readonly clock: FixedStepClock;
  #sim: WaTorSim;
  #config: Partial<WaTorConfig>;
  #restarts = 0;
  #lastCensus: CensusEvent | null = null;
  #censusRing: CensusRecord[] = [];
  #nextSeq = 1;

  private constructor(sim: WaTorSim, config: Partial<WaTorConfig>, fixedDtMs: number) {
    this.#sim = sim;
    this.#config = config;
    this.clock = new FixedStepClock({
      fixedDtMs,
      onTick: () => {
        this.#sim.step();
        this.#sim.census.drain((e) => {
          this.#lastCensus = e;
          this.#censusRing.push({
            seq: this.#nextSeq,
            type: "census",
            tick: Number(e.tick),
            fish: e.fish,
            sharks: e.sharks,
          });
          this.#nextSeq += 1;
          if (this.#censusRing.length > CENSUS_RING_LIMIT) {
            this.#censusRing.splice(0, this.#censusRing.length - CENSUS_RING_LIMIT);
          }
        });
      },
    });
  }

  static async create(opts: SimHostOptions = {}): Promise<SimHost> {
    const { fixedDtMs = 1000 / 60, ...cfg } = opts;
    return new SimHost(await createWaTorSim(cfg), cfg, fixedDtMs);
  }

  get sim(): WaTorSim {
    return this.#sim;
  }

  /** Changes on every restart — a renderer must drop state it holds about the
   * old world when this moves. */
  get simulationId(): string {
    return `wator-${String(this.#sim.config.seed)}-${this.#restarts}`;
  }

  get seed(): number | string {
    return this.#sim.config.seed;
  }

  /** Census events at or after `sinceSeq`, oldest first. */
  censusSince(sinceSeq: number): CensusRecord[] {
    return this.#censusRing.filter((e) => e.seq >= sinceSeq);
  }

  status(): SimStatus {
    const { fish, sharks } = this.#sim.populations();
    const census = this.#lastCensus;
    return {
      tick: this.#sim.tick.toString(),
      running: this.clock.running,
      speed: this.clock.speed,
      fish,
      sharks,
      stateHash: `0x${this.#sim.stateHash().toString(16).padStart(8, "0")}`,
      lastCensus:
        census === null
          ? null
          : { tick: census.tick.toString(), fish: census.fish, sharks: census.sharks },
    };
  }

  start(): void {
    this.clock.start();
  }

  pause(): void {
    this.clock.pause();
  }

  stepOnce(): Promise<void> {
    return this.clock.stepOnce();
  }

  /** Advance N ticks immediately; requires a paused clock. */
  async stepTicks(ticks: number): Promise<void> {
    if (!Number.isInteger(ticks) || ticks < 1 || ticks > 10_000) {
      throw new Error("ticks must be a whole number in [1, 10000]");
    }
    for (let i = 0; i < ticks; i += 1) {
      await this.clock.stepOnce();
    }
  }

  setSpeed(speed: number): void {
    this.clock.speed = speed;
  }

  spawn(opts: SpawnOptions): void {
    this.#sim.spawn(opts);
  }

  /**
   * Rebuild the world from a seed (host-picked when omitted), keeping the
   * grid dimensions and rule parameters. The clock keeps its run state and
   * speed; the census feed restarts with the new simulationId.
   */
  async restart(seed?: number): Promise<void> {
    if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)) {
      throw new Error("seed must be a whole number in [0, 4294967295]");
    }
    const nextSeed = seed ?? Math.floor(Math.random() * 0x100000000);
    const wasRunning = this.clock.running;
    this.clock.pause();
    this.#sim = await createWaTorSim({ ...this.#config, seed: nextSeed });
    this.#restarts += 1;
    this.#lastCensus = null;
    this.#censusRing = [];
    this.#nextSeq = 1;
    if (wasRunning) {
      this.clock.start();
    }
  }

  /** One cell's full state — the renderer's inspection query. */
  cellInspect(x: number, y: number): { x: number; y: number; species: number; energy: number; breedAge: number } {
    const { width, height } = this.#sim.config;
    if (!Number.isInteger(x) || x < 0 || x >= width || !Number.isInteger(y) || y < 0 || y >= height) {
      throw new Error(`cell must be within the ${width}x${height} grid`);
    }
    const snapshot = this.#sim.captureSnapshot();
    const idx = y * width + x;
    return {
      x,
      y,
      species: viewFromSnapshotBuffer<Uint8Array>(snapshot.buffers[SPECIES]!)[idx]!,
      energy: viewFromSnapshotBuffer<Int16Array>(snapshot.buffers[ENERGY]!)[idx]!,
      breedAge: viewFromSnapshotBuffer<Int16Array>(snapshot.buffers[BREED_AGE]!)[idx]!,
    };
  }

  /** The species grid as base64 — the renderer's per-frame bulk payload. */
  speciesBase64(): string {
    const snapshot = this.#sim.captureSnapshot();
    const species = viewFromSnapshotBuffer<Uint8Array>(snapshot.buffers[SPECIES]!);
    return Buffer.from(species).toString("base64");
  }

  snapshotBytes(): Uint8Array {
    return encodeSnapshot(this.#sim.captureSnapshot());
  }

  restoreBytes(bytes: Uint8Array): void {
    this.#sim.restoreSnapshot(decodeSnapshot(bytes));
  }

  /** Stop driving the sim (used on process shutdown, not server close). */
  dispose(): void {
    this.clock.pause();
  }
}
