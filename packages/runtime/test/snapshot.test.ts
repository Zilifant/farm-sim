import { describe, expect, it } from "vitest";
import {
  InMemoryReplayLog,
  SnapshotMigrator,
  decodeSnapshot,
  encodeSnapshot,
  restoreInto,
  snapshotBuffer,
  viewFromSnapshotBuffer,
  type Snapshot,
} from "@sim/runtime";

function sample(): Snapshot {
  return {
    schemaVersion: 3,
    tick: 0x1_2345_6789n, // exercises the u64 tick field
    meta: { cfg: { width: 5, seed: "s" }, note: "hello" },
    buffers: {
      "grid.species": snapshotBuffer(new Uint8Array([1, 2, 3])),
      "grid.energy": snapshotBuffer(new Int16Array([-5, 300, 7, 9])),
    },
  };
}

describe("snapshot codec", () => {
  it("binary round trip preserves everything", () => {
    const s = sample();
    const decoded = decodeSnapshot(encodeSnapshot(s));
    expect(decoded.schemaVersion).toBe(3);
    expect(decoded.tick).toBe(0x1_2345_6789n);
    expect(decoded.meta).toEqual(s.meta);
    expect(Object.keys(decoded.buffers)).toEqual(["grid.species", "grid.energy"]);
    expect(decoded.buffers["grid.species"]).toEqual(s.buffers["grid.species"]);
    expect(
      Array.from(viewFromSnapshotBuffer<Int16Array>(decoded.buffers["grid.energy"]!)),
    ).toEqual([-5, 300, 7, 9]);
  });

  it("the schema version is readable from the header", () => {
    const bytes = encodeSnapshot(sample());
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    expect(dv.getUint32(4, true)).toBe(3); // right after the 4-byte magic
  });

  it("rejects bad magic and truncation", () => {
    const bytes = encodeSnapshot(sample());
    const corrupted = bytes.slice();
    corrupted[0] = 0x00;
    expect(() => decodeSnapshot(corrupted)).toThrow(/bad magic/);
    expect(() => decodeSnapshot(bytes.slice(0, bytes.length - 3))).toThrow(/truncated/);
  });

  it("restoreInto validates type and size", () => {
    const buf = snapshotBuffer(new Int16Array([1, 2]));
    const target = new Int16Array(2);
    restoreInto(target, buf);
    expect(Array.from(target)).toEqual([1, 2]);
    expect(() => restoreInto(new Uint16Array(2), buf)).toThrow(/type mismatch/);
    expect(() => restoreInto(new Int16Array(3), buf)).toThrow(/size mismatch/);
  });
});

describe("SnapshotMigrator", () => {
  function makeMigrator(): SnapshotMigrator {
    const m = new SnapshotMigrator(3);
    m.register(1, (s) => ({ ...s, schemaVersion: 2, meta: { ...s.meta, a: 1 } }));
    m.register(2, (s) => ({ ...s, schemaVersion: 3, meta: { ...s.meta, b: 2 } }));
    return m;
  }

  it("chains registered steps up to the current version", () => {
    const migrated = makeMigrator().migrate({ schemaVersion: 1, tick: 5n, meta: {}, buffers: {} });
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.meta).toEqual({ a: 1, b: 2 });
    expect(migrated.tick).toBe(5n);
  });

  it("passes current-version snapshots through untouched", () => {
    const s: Snapshot = { schemaVersion: 3, tick: 1n, meta: {}, buffers: {} };
    expect(makeMigrator().migrate(s)).toBe(s);
  });

  it("rejects newer-than-current and unbridgeable versions", () => {
    const m = new SnapshotMigrator(3);
    m.register(1, (s) => ({ ...s, schemaVersion: 2 }));
    expect(() => m.migrate({ schemaVersion: 4, tick: 0n, meta: {}, buffers: {} })).toThrow(/newer/);
    expect(() => m.migrate({ schemaVersion: 2, tick: 0n, meta: {}, buffers: {} })).toThrow(/no migration registered from schema v2/);
  });

  it("rejects a step that skips versions", () => {
    const m = new SnapshotMigrator(3);
    m.register(1, (s) => ({ ...s, schemaVersion: 3 }));
    expect(() => m.migrate({ schemaVersion: 1, tick: 0n, meta: {}, buffers: {} })).toThrow(/must produce v2/);
  });
});

describe("InMemoryReplayLog", () => {
  it("plays back recorded batches in order", async () => {
    const log = new InMemoryReplayLog();
    log.record(1n, { tick: 1n, commands: [{ kind: "a" }] });
    log.record(1n, { tick: 1n, commands: [{ kind: "b" }] });
    log.record(5n, { tick: 5n, commands: [{ kind: "c" }] });
    expect(log.size).toBe(3);
    const seen: Array<[bigint, string]> = [];
    for await (const [tick, batch] of log.playback()) {
      seen.push([tick, batch.commands[0]!.kind]);
    }
    expect(seen).toEqual([
      [1n, "a"],
      [1n, "b"],
      [5n, "c"],
    ]);
  });

  it("rejects out-of-order recording", () => {
    const log = new InMemoryReplayLog();
    log.record(5n, { tick: 5n, commands: [] });
    expect(() => log.record(4n, { tick: 4n, commands: [] })).toThrow(/non-decreasing/);
  });
});
