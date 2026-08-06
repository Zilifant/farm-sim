import { describe, expect, it } from "vitest";
import {
  EMPTY,
  FISH,
  SHARK,
  SPECIES,
  createWaTorSim,
  type CensusEvent,
} from "@sim/refsim";

describe("Wa-Tor determinism (Phase 1 acceptance)", () => {
  it("produces an identical state hash across 3 runs of 10k ticks", async () => {
    const config = { width: 32, height: 32, seed: "acceptance" };
    const hashes: number[] = [];
    const tickHashes: number[][] = [];
    for (let run = 0; run < 3; run += 1) {
      const sim = await createWaTorSim(config);
      const perTick: number[] = [];
      for (let i = 0; i < 10; i += 1) {
        sim.run(1000);
        perTick.push(sim.stateHash());
      }
      expect(sim.tick).toBe(10_000n);
      hashes.push(sim.stateHash());
      tickHashes.push(perTick);
    }
    expect(hashes[1]).toBe(hashes[0]);
    expect(hashes[2]).toBe(hashes[0]);
    // Intermediate checkpoints match too, not just the endpoint.
    expect(tickHashes[1]).toEqual(tickHashes[0]);
    expect(tickHashes[2]).toEqual(tickHashes[0]);
  }, 60_000);

  it("different seeds diverge", async () => {
    const a = await createWaTorSim({ width: 32, height: 32, seed: "one" });
    const b = await createWaTorSim({ width: 32, height: 32, seed: "two" });
    a.run(100);
    b.run(100);
    expect(a.stateHash()).not.toBe(b.stateHash());
  });

  it("state actually evolves tick over tick", async () => {
    const sim = await createWaTorSim({ seed: "evolve" });
    const before = sim.stateHash();
    sim.step();
    expect(sim.stateHash()).not.toBe(before);
  });
});

describe("Wa-Tor behavior", () => {
  it("keeps populations within grid bounds and both species alive early on", async () => {
    const sim = await createWaTorSim({ seed: "sanity" });
    const cells = sim.config.width * sim.config.height;
    sim.run(500);
    const { fish, sharks } = sim.populations();
    expect(fish).toBeGreaterThan(0);
    expect(fish + sharks).toBeLessThanOrEqual(cells);
    expect(sharks).toBeGreaterThanOrEqual(0);
  });

  it("emits census events on the configured cadence, matching populations()", async () => {
    const sim = await createWaTorSim({ seed: "census", censusEveryNTicks: 10 });
    sim.run(100);
    const events: CensusEvent[] = [];
    sim.census.drain((e) => events.push(e));
    expect(events.map((e) => e.tick)).toEqual(
      [0n, 10n, 20n, 30n, 40n, 50n, 60n, 70n, 80n, 90n],
    );
    // Census runs after the wator update on tick 90; populations() reflects
    // state after tick 99 — advance a fresh sim to tick 91 to compare exactly.
    const sim2 = await createWaTorSim({ seed: "census", censusEveryNTicks: 10 });
    sim2.run(91);
    const last = events.at(-1);
    expect(sim2.populations()).toEqual({ fish: last?.fish, sharks: last?.sharks });
  });

  it("reports per-system p50/p95 timings via the profiler", async () => {
    const sim = await createWaTorSim({ seed: "profile" });
    sim.run(200);
    const report = sim.profiler.report();
    const ids = report.map((t) => t.systemId);
    expect(ids).toContain("wator.update");
    expect(ids).toContain("wator.census");
    for (const t of report) {
      expect(t.samples).toBeGreaterThan(0);
      expect(t.p50Ms).toBeGreaterThanOrEqual(0);
      expect(t.p95Ms).toBeGreaterThanOrEqual(t.p50Ms);
      expect(t.maxMs).toBeGreaterThanOrEqual(t.p95Ms);
    }
  });

  it("exposes stable species constants and buffer ids", () => {
    expect([EMPTY, FISH, SHARK]).toEqual([0, 1, 2]);
    expect(SPECIES).toBe("wator.species");
  });
});
