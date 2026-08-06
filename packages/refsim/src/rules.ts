// The Wa-Tor cell rules, shared verbatim by every execution mode (sequential
// strip, message-passing workers, SAB workers) so their state evolution is
// byte-identical. Callers supply neighbor indices (addressing differs by
// mode) and a write callback (strip mode logs ghost-row writes as
// migrations; SAB debug mode checks a write guard).

import { hashCell } from "@sim/runtime";
import type { WaTorConfig } from "./wator.js";

export const EMPTY = 0;
export const FISH = 1;
export const SHARK = 2;

/** Int16 ceiling for ages/energy. */
export const COUNTER_MAX = 32767;

export const SALT_ACT = 1;
export const SALT_INIT_KIND = 2;
export const SALT_INIT_AGE = 3;

export type CellWriter = (idx: number, sp: number, en: number, ba: number) => void;

/** Deterministic initial cell state from its global index. */
export function seedCell(
  cfg: WaTorConfig,
  seedHash: number,
  gIdx: number,
): { sp: number; en: number; ba: number } {
  const roll = hashCell(seedHash, 0, 0, gIdx, SALT_INIT_KIND) / 4294967296;
  if (roll < cfg.sharkDensity) {
    return {
      sp: SHARK,
      en: cfg.sharkInitialEnergy,
      ba: hashCell(seedHash, 0, 0, gIdx, SALT_INIT_AGE) % cfg.sharkBreedAge,
    };
  }
  if (roll < cfg.sharkDensity + cfg.fishDensity) {
    return {
      sp: FISH,
      en: 0,
      ba: hashCell(seedHash, 0, 0, gIdx, SALT_INIT_AGE) % cfg.fishBreedAge,
    };
  }
  return { sp: EMPTY, en: 0, ba: 0 };
}

/** Pick among the neighbors matching `target`, in fixed up/right/down/left
 * order, using `rand` — or -1 when none match. */
export function pickNeighbor4(
  species: Uint8Array,
  n0: number,
  n1: number,
  n2: number,
  n3: number,
  target: number,
  rand: number,
): number {
  let c0 = -1;
  let c1 = -1;
  let c2 = -1;
  let c3 = -1;
  let count = 0;
  if (species[n0]! === target) { c0 = n0; count += 1; }
  if (species[n1]! === target) { if (count === 0) c0 = n1; else if (count === 1) c1 = n1; count += 1; }
  if (species[n2]! === target) { if (count === 0) c0 = n2; else if (count === 1) c1 = n2; else c2 = n2; count += 1; }
  if (species[n3]! === target) { if (count === 0) c0 = n3; else if (count === 1) c1 = n3; else if (count === 2) c2 = n3; else c3 = n3; count += 1; }
  if (count === 0) {
    return -1;
  }
  const pick = rand % count;
  return pick === 0 ? c0 : pick === 1 ? c1 : pick === 2 ? c2 : c3;
}

/** One creature's action for this tick. Reads only idx and its four
 * neighbors; writes only via `write`, to idx and at most one neighbor. */
export function actCell(
  cfg: WaTorConfig,
  species: Uint8Array,
  energy: Int16Array,
  breedAge: Int16Array,
  idx: number,
  n0: number,
  n1: number,
  n2: number,
  n3: number,
  rand: number,
  write: CellWriter,
): void {
  const sp = species[idx]!;
  if (sp === FISH) {
    const target = pickNeighbor4(species, n0, n1, n2, n3, EMPTY, rand);
    const age = Math.min(breedAge[idx]! + 1, COUNTER_MAX);
    if (target < 0) {
      write(idx, FISH, 0, age);
      return;
    }
    if (age >= cfg.fishBreedAge) {
      write(target, FISH, 0, 0);
      // Offspring stays behind; both counters restart.
      write(idx, FISH, 0, 0);
    } else {
      write(target, FISH, 0, age);
      write(idx, EMPTY, 0, 0);
    }
    return;
  }
  if (sp === SHARK) {
    const remaining = energy[idx]! - 1;
    if (remaining <= 0) {
      write(idx, EMPTY, 0, 0);
      return;
    }
    let fed = remaining;
    let target = pickNeighbor4(species, n0, n1, n2, n3, FISH, rand);
    if (target >= 0) {
      fed = Math.min(remaining + cfg.sharkEnergyPerFish, cfg.sharkMaxEnergy);
    } else {
      target = pickNeighbor4(species, n0, n1, n2, n3, EMPTY, rand);
    }
    const age = Math.min(breedAge[idx]! + 1, COUNTER_MAX);
    if (target < 0) {
      write(idx, SHARK, fed, age);
      return;
    }
    if (age >= cfg.sharkBreedAge) {
      write(target, SHARK, fed, 0);
      write(idx, SHARK, cfg.sharkInitialEnergy, 0);
    } else {
      write(target, SHARK, fed, age);
      write(idx, EMPTY, 0, 0);
    }
  }
}
