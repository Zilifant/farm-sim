// Wa-Tor snapshot schema. Version history:
//   v1 — pre-sharkMaxEnergy: sharks banked unlimited energy (effectively
//        capped only by the Int16 ceiling).
//   v2 — config gained sharkMaxEnergy (current).
// The v1→v2 migration pins sharkMaxEnergy to the Int16 ceiling, preserving
// the old unbounded-banking semantics of the save rather than adopting the
// new default.

import {
  SnapshotMigrator,
  snapshotBuffer,
  viewFromSnapshotBuffer,
  type Snapshot,
} from "@sim/runtime";
import { COUNTER_MAX } from "./rules.js";
import { BREED_AGE, ENERGY, SPECIES, type WaTorConfig } from "./wator.js";

export const WATOR_SCHEMA_VERSION = 2;

export const watorMigrator = new SnapshotMigrator(WATOR_SCHEMA_VERSION);
watorMigrator.register(1, (s) => {
  const cfg = (s.meta["cfg"] ?? {}) as Partial<WaTorConfig>;
  return {
    ...s,
    schemaVersion: 2,
    meta: { ...s.meta, cfg: { ...cfg, sharkMaxEnergy: COUNTER_MAX } },
  };
});

export interface WaTorGridState {
  readonly species: Uint8Array;
  readonly energy: Int16Array;
  readonly breedAge: Int16Array;
}

/** Build a snapshot from full-grid (width × height) state views. */
export function makeWaTorSnapshot(
  cfg: WaTorConfig,
  tick: bigint,
  state: WaTorGridState,
): Snapshot {
  return {
    schemaVersion: WATOR_SCHEMA_VERSION,
    tick,
    meta: { cfg },
    buffers: {
      [SPECIES]: snapshotBuffer(state.species),
      [ENERGY]: snapshotBuffer(state.energy),
      [BREED_AGE]: snapshotBuffer(state.breedAge),
    },
  };
}

/** Migrate, validate against the running sim's config, and materialize the
 * grid state. Throws rather than restoring into a mismatched sim. */
export function prepareWaTorRestore(
  cfg: WaTorConfig,
  snapshot: Snapshot,
): { tick: bigint; state: WaTorGridState } {
  const s = watorMigrator.migrate(snapshot);
  const snapCfg = s.meta["cfg"] as WaTorConfig | undefined;
  if (snapCfg === undefined) {
    throw new Error("snapshot has no config in meta.cfg");
  }
  const mismatched = (Object.keys(cfg) as Array<keyof WaTorConfig>).filter(
    (k) => cfg[k] !== snapCfg[k],
  );
  if (mismatched.length > 0) {
    throw new Error(
      `snapshot config does not match this sim (differs in: ${mismatched.join(", ")})`,
    );
  }
  const cells = cfg.width * cfg.height;
  const species = viewFromSnapshotBuffer<Uint8Array>(requireBuffer(s, SPECIES));
  const energy = viewFromSnapshotBuffer<Int16Array>(requireBuffer(s, ENERGY));
  const breedAge = viewFromSnapshotBuffer<Int16Array>(requireBuffer(s, BREED_AGE));
  if (species.length !== cells || energy.length !== cells || breedAge.length !== cells) {
    throw new Error(`snapshot buffers do not cover the ${cells}-cell grid`);
  }
  return { tick: s.tick, state: { species, energy, breedAge } };
}

function requireBuffer(s: Snapshot, id: string): NonNullable<Snapshot["buffers"][string]> {
  const buf = s.buffers[id];
  if (buf === undefined) {
    throw new Error(`snapshot is missing buffer "${id}"`);
  }
  return buf;
}
