import { describe, expect, it } from "vitest";
import { TestWorkerAdapter } from "@sim/runtime";
import {
  createParallelWaTorSim,
  createWaTorSim,
  partitionRows,
  setupWaTorWorker,
} from "@sim/refsim";

const CFG = { width: 30, height: 30, seed: "phase2" };

describe("Parallel Wa-Tor (Phase 2 acceptance)", () => {
  it("1, 2, and 4 workers produce the same hash as the single-threaded sim", async () => {
    const ticks = 500;
    const seq = await createWaTorSim(CFG);
    seq.run(ticks);
    const expected = seq.stateHash();

    for (const workers of [1, 2, 4]) {
      const sim = await createParallelWaTorSim({ ...CFG, workers });
      await sim.run(ticks);
      expect(await sim.stateHash()).toBe(expected);
      const codes = await sim.shutdown();
      expect(codes).toEqual(new Array<number>(workers).fill(0));
    }
  }, 60_000);

  it("posts exactly one message per worker per tick, each direction", async () => {
    const ticks = 100;
    const sim = await createParallelWaTorSim({ ...CFG, workers: 2 });
    await sim.run(ticks);
    await sim.stateHash(); // one extra exchange for the snapshot gather
    const stats = sim.stats();
    expect(stats.ticks).toBe(ticks);
    expect(stats.snapshots).toBe(1);
    for (const w of stats.perWorker) {
      expect(w.mainPosts).toBe(ticks + 1);
      expect(w.workerPosts).toBe(ticks + 1);
    }
    await sim.shutdown();
  }, 30_000);

  it("a mid-run snapshot does not perturb the simulation", async () => {
    const uninterrupted = await createParallelWaTorSim({ ...CFG, workers: 2 });
    await uninterrupted.run(200);
    const expected = await uninterrupted.stateHash();
    await uninterrupted.shutdown();

    const interrupted = await createParallelWaTorSim({ ...CFG, workers: 2 });
    await interrupted.run(100);
    await interrupted.stateHash(); // consumes pending borders via applyBorders
    await interrupted.run(100);
    expect(await interrupted.stateHash()).toBe(expected);
    await interrupted.shutdown();
  }, 30_000);

  it("runs in-process through TestWorkerAdapter with identical results", async () => {
    const seq = await createWaTorSim(CFG);
    seq.run(100);
    const adapter = new TestWorkerAdapter((port, boot) => setupWaTorWorker(port, boot));
    const sim = await createParallelWaTorSim({ ...CFG, workers: 3, adapter });
    await sim.run(100);
    expect(await sim.stateHash()).toBe(seq.stateHash());
    expect(await sim.populations()).toEqual(seq.populations());
    await sim.shutdown();
  });
});

describe("partitionRows", () => {
  it("assigns contiguous strips covering every row exactly once", () => {
    expect(partitionRows(30, 4)).toEqual([
      { start: 0, count: 8 },
      { start: 8, count: 8 },
      { start: 16, count: 7 },
      { start: 23, count: 7 },
    ]);
    expect(partitionRows(10, 1)).toEqual([{ start: 0, count: 10 }]);
  });

  it("rejects partitions with strips shorter than 2 rows", () => {
    expect(() => partitionRows(5, 3)).toThrow(/>= 2 rows/);
  });
});
