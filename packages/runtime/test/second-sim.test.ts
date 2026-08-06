// Phase 7 boundary test: a complete second simulation built from
// @sim/runtime alone — the code mirrors the skeleton in
// docs/building-a-sim.md. If this file ever needs a refsim import, the
// extraction boundary is wrong (and the lint rule will say so).
//
// The sim: `walkers` random walkers on a ring of `ring` cells; each tick
// every walker steps left or right (counter-hash randomness) and deposits
// one unit of heat where it lands. A gauge system reports total heat every
// 5 ticks.

import { describe, expect, it } from "vitest";
import {
  BufferRegistry,
  Sfc32Stream,
  SimEventQueue,
  SystemScheduler,
  TickExecutor,
  bufferId,
  hashBuffers,
  hashCell,
  restoreInto,
  seedToU32,
  snapshotBuffer,
  splitTick,
  type Snapshot,
  type System,
  type SystemContext,
} from "@sim/runtime";

const POS = bufferId("drift.pos");
const HEAT = bufferId("drift.heat");

interface DriftConfig {
  readonly ring: number;
  readonly walkers: number;
  readonly seed: string;
}

class WalkSystem implements System {
  readonly id = "drift.walk";
  readonly everyNTicks = 1;
  readonly reads = [POS, HEAT];
  readonly writes = [POS, HEAT];
  readonly #cfg: DriftConfig;
  readonly #seedHash: number;
  #pos!: Int32Array;
  #heat!: Int32Array;

  constructor(cfg: DriftConfig) {
    this.#cfg = cfg;
    this.#seedHash = seedToU32(cfg.seed);
  }

  init(ctx: SystemContext): void {
    this.#pos = ctx.buffer<Int32Array>(POS);
    this.#heat = ctx.buffer<Int32Array>(HEAT);
    // Stream randomness is fine for one-shot setup; per-tick decisions
    // below use counter hashes so results never depend on draw order.
    const rng = ctx.rng.fork("init");
    for (let i = 0; i < this.#pos.length; i += 1) {
      this.#pos[i] = rng.nextU32() % this.#cfg.ring;
    }
  }

  update(ctx: SystemContext): void {
    const { lo, hi } = splitTick(ctx.tick);
    const ring = this.#cfg.ring;
    for (let i = 0; i < this.#pos.length; i += 1) {
      const step = (hashCell(this.#seedHash, lo, hi, i, 1) & 1) === 0 ? -1 : 1;
      const next = (this.#pos[i]! + step + ring) % ring;
      this.#pos[i] = next;
      this.#heat[next] = this.#heat[next]! + 1;
    }
  }
}

interface HeatEvent {
  readonly tick: bigint;
  readonly total: number;
}

class GaugeSystem implements System {
  readonly id = "drift.gauge";
  readonly everyNTicks = 5;
  readonly reads = [HEAT];
  readonly writes: never[] = [];
  readonly #events: SimEventQueue<HeatEvent>;
  #heat!: Int32Array;

  constructor(events: SimEventQueue<HeatEvent>) {
    this.#events = events;
  }

  init(ctx: SystemContext): void {
    this.#heat = ctx.buffer<Int32Array>(HEAT);
  }

  update(ctx: SystemContext): void {
    let total = 0;
    for (let i = 0; i < this.#heat.length; i += 1) {
      total += this.#heat[i]!;
    }
    this.#events.emit({ tick: ctx.tick, total });
  }
}

interface DriftSim {
  readonly tick: bigint;
  readonly events: SimEventQueue<HeatEvent>;
  run(ticks: number): void;
  stateHash(): number;
  capture(): Snapshot;
  restore(s: Snapshot): void;
}

async function createDriftSim(cfg: DriftConfig): Promise<DriftSim> {
  const buffers = new BufferRegistry();
  buffers.define(POS, { type: Int32Array, length: cfg.walkers });
  buffers.define(HEAT, { type: Int32Array, length: cfg.ring });

  const events = new SimEventQueue<HeatEvent>();
  const scheduler = new SystemScheduler(buffers);
  scheduler.register(new WalkSystem(cfg));
  scheduler.register(new GaugeSystem(events));

  const executor = new TickExecutor({
    plan: scheduler.plan(),
    buffers,
    rng: Sfc32Stream.create(cfg.seed, "drift"),
    fixedDtMs: 1000 / 60,
  });
  await executor.init();

  let tick = 0n;
  const pos = buffers.get<Int32Array>(POS);
  const heat = buffers.get<Int32Array>(HEAT);

  return {
    get tick(): bigint {
      return tick;
    },
    events,
    run(ticks: number): void {
      for (let i = 0; i < ticks; i += 1) {
        executor.runTick(tick);
        tick += 1n;
      }
    },
    stateHash: () => hashBuffers([pos, heat]),
    capture: (): Snapshot => ({
      schemaVersion: 1,
      tick,
      meta: { cfg },
      buffers: { [POS]: snapshotBuffer(pos), [HEAT]: snapshotBuffer(heat) },
    }),
    restore(s: Snapshot): void {
      restoreInto(pos, s.buffers[POS]!);
      restoreInto(heat, s.buffers[HEAT]!);
      tick = s.tick;
    },
  };
}

const CFG: DriftConfig = { ring: 64, walkers: 10, seed: "boundary" };

describe("second sim skeleton (Phase 7 boundary test)", () => {
  it("is deterministic across repeated runs", async () => {
    const hashes: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const sim = await createDriftSim(CFG);
      sim.run(500);
      hashes.push(sim.stateHash());
    }
    expect(hashes[1]).toBe(hashes[0]);
    expect(hashes[2]).toBe(hashes[0]);
  });

  it("diverges across seeds", async () => {
    const a = await createDriftSim(CFG);
    const b = await createDriftSim({ ...CFG, seed: "other" });
    a.run(100);
    b.run(100);
    expect(a.stateHash()).not.toBe(b.stateHash());
  });

  it("snapshot at T restores to the uninterrupted 2T hash", async () => {
    const uninterrupted = await createDriftSim(CFG);
    uninterrupted.run(500);

    const source = await createDriftSim(CFG);
    source.run(250);
    const snap = source.capture();
    source.run(1234); // prove the snapshot is an independent copy

    const restored = await createDriftSim(CFG);
    restored.restore(snap);
    expect(restored.tick).toBe(250n);
    restored.run(250);
    expect(restored.stateHash()).toBe(uninterrupted.stateHash());
  });

  it("gauge events fire on their cadence with conserved totals", async () => {
    const sim = await createDriftSim(CFG);
    sim.run(21);
    const seen: HeatEvent[] = [];
    sim.events.drain((e) => seen.push(e));
    expect(seen.map((e) => e.tick)).toEqual([0n, 5n, 10n, 15n, 20n]);
    // Walkers deposit exactly `walkers` heat per tick; gauge runs after the
    // walk on the same tick, so tick t reports (t+1) * walkers.
    expect(seen.map((e) => e.total)).toEqual(
      [1n, 6n, 11n, 16n, 21n].map((t) => Number(t) * CFG.walkers),
    );
  });
});
