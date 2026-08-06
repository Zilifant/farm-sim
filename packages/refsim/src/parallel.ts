// Main-thread driver for Wa-Tor across N workers. Each tick is one
// exchange: main posts every worker a single batch (the tick plus the border
// data its neighbors produced last tick), and every worker posts back a
// single reply carrying its border payloads — at most one message per worker
// per tick in each direction, with all bulk arrays moved by zero-copy
// transfer. Awaiting all replies is the tick barrier.

import {
  DefaultWorkerPool,
  NodeWorkerAdapter,
  hashBuffers,
  type CommandBatch,
  type Snapshot,
  type WorkerAdapter,
} from "@sim/runtime";
import { borderTransfers, type BorderPayload } from "./region.js";
import { makeWaTorSnapshot, prepareWaTorRestore } from "./snapshot.js";
import { FISH, SHARK, resolveConfig, type WaTorConfig } from "./wator.js";
import {
  CMD_APPLY_BORDERS,
  CMD_BORDERS,
  CMD_RESTORE,
  CMD_SNAPSHOT,
  CMD_TICK,
  type ApplyBordersCommand,
  type BordersReply,
  type RestoreCommand,
  type RowsPayload,
  type SnapshotReply,
  type TickCommand,
  type WaTorBoot,
} from "./wator-worker.js";

export interface ParallelWaTorOptions extends Partial<WaTorConfig> {
  readonly workers: number;
  /** Defaults to real node:worker_threads; tests may inject TestWorkerAdapter. */
  readonly adapter?: WorkerAdapter;
}

export interface WorkerMessagingStats {
  readonly mainPosts: number;
  readonly workerPosts: number;
}

export interface ParallelWaTorSim {
  readonly config: WaTorConfig;
  readonly workers: number;
  readonly tick: bigint;
  run(ticks: number): Promise<void>;
  /** Gathers a full-grid snapshot (transferred, zero-copy) and hashes it in
   * the same buffer order as the single-threaded sim. */
  stateHash(): Promise<number>;
  populations(): Promise<{ fish: number; sharks: number }>;
  snapshot(): Promise<{ species: Uint8Array; energy: Int16Array; breedAge: Int16Array }>;
  /** Barrier-consistent capture (workers idle after the gather exchange). */
  captureSnapshot(): Promise<Snapshot>;
  /** Migrates if needed, validates config, scatters rows + ghosts back. */
  restoreSnapshot(s: Snapshot): Promise<void>;
  /** Message counters per worker — the ≤1 postMessage/worker/tick evidence. */
  stats(): { ticks: number; snapshots: number; perWorker: WorkerMessagingStats[] };
  shutdown(): Promise<number[]>;
}

interface PendingBorders {
  readonly upIn: BorderPayload;
  readonly downIn: BorderPayload;
}

export async function createParallelWaTorSim(
  opts: ParallelWaTorOptions,
): Promise<ParallelWaTorSim> {
  const { workers, adapter, ...partial } = opts;
  const cfg = resolveConfig(partial);
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error("workers must be an integer >= 1");
  }
  const strips = partitionRows(cfg.height, workers);

  const pool = new DefaultWorkerPool({
    adapter: adapter ?? new NodeWorkerAdapter(),
    entry: new URL("./wator-worker-entry.js", import.meta.url),
    size: workers,
    boot: (i): WaTorBoot => ({
      cfg,
      rowStart: strips[i]!.start,
      rowCount: strips[i]!.count,
    }),
  });
  await pool.spawnAll();

  let tick = 0n;
  let ticksRun = 0;
  let snapshots = 0;
  let pending: Array<PendingBorders | null> = new Array<PendingBorders | null>(workers).fill(null);

  async function stepOnce(): Promise<void> {
    const replies = await pool.exchange((i) => {
      const p = pending[i] ?? null;
      const cmd: TickCommand = {
        kind: CMD_TICK,
        tick,
        upIn: p?.upIn ?? null,
        downIn: p?.downIn ?? null,
      };
      const transfer: ArrayBuffer[] = [];
      if (p !== null) {
        borderTransfers(p.upIn, transfer);
        borderTransfers(p.downIn, transfer);
      }
      const batch: CommandBatch = { tick, commands: [cmd] };
      return { batch, transfer };
    });
    const outs = replies.map((env, i) => {
      const cmd = env.batch?.commands.find((c) => c.kind === CMD_BORDERS);
      if (cmd === undefined) {
        throw new Error(`worker ${i} tick reply carried no borders`);
      }
      return cmd as BordersReply;
    });
    // My up-neighbor's down-facing payload becomes my upIn, and vice versa.
    pending = outs.map((_, i) => ({
      upIn: outs[(i - 1 + workers) % workers]!.downOut,
      downIn: outs[(i + 1) % workers]!.upOut,
    }));
    tick += 1n;
    ticksRun += 1;
  }

  async function gather(): Promise<{ species: Uint8Array; energy: Int16Array; breedAge: Int16Array }> {
    const replies = await pool.exchange((i) => {
      const commands = [];
      const transfer: ArrayBuffer[] = [];
      const p = pending[i];
      if (p != null) {
        const apply: ApplyBordersCommand = { kind: CMD_APPLY_BORDERS, upIn: p.upIn, downIn: p.downIn };
        commands.push(apply);
        borderTransfers(p.upIn, transfer);
        borderTransfers(p.downIn, transfer);
      }
      commands.push({ kind: CMD_SNAPSHOT });
      const batch: CommandBatch = { tick: null, commands };
      return { batch, transfer };
    });
    snapshots += 1;
    pending = new Array<PendingBorders | null>(workers).fill(null);

    const cells = cfg.width * cfg.height;
    const species = new Uint8Array(cells);
    const energy = new Int16Array(cells);
    const breedAge = new Int16Array(cells);
    for (const env of replies) {
      const snap = env.batch?.commands.find((c) => c.kind === CMD_SNAPSHOT) as SnapshotReply | undefined;
      if (snap === undefined) {
        throw new Error("snapshot reply missing");
      }
      const offset = snap.rowStart * cfg.width;
      species.set(snap.species, offset);
      energy.set(snap.energy, offset);
      breedAge.set(snap.breedAge, offset);
    }
    return { species, energy, breedAge };
  }

  return {
    config: cfg,
    workers,
    get tick(): bigint {
      return tick;
    },
    async run(ticks: number): Promise<void> {
      if (!Number.isInteger(ticks) || ticks < 0) {
        throw new Error("ticks must be an integer >= 0");
      }
      for (let i = 0; i < ticks; i += 1) {
        await stepOnce();
      }
    },
    async stateHash(): Promise<number> {
      const { species, energy, breedAge } = await gather();
      return hashBuffers([species, energy, breedAge]);
    },
    async populations(): Promise<{ fish: number; sharks: number }> {
      const { species } = await gather();
      let fish = 0;
      let sharks = 0;
      for (let i = 0; i < species.length; i += 1) {
        const s = species[i]!;
        if (s === FISH) {
          fish += 1;
        } else if (s === SHARK) {
          sharks += 1;
        }
      }
      return { fish, sharks };
    },
    snapshot: gather,
    async captureSnapshot(): Promise<Snapshot> {
      return makeWaTorSnapshot(cfg, tick, await gather());
    },
    async restoreSnapshot(s: Snapshot): Promise<void> {
      const { tick: restoredTick, state } = prepareWaTorRestore(cfg, s);
      const w = cfg.width;
      const h = cfg.height;
      const rowSlice = (row: number): RowsPayload => ({
        species: state.species.slice(row * w, (row + 1) * w),
        energy: state.energy.slice(row * w, (row + 1) * w),
        breedAge: state.breedAge.slice(row * w, (row + 1) * w),
      });
      await pool.exchange((i) => {
        const strip = strips[i]!;
        const owned: RowsPayload = {
          species: state.species.slice(strip.start * w, (strip.start + strip.count) * w),
          energy: state.energy.slice(strip.start * w, (strip.start + strip.count) * w),
          breedAge: state.breedAge.slice(strip.start * w, (strip.start + strip.count) * w),
        };
        const cmd: RestoreCommand = {
          kind: CMD_RESTORE,
          owned,
          ghostTop: rowSlice((strip.start - 1 + h) % h),
          ghostBottom: rowSlice((strip.start + strip.count) % h),
        };
        const transfer: ArrayBuffer[] = [];
        for (const p of [cmd.owned, cmd.ghostTop, cmd.ghostBottom]) {
          transfer.push(p.species.buffer as ArrayBuffer, p.energy.buffer as ArrayBuffer, p.breedAge.buffer as ArrayBuffer);
        }
        return { batch: { tick: null, commands: [cmd] }, transfer };
      });
      // Stale border payloads describe pre-restore state.
      pending = new Array<PendingBorders | null>(workers).fill(null);
      tick = restoredTick;
    },
    stats(): { ticks: number; snapshots: number; perWorker: WorkerMessagingStats[] } {
      return {
        ticks: ticksRun,
        snapshots,
        perWorker: pool.handles.map((h) => ({
          mainPosts: h.postCount,
          workerPosts: h.lastWorkerStats?.posts ?? 0,
        })),
      };
    },
    shutdown(): Promise<number[]> {
      return pool.shutdown({ graceful: true, timeoutMs: 5000 });
    },
  };
}

/** Contiguous row strips, remainder spread from the top. Strips must be at
 * least 2 rows tall when there is more than one worker — with 1-row strips a
 * worker's ghost row could be written by a non-adjacent worker, which the
 * border protocol cannot reconstruct. */
export function partitionRows(
  height: number,
  workers: number,
): Array<{ start: number; count: number }> {
  const base = Math.floor(height / workers);
  const rem = height % workers;
  if (workers > 1 && base < 2) {
    throw new Error(
      `grid height ${height} is too short for ${workers} workers (every strip needs >= 2 rows)`,
    );
  }
  const strips: Array<{ start: number; count: number }> = [];
  let start = 0;
  for (let i = 0; i < workers; i += 1) {
    const count = base + (i < rem ? 1 : 0);
    strips.push({ start, count });
    start += count;
  }
  return strips;
}
