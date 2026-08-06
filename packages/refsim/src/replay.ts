// Replay a recorded command log into a fresh sim: run to each entry's tick,
// apply its commands, then run out the remainder. Works against any sim
// exposing tick/run/spawn (sequential and SAB modes). Replay sims must be
// created WITHOUT a recording log, or the commands would be re-recorded.

import type { ReplayLog } from "@sim/runtime";
import { WATOR_SPAWN, type WaTorSpawnCommand } from "./commands.js";

export interface ReplayableWaTorSim {
  readonly tick: bigint;
  run(ticks: number): void | Promise<void>;
  spawn(cmd: WaTorSpawnCommand): void;
}

export async function replayInto(
  sim: ReplayableWaTorSim,
  log: ReplayLog,
  untilTick: bigint,
): Promise<void> {
  for await (const [tick, batch] of log.playback()) {
    if (tick > untilTick) {
      break;
    }
    if (tick < sim.tick) {
      throw new Error(`replay entry at tick ${tick} but sim is already at ${sim.tick}`);
    }
    await sim.run(Number(tick - sim.tick));
    for (const cmd of batch.commands) {
      if (cmd.kind === WATOR_SPAWN) {
        sim.spawn(cmd as WaTorSpawnCommand);
      }
    }
  }
  if (untilTick > sim.tick) {
    await sim.run(Number(untilTick - sim.tick));
  }
}
