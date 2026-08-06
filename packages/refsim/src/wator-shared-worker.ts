// SAB-mode worker: attaches views over the shared buffers, seeds its own
// rows at boot, then runs whole batches of ticks with an Atomics barrier
// between ticks — one message round trip per batch, not per tick.

import {
  AtomicsBarrier,
  RowRegionMap,
  WriteGuard,
  attachSharedViews,
  serveWorker,
  type PortLike,
  type RowStrip,
  type SharedBufferManifest,
  type SimCommand,
  type WorkerBootData,
} from "@sim/runtime";
import { WaTorSharedRegion } from "./wator-shared.js";
import { BREED_AGE, ENERGY, SPECIES, type WaTorConfig } from "./wator.js";

export const CMD_SAB_RUN = "wator.sab.run";
export const CMD_SAB_TIMINGS = "wator.sab.timings";

export interface WaTorSharedBoot extends WorkerBootData {
  readonly cfg: WaTorConfig;
  readonly workerIndex: number;
  readonly strips: readonly RowStrip[];
  readonly manifest: SharedBufferManifest;
  readonly barrierSab: SharedArrayBuffer;
  readonly parties: number;
  readonly debug: boolean;
  readonly barrierTimeoutMs?: number;
}

export interface SabRunCommand extends SimCommand {
  readonly kind: typeof CMD_SAB_RUN;
  readonly startTick: bigint;
  readonly count: number;
  /** Time each tick's compute (excluding the barrier wait) and reply with
   * the raw durations for benchmark aggregation. */
  readonly profile?: boolean;
}

export interface SabTimingsReply extends SimCommand {
  readonly kind: typeof CMD_SAB_TIMINGS;
  /** Per-tick runTick durations in ms, one per tick of the batch. */
  readonly durations: Float64Array;
}

export function setupWaTorSharedWorker(port: PortLike, boot: WorkerBootData): void {
  const { cfg, workerIndex, strips, manifest, barrierSab, parties, debug, barrierTimeoutMs } =
    boot as WaTorSharedBoot;
  const views = attachSharedViews(manifest);
  const strip = strips[workerIndex]!;
  const map = new RowRegionMap({ width: cfg.width, height: cfg.height, strips });
  const region = new WaTorSharedRegion({
    cfg,
    rowStart: strip.start,
    rowCount: strip.count,
    species: views.get(SPECIES) as Uint8Array,
    energy: views.get(ENERGY) as Int16Array,
    breedAge: views.get(BREED_AGE) as Int16Array,
    ...(debug
      ? { guard: new WriteGuard(map.writableRanges(workerIndex), `worker ${workerIndex}`) }
      : {}),
  });
  region.seedOwnRows();
  // The driver runs a pool barrier before the first tick command, so every
  // worker has finished seeding before anyone reads a neighbor's rows.
  const barrier = new AtomicsBarrier(barrierSab, parties, barrierTimeoutMs);

  serveWorker(port, {
    handlers: {
      [CMD_SAB_RUN]: (cmd, ctx) => {
        const { startTick, count, profile } = cmd as SabRunCommand;
        if (profile === true) {
          const durations = new Float64Array(count);
          for (let i = 0; i < count; i += 1) {
            const t0 = performance.now();
            region.runTick(startTick + BigInt(i));
            durations[i] = performance.now() - t0;
            barrier.arrive();
          }
          const reply: SabTimingsReply = { kind: CMD_SAB_TIMINGS, durations };
          ctx.reply(reply);
          ctx.transfer(durations.buffer as ArrayBuffer);
          return;
        }
        for (let i = 0; i < count; i += 1) {
          region.runTick(startTick + BigInt(i));
          barrier.arrive();
        }
      },
    },
  });
}
