// Worker-side Wa-Tor: owns one strip of the grid, serves tick/border/
// snapshot commands over the pool protocol. Usable from a real
// node:worker_threads entry (wator-worker-entry.ts) or in-process via
// TestWorkerAdapter.

import {
  serveWorker,
  type PortLike,
  type SimCommand,
  type WorkerBootData,
} from "@sim/runtime";
import { WaTorRegion, borderTransfers, type BorderPayload } from "./region.js";
import type { WaTorConfig } from "./wator.js";

export const CMD_TICK = "wator.tick";
export const CMD_APPLY_BORDERS = "wator.applyBorders";
export const CMD_SNAPSHOT = "wator.snapshot";
export const CMD_BORDERS = "wator.borders";

export interface WaTorBoot extends WorkerBootData {
  readonly cfg: WaTorConfig;
  readonly rowStart: number;
  readonly rowCount: number;
}

export interface TickCommand extends SimCommand {
  readonly kind: typeof CMD_TICK;
  readonly tick: bigint;
  readonly upIn: BorderPayload | null;
  readonly downIn: BorderPayload | null;
}

export interface ApplyBordersCommand extends SimCommand {
  readonly kind: typeof CMD_APPLY_BORDERS;
  readonly upIn: BorderPayload;
  readonly downIn: BorderPayload;
}

export interface BordersReply extends SimCommand {
  readonly kind: typeof CMD_BORDERS;
  readonly upOut: BorderPayload;
  readonly downOut: BorderPayload;
}

export interface SnapshotReply extends SimCommand {
  readonly kind: typeof CMD_SNAPSHOT;
  readonly rowStart: number;
  readonly rowCount: number;
  readonly species: Uint8Array;
  readonly energy: Int16Array;
  readonly breedAge: Int16Array;
}

export function setupWaTorWorker(port: PortLike, boot: WorkerBootData): void {
  const { cfg, rowStart, rowCount } = boot as WaTorBoot;
  const region = new WaTorRegion(cfg, rowStart, rowCount);
  region.seed();

  const applyIncoming = (up: BorderPayload | null, down: BorderPayload | null): void => {
    if (up !== null && down !== null) {
      region.applyBorders(up, down);
    }
  };

  serveWorker(port, {
    handlers: {
      [CMD_TICK]: (cmd, ctx) => {
        const { tick, upIn, downIn } = cmd as TickCommand;
        applyIncoming(upIn, downIn);
        region.runTick(tick);
        const { up, down } = region.collectBorders();
        const transfers: ArrayBuffer[] = [];
        borderTransfers(up, transfers);
        borderTransfers(down, transfers);
        const reply: BordersReply = { kind: CMD_BORDERS, upOut: up, downOut: down };
        ctx.reply(reply);
        ctx.transfer(...transfers);
      },
      [CMD_APPLY_BORDERS]: (cmd) => {
        const { upIn, downIn } = cmd as ApplyBordersCommand;
        applyIncoming(upIn, downIn);
      },
      [CMD_SNAPSHOT]: (_cmd, ctx) => {
        const snap = region.snapshotOwned();
        const reply: SnapshotReply = {
          kind: CMD_SNAPSHOT,
          rowStart: region.rowStart,
          rowCount: region.rowCount,
          species: snap.species,
          energy: snap.energy,
          breedAge: snap.breedAge,
        };
        ctx.reply(reply);
        ctx.transfer(
          snap.species.buffer as ArrayBuffer,
          snap.energy.buffer as ArrayBuffer,
          snap.breedAge.buffer as ArrayBuffer,
        );
      },
    },
  });
}
