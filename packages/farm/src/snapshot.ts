// Farm snapshot schema. Version history:
//   v1 — initial schema (current).
// The snapshot carries every state buffer plus the config; because all
// randomness is counter-based, (buffers, tick, config) fully determine the
// future.

import {
  SnapshotMigrator,
  snapshotBuffer,
  viewFromSnapshotBuffer,
  type BufferRegistry,
  type Snapshot,
  type TypedArray,
} from "@sim/runtime";
import { STATE_BUFFERS, type FarmConfig } from "./state.js";

export const FARM_SCHEMA_VERSION = 1;

export const farmMigrator = new SnapshotMigrator(FARM_SCHEMA_VERSION);

export function makeFarmSnapshot(cfg: FarmConfig, tick: bigint, buffers: BufferRegistry): Snapshot {
  const out: Record<string, ReturnType<typeof snapshotBuffer>> = {};
  for (const id of STATE_BUFFERS) {
    out[id] = snapshotBuffer(buffers.get(id));
  }
  return { schemaVersion: FARM_SCHEMA_VERSION, tick, meta: { cfg }, buffers: out };
}

/** Migrate, validate config, and overwrite the registry's state in place. */
export function restoreFarmSnapshot(cfg: FarmConfig, buffers: BufferRegistry, snapshot: Snapshot): bigint {
  const s = farmMigrator.migrate(snapshot);
  const snapCfg = s.meta["cfg"] as FarmConfig | undefined;
  if (snapCfg === undefined) {
    throw new Error("snapshot has no config in meta.cfg");
  }
  const mismatched = (Object.keys(cfg) as Array<keyof FarmConfig>).filter((k) => cfg[k] !== snapCfg[k]);
  if (mismatched.length > 0) {
    throw new Error(`snapshot config does not match this sim (differs in: ${mismatched.join(", ")})`);
  }
  for (const id of STATE_BUFFERS) {
    const buf = s.buffers[id];
    if (buf === undefined) {
      throw new Error(`snapshot is missing buffer "${id}"`);
    }
    const view = buffers.get(id);
    const restored = viewFromSnapshotBuffer<TypedArray>(buf);
    if (restored.length !== view.length) {
      throw new Error(`snapshot buffer "${id}" is ${restored.length} elements; expected ${view.length}`);
    }
    (view as Float64Array).set(restored as Float64Array);
  }
  return s.tick;
}
