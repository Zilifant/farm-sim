import { describe, expect, it } from "vitest";
import { WriteGuard } from "@sim/runtime";
import {
  WaTorSharedRegion,
  createParallelWaTorSim,
  createSharedWaTorSim,
  createWaTorSim,
  resolveConfig,
} from "@sim/refsim";

const CFG = { width: 30, height: 30, seed: "phase3" };

describe("SAB Wa-Tor (Phase 3 acceptance)", () => {
  it("SAB path matches sequential and message-passing hashes at 1/2/4 workers", async () => {
    const ticks = 500;
    const seq = await createWaTorSim(CFG);
    seq.run(ticks);
    const expected = seq.stateHash();

    const msg = await createParallelWaTorSim({ ...CFG, workers: 2 });
    await msg.run(ticks);
    expect(await msg.stateHash()).toBe(expected);
    await msg.shutdown();

    for (const workers of [1, 2, 4]) {
      const sim = await createSharedWaTorSim({ ...CFG, workers, batchTicks: 64 });
      await sim.run(ticks);
      expect(sim.stateHash()).toBe(expected);
      expect(sim.populations()).toEqual(seq.populations());
      const codes = await sim.shutdown();
      expect(codes).toEqual(new Array<number>(workers).fill(0));
    }
  }, 60_000);

  it("repeated SAB runs are identical", async () => {
    const hashes: number[] = [];
    for (let i = 0; i < 2; i += 1) {
      const sim = await createSharedWaTorSim({ ...CFG, workers: 2 });
      await sim.run(300);
      hashes.push(sim.stateHash());
      await sim.shutdown();
    }
    expect(hashes[1]).toBe(hashes[0]);
  }, 30_000);

  it("reading state mid-run does not perturb the simulation", async () => {
    const uninterrupted = await createSharedWaTorSim({ ...CFG, workers: 2 });
    await uninterrupted.run(200);
    const expected = uninterrupted.stateHash();
    await uninterrupted.shutdown();

    const interrupted = await createSharedWaTorSim({ ...CFG, workers: 2 });
    await interrupted.run(100);
    interrupted.stateHash();
    interrupted.populations();
    await interrupted.run(100);
    expect(interrupted.stateHash()).toBe(expected);
    await interrupted.shutdown();
  }, 30_000);

  it("one exchange per batch, not per tick", async () => {
    const sim = await createSharedWaTorSim({ ...CFG, workers: 2, batchTicks: 100 });
    await sim.run(500);
    const stats = sim.stats();
    expect(stats.ticks).toBe(500);
    expect(stats.batches).toBe(5);
    for (const w of stats.perWorker) {
      // 1 seed-sync barrier + 5 batches — nothing per-tick.
      expect(w.mainPosts).toBe(6);
      expect(w.workerPosts).toBe(6);
    }
    await sim.shutdown();
  }, 30_000);

  it("profileTicks collects one per-tick compute timing per tick", async () => {
    const sim = await createSharedWaTorSim({ ...CFG, workers: 2, batchTicks: 40, profileTicks: true });
    await sim.run(100);
    const timings = sim.tickTimingsMs();
    expect(timings).toHaveLength(100);
    expect(timings.every((t) => t >= 0)).toBe(true);
    expect(timings.some((t) => t > 0)).toBe(true);
    await sim.shutdown();
  }, 30_000);

  it("debug write-guard mode produces the identical hash", async () => {
    const seq = await createWaTorSim(CFG);
    seq.run(200);
    const sim = await createSharedWaTorSim({ ...CFG, workers: 2, debug: true });
    await sim.run(200);
    expect(sim.stateHash()).toBe(seq.stateHash());
    await sim.shutdown();
  }, 30_000);

  it("debug mode throws on an out-of-range write (mis-scoped guard)", () => {
    // A region owning rows 0..4 of a 10x10 grid, but guarded as if it may
    // only write its owned rows — the first cross-border migration into a
    // spill row must throw rather than silently corrupt a neighbor.
    const cfg = resolveConfig({ width: 10, height: 10, seed: "guard-violation" });
    const cells = cfg.width * cfg.height;
    const region = new WaTorSharedRegion({
      cfg,
      rowStart: 0,
      rowCount: 5,
      species: new Uint8Array(cells),
      energy: new Int16Array(cells),
      breedAge: new Int16Array(cells),
      guard: new WriteGuard([{ start: 0, end: 5 * cfg.width }], "test worker"),
    });
    region.seedOwnRows();
    expect(() => {
      for (let t = 0n; t < 200n; t += 1n) {
        region.runTick(t);
      }
    }).toThrow(/out-of-range write/);
  });
});
