import type { TypedArrayCtorName } from "../memory/layout.js";

/** A raw byte copy of one state buffer. */
export interface SnapshotBuffer {
  readonly ctor: TypedArrayCtorName;
  readonly data: Uint8Array;
}

/**
 * Barrier-consistent state capture: buffers copied while no worker is
 * mid-tick, plus the tick counter. With counter-based RNG there is no
 * generator state to save — (buffers, tick, meta) fully determine the
 * future. The schema version is honored from day one so old saves can be
 * migrated instead of rejected.
 */
export interface Snapshot {
  readonly schemaVersion: number;
  readonly tick: bigint;
  /** Domain metadata (e.g. the resolved sim config). JSON-serializable. */
  readonly meta: Record<string, unknown>;
  readonly buffers: Readonly<Record<string, SnapshotBuffer>>;
}

/** Implemented by sims/drivers: capture at a barrier, restore, migrate. */
export interface SnapshotStore {
  readonly schemaVersion: number;
  capture(): Promise<Snapshot>;
  restore(s: Snapshot): Promise<void>;
  migrate(s: Snapshot): Snapshot;
}
