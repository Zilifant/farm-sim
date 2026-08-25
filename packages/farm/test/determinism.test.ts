// The determinism contract: (seed, config, command log) ⇒ identical state
// hash, across repeated runs and across save/restore. Same shape as the
// reference sim's suite.

import { describe, expect, it } from "vitest";
import { InMemoryReplayLog } from "@sim/runtime";
import {
  CORN, FARM_BORROW, FARM_SCHEDULE_OP, FARM_SELL, OP_FERTILIZE, OP_HARVEST, OP_PLANT,
  SOYBEANS, createFarmSim, type FarmCommand, type FarmSim,
} from "@sim/farm";

/** A scripted 400-day run with commands at fixed ticks. */
async function scriptedRun(seed: number | string): Promise<FarmSim> {
  const sim = await createFarmSim({ seed });
  const at = (day: number, cmd: FarmCommand): void => {
    while (Number(sim.tick) < day) {
      sim.step();
    }
    sim.apply(cmd);
  };
  at(5, { kind: FARM_BORROW, amount: 50_000 });
  at(10, { kind: FARM_SCHEDULE_OP, op: OP_PLANT, field: 0, crop: CORN });
  at(10, { kind: FARM_SCHEDULE_OP, op: OP_FERTILIZE, field: 0, crop: 0 });
  at(12, { kind: FARM_SCHEDULE_OP, op: OP_PLANT, field: 1, crop: SOYBEANS });
  at(180, { kind: FARM_SCHEDULE_OP, op: OP_HARVEST, field: 0, crop: 0 });
  at(180, { kind: FARM_SCHEDULE_OP, op: OP_HARVEST, field: 1, crop: 0 });
  at(300, { kind: FARM_SELL, crop: CORN, units: 1000 });
  while (Number(sim.tick) < 400) {
    sim.step();
  }
  return sim;
}

describe("determinism", () => {
  it("identical hash across repeated scripted runs", async () => {
    const a = await scriptedRun("det");
    const b = await scriptedRun("det");
    expect(a.stateHash()).toBe(b.stateHash());
    expect(a.stateHash()).not.toBe(0);
  });

  it("different seeds diverge", async () => {
    const a = await scriptedRun(1);
    const b = await scriptedRun(2);
    expect(a.stateHash()).not.toBe(b.stateHash());
  });

  it("save at T → restore → run to 2T equals an uninterrupted run", async () => {
    const uninterrupted = await createFarmSim({ seed: "snap" });
    uninterrupted.run(400);

    const first = await createFarmSim({ seed: "snap" });
    first.run(200);
    const snapshot = first.captureSnapshot();
    first.run(37); // advance past the capture point — restore must rewind this

    const resumed = await createFarmSim({ seed: "snap" });
    resumed.restoreSnapshot(snapshot);
    expect(resumed.tick).toBe(200n);
    resumed.run(200);
    expect(resumed.stateHash()).toBe(uninterrupted.stateHash());
  });

  it("restore rejects a mismatched config", async () => {
    const a = await createFarmSim({ seed: "one" });
    const b = await createFarmSim({ seed: "two" });
    expect(() => b.restoreSnapshot(a.captureSnapshot())).toThrow(/differs in: seed/);
  });

  it("a recorded command log reproduces the run", async () => {
    const log = new InMemoryReplayLog();
    const original = await createFarmSim({ seed: "replay" }, { record: log });
    original.run(8);
    original.apply({ kind: FARM_BORROW, amount: 25_000 });
    original.run(100);
    original.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field: 3, crop: CORN });
    original.run(292);
    expect(log.size).toBe(2);

    const replayed = await createFarmSim({ seed: "replay" });
    for (const [tick, batch] of log.entries()) {
      replayed.run(Number(tick) - Number(replayed.tick));
      for (const cmd of batch.commands) {
        replayed.apply(cmd as FarmCommand);
      }
    }
    replayed.run(400 - Number(replayed.tick));
    expect(replayed.stateHash()).toBe(original.stateHash());
  });

  it("commands change the trajectory", async () => {
    const quiet = await createFarmSim({ seed: "traj" });
    quiet.run(400);
    const active = await scriptedRun("traj");
    expect(active.stateHash()).not.toBe(quiet.stateHash());
  });
});
