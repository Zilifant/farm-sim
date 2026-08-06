// Phase 5 acceptance: injected worker crashes fail fast with a diagnostic
// (no hang, no orphan), shutdown always resolves within its timeout, and the
// SAB driver's restart-from-last-snapshot recovery deterministically
// re-simulates through a crash. Real worker threads throughout — pool.crash
// exits the worker process abruptly.

import { describe, expect, it } from "vitest";
import {
  createParallelWaTorSim,
  createSharedWaTorSim,
  createWaTorSim,
} from "@sim/refsim";

const CFG = { width: 30, height: 30, seed: "phase5" };

describe("fail-fast (Phase 5 acceptance)", () => {
  it("SAB mode: injected crash rejects with a diagnostic and leaves no orphans", async () => {
    const sim = await createSharedWaTorSim({ ...CFG, workers: 2, batchTicks: 50 });
    await sim.run(100);
    sim.injectCrash(0, 7);
    await expect(sim.run(100)).rejects.toThrow(/worker 0/);

    // Every worker accounted for: the crashed one with its own exit code,
    // the survivor terminated by the policy. No hang, no orphan.
    const codes = await sim.shutdown();
    expect(codes).toEqual([7, 1]);
  }, 30_000);

  it("message-passing mode: injected crash rejects and shuts down cleanly", async () => {
    const sim = await createParallelWaTorSim({ ...CFG, workers: 2 });
    await sim.run(50);
    sim.injectCrash(1, 5);
    await expect(sim.run(50)).rejects.toThrow(/worker 1/);
    const codes = await sim.shutdown();
    expect(codes).toEqual([1, 5]);
  }, 30_000);

  it("a dead sibling does not deadlock a worker blocked at the tick barrier", async () => {
    // Worker 0 dies before its batch; worker 1 starts the batch and blocks
    // at the tick barrier waiting for it. Fail-fast must terminate worker 1
    // long before the 60s barrier timeout would fire.
    const sim = await createSharedWaTorSim({
      ...CFG,
      workers: 2,
      batchTicks: 5000,
      barrierTimeoutMs: 60_000,
    });
    sim.injectCrash(0);
    const t0 = Date.now();
    await expect(sim.run(5000)).rejects.toThrow(/worker 0/);
    const codes = await sim.shutdown();
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(codes).toHaveLength(2);
  }, 30_000);
});

describe("restart-from-last-snapshot (Phase 5)", () => {
  it("recovers from a crash and reaches the uninterrupted hash", async () => {
    const uninterrupted = await createWaTorSim(CFG);
    uninterrupted.run(300);

    const sim = await createSharedWaTorSim({
      ...CFG,
      workers: 2,
      batchTicks: 50,
      recovery: { snapshotEveryTicks: 100 },
    });
    await sim.run(150); // snapshots at ticks 0 and 100
    sim.injectCrash(1, 9);
    await sim.run(150); // crash surfaces here; recovery replays 100→300

    expect(sim.tick).toBe(300n);
    expect(sim.stats().restarts).toBe(1);
    expect(sim.stateHash()).toBe(uninterrupted.stateHash());
    expect(await sim.shutdown()).toEqual([0, 0]);
  }, 30_000);

  it("gives up once the restart budget is exhausted", async () => {
    const sim = await createSharedWaTorSim({
      ...CFG,
      workers: 2,
      batchTicks: 50,
      recovery: { snapshotEveryTicks: 100, maxRestarts: 1 },
    });
    await sim.run(100);
    sim.injectCrash(0);
    await sim.run(100); // first crash: recovered
    expect(sim.stats().restarts).toBe(1);
    sim.injectCrash(0);
    await expect(sim.run(100)).rejects.toThrow(/worker 0/);
    const codes = await sim.shutdown();
    expect(codes).toHaveLength(2);
  }, 30_000);
});
