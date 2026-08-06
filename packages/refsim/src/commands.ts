// External commands that perturb the simulation. Commands are applied at a
// tick boundary (before the tick they are recorded against) and belong in a
// ReplayLog: (seed, config, command log) reproduces a run exactly.

import type { SimCommand } from "@sim/runtime";
import { EMPTY, FISH, SHARK } from "./rules.js";
import type { WaTorConfig } from "./wator.js";

export const WATOR_SPAWN = "wator.spawn";

export interface WaTorSpawnCommand extends SimCommand {
  readonly kind: typeof WATOR_SPAWN;
  readonly x: number;
  readonly y: number;
  readonly species: number;
  readonly energy: number;
  readonly breedAge: number;
}

export interface SpawnOptions {
  readonly x: number;
  readonly y: number;
  /** EMPTY clears the cell (a "kill" disturbance). */
  readonly species: number;
  readonly energy?: number;
  readonly breedAge?: number;
}

export function makeSpawnCommand(cfg: WaTorConfig, opts: SpawnOptions): WaTorSpawnCommand {
  if (!Number.isInteger(opts.x) || opts.x < 0 || opts.x >= cfg.width) {
    throw new Error(`spawn x must be in [0, ${cfg.width})`);
  }
  if (!Number.isInteger(opts.y) || opts.y < 0 || opts.y >= cfg.height) {
    throw new Error(`spawn y must be in [0, ${cfg.height})`);
  }
  if (opts.species !== EMPTY && opts.species !== FISH && opts.species !== SHARK) {
    throw new Error(`spawn species must be EMPTY (${EMPTY}), FISH (${FISH}), or SHARK (${SHARK})`);
  }
  const energy =
    opts.energy ?? (opts.species === SHARK ? cfg.sharkInitialEnergy : 0);
  const breedAge = opts.breedAge ?? 0;
  return { kind: WATOR_SPAWN, x: opts.x, y: opts.y, species: opts.species, energy, breedAge };
}
