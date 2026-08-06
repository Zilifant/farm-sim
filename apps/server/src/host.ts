// Owns the running simulation: a Wa-Tor sim driven continuously by a
// FixedStepClock. Deliberately independent of HTTP — the Express app holds a
// reference to a SimHost, never the other way around, so closing the server
// leaves the simulation ticking. Uses only the public @sim/runtime and
// @sim/refsim APIs.

import { FixedStepClock, decodeSnapshot, encodeSnapshot } from "@sim/runtime";
import {
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

export class SimHost {
  readonly sim: WaTorSim;
  readonly clock: FixedStepClock;
  #lastCensus: CensusEvent | null = null;

  private constructor(sim: WaTorSim, fixedDtMs: number) {
    this.sim = sim;
    this.clock = new FixedStepClock({
      fixedDtMs,
      onTick: () => {
        this.sim.step();
        this.sim.census.drain((e) => {
          this.#lastCensus = e;
        });
      },
    });
  }

  static async create(opts: SimHostOptions = {}): Promise<SimHost> {
    const { fixedDtMs = 1000 / 60, ...cfg } = opts;
    return new SimHost(await createWaTorSim(cfg), fixedDtMs);
  }

  status(): SimStatus {
    const { fish, sharks } = this.sim.populations();
    const census = this.#lastCensus;
    return {
      tick: this.sim.tick.toString(),
      running: this.clock.running,
      speed: this.clock.speed,
      fish,
      sharks,
      stateHash: `0x${this.sim.stateHash().toString(16).padStart(8, "0")}`,
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

  setSpeed(speed: number): void {
    this.clock.speed = speed;
  }

  spawn(opts: SpawnOptions): void {
    this.sim.spawn(opts);
  }

  snapshotBytes(): Uint8Array {
    return encodeSnapshot(this.sim.captureSnapshot());
  }

  restoreBytes(bytes: Uint8Array): void {
    this.sim.restoreSnapshot(decodeSnapshot(bytes));
  }

  /** Stop driving the sim (used on process shutdown, not server close). */
  dispose(): void {
    this.clock.pause();
  }
}
