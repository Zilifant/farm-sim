import { describe, expect, it } from "vitest";
import { InMemoryReplayLog, decodeSnapshot, encodeSnapshot, type Snapshot } from "@sim/runtime";
import {
  COUNTER_MAX,
  FISH,
  SHARK,
  EMPTY,
  createParallelWaTorSim,
  createSharedWaTorSim,
  createWaTorSim,
  replayInto,
  watorMigrator,
  type WaTorConfig,
} from "@sim/refsim";

const CFG = { width: 30, height: 30, seed: "phase4" };
const T = 250;

describe("snapshots (Phase 4 acceptance)", () => {
  it("save at T → restore → run to 2T equals the uninterrupted run", async () => {
    const uninterrupted = await createWaTorSim(CFG);
    uninterrupted.run(2 * T);
    const expected = uninterrupted.stateHash();

    const source = await createWaTorSim(CFG);
    source.run(T);
    const snapshot = source.captureSnapshot();
    source.run(9999); // wreck the source to prove the snapshot is a copy

    const restored = await createWaTorSim(CFG);
    restored.restoreSnapshot(snapshot);
    expect(restored.tick).toBe(BigInt(T));
    restored.run(T);
    expect(restored.stateHash()).toBe(expected);
  });

  it("snapshots survive binary encode/decode", async () => {
    const uninterrupted = await createWaTorSim(CFG);
    uninterrupted.run(2 * T);

    const source = await createWaTorSim(CFG);
    source.run(T);
    const bytes = encodeSnapshot(source.captureSnapshot());
    const restored = await createWaTorSim(CFG);
    restored.restoreSnapshot(decodeSnapshot(bytes));
    restored.run(T);
    expect(restored.stateHash()).toBe(uninterrupted.stateHash());
  });

  it("snapshots move across execution modes", async () => {
    const uninterrupted = await createWaTorSim(CFG);
    uninterrupted.run(2 * T);
    const expected = uninterrupted.stateHash();

    // sequential capture → SAB restore
    const seq = await createWaTorSim(CFG);
    seq.run(T);
    const snap = seq.captureSnapshot();
    const sab = await createSharedWaTorSim({ ...CFG, workers: 2 });
    sab.restoreSnapshot(snap);
    await sab.run(T);
    expect(sab.stateHash()).toBe(expected);

    // SAB capture → message-passing restore
    const sabSnap = sab.captureSnapshot();
    expect(sabSnap.tick).toBe(BigInt(2 * T));
    const msg = await createParallelWaTorSim({ ...CFG, workers: 2 });
    await msg.restoreSnapshot(snap);
    await msg.run(T);
    expect(await msg.stateHash()).toBe(expected);

    await sab.shutdown();
    await msg.shutdown();
  }, 60_000);

  it("message-passing mode captures and restores mid-run", async () => {
    const uninterrupted = await createParallelWaTorSim({ ...CFG, workers: 2 });
    await uninterrupted.run(2 * T);
    const expected = await uninterrupted.stateHash();
    await uninterrupted.shutdown();

    const source = await createParallelWaTorSim({ ...CFG, workers: 2 });
    await source.run(T);
    const snapshot = await source.captureSnapshot();
    await source.shutdown();

    const restored = await createParallelWaTorSim({ ...CFG, workers: 2 });
    await restored.run(37); // restore must fully overwrite unrelated progress
    await restored.restoreSnapshot(snapshot);
    expect(restored.tick).toBe(BigInt(T));
    await restored.run(T);
    expect(await restored.stateHash()).toBe(expected);
    await restored.shutdown();
  }, 60_000);

  it("refuses to restore into a sim with a different config", async () => {
    const source = await createWaTorSim(CFG);
    source.run(10);
    const snapshot = source.captureSnapshot();
    const other = await createWaTorSim({ ...CFG, seed: "different" });
    expect(() => other.restoreSnapshot(snapshot)).toThrow(/differs in: seed/);
  });
});

describe("schema migration (Phase 4 acceptance)", () => {
  it("migrates a v1 snapshot (pre-sharkMaxEnergy) and restores it", async () => {
    // v1 semantics: unbounded energy banking, i.e. capped only by Int16.
    const v1EquivalentCfg = { ...CFG, sharkMaxEnergy: COUNTER_MAX };

    const uninterrupted = await createWaTorSim(v1EquivalentCfg);
    uninterrupted.run(2 * T);

    const source = await createWaTorSim(v1EquivalentCfg);
    source.run(T);
    const v2 = source.captureSnapshot();

    // Forge the v1 fixture: version 1, config without the field that
    // v2 introduced.
    const cfgV1 = { ...(v2.meta["cfg"] as WaTorConfig) } as Partial<WaTorConfig> & Record<string, unknown>;
    delete cfgV1["sharkMaxEnergy"];
    const v1: Snapshot = { ...v2, schemaVersion: 1, meta: { cfg: cfgV1 } };

    const migrated = watorMigrator.migrate(v1);
    expect(migrated.schemaVersion).toBe(2);
    expect((migrated.meta["cfg"] as WaTorConfig).sharkMaxEnergy).toBe(COUNTER_MAX);

    const restored = await createWaTorSim(v1EquivalentCfg);
    restored.restoreSnapshot(v1); // restoreSnapshot migrates internally
    restored.run(T);
    expect(restored.stateHash()).toBe(uninterrupted.stateHash());
  });

  it("rejects snapshots newer than the current schema", async () => {
    const sim = await createWaTorSim(CFG);
    const snapshot = sim.captureSnapshot();
    expect(() => sim.restoreSnapshot({ ...snapshot, schemaVersion: 99 })).toThrow(/newer/);
  });
});

describe("replay (Phase 4 acceptance)", () => {
  async function recordedRun(): Promise<{ hash: number; log: InMemoryReplayLog }> {
    const log = new InMemoryReplayLog();
    const sim = await createWaTorSim(CFG, { record: log });
    sim.run(50);
    sim.spawn({ x: 3, y: 4, species: SHARK });
    sim.spawn({ x: 20, y: 11, species: FISH });
    sim.run(70);
    sim.spawn({ x: 15, y: 15, species: EMPTY }); // kill disturbance
    sim.run(280);
    return { hash: sim.stateHash(), log };
  }

  it("replaying the command log reproduces the hash", async () => {
    const { hash, log } = await recordedRun();
    expect(log.size).toBe(3);

    const replayed = await createWaTorSim(CFG);
    await replayInto(replayed, log, 400n);
    expect(replayed.tick).toBe(400n);
    expect(replayed.stateHash()).toBe(hash);
  });

  it("replaying into the SAB mode reproduces the same hash", async () => {
    const { hash, log } = await recordedRun();
    const sab = await createSharedWaTorSim({ ...CFG, workers: 2, batchTicks: 32 });
    await replayInto(sab, log, 400n);
    expect(sab.stateHash()).toBe(hash);
    await sab.shutdown();
  }, 30_000);

  it("the commands actually alter the outcome", async () => {
    const { hash } = await recordedRun();
    const undisturbed = await createWaTorSim(CFG);
    undisturbed.run(400);
    expect(undisturbed.stateHash()).not.toBe(hash);
  });
});
