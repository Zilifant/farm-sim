import type { Snapshot } from "./types.js";

/** Transforms a snapshot from schema version v to v+1. */
export type SnapshotMigration = (s: Snapshot) => Snapshot;

/** Step-wise schema migration: register one migration per version bump and
 * old snapshots upgrade through the chain; anything newer than the current
 * schema, or missing a step, is an explicit error. */
export class SnapshotMigrator {
  readonly currentVersion: number;
  readonly #steps = new Map<number, SnapshotMigration>();

  constructor(currentVersion: number) {
    if (!Number.isInteger(currentVersion) || currentVersion < 1) {
      throw new Error("currentVersion must be an integer >= 1");
    }
    this.currentVersion = currentVersion;
  }

  register(fromVersion: number, step: SnapshotMigration): void {
    if (!Number.isInteger(fromVersion) || fromVersion < 1 || fromVersion >= this.currentVersion) {
      throw new Error(
        `migration must start at a version in [1, ${this.currentVersion}), got ${fromVersion}`,
      );
    }
    if (this.#steps.has(fromVersion)) {
      throw new Error(`migration from version ${fromVersion} already registered`);
    }
    this.#steps.set(fromVersion, step);
  }

  migrate(s: Snapshot): Snapshot {
    if (s.schemaVersion > this.currentVersion) {
      throw new Error(
        `snapshot schema v${s.schemaVersion} is newer than supported v${this.currentVersion}`,
      );
    }
    let current = s;
    while (current.schemaVersion < this.currentVersion) {
      const step = this.#steps.get(current.schemaVersion);
      if (step === undefined) {
        throw new Error(`no migration registered from schema v${current.schemaVersion}`);
      }
      const next = step(current);
      if (next.schemaVersion !== current.schemaVersion + 1) {
        throw new Error(
          `migration from v${current.schemaVersion} must produce v${current.schemaVersion + 1}, got v${next.schemaVersion}`,
        );
      }
      current = next;
    }
    return current;
  }
}
