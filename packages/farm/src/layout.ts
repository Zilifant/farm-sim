// The land: a road across the world, a homestead with a driveway, and a
// grid of parcels around it. The player starts owning only the homestead
// parcel and *places fields freely* on owned ground — fields are dynamic
// rectangles, not fixtures. Buying neighboring parcels grows the placeable
// area. This module owns the geometry, the per-cell soil-quality map, the
// placement rules, and the appearance-code scheme the renderer draws from.

import { hashCell } from "@sim/runtime";
import { CROP_COUNT } from "./catalog.js";

export const WORLD_WIDTH = 96;
export const WORLD_HEIGHT = 56;
export const ACRES_PER_CELL = 0.5;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

export function rectAcres(r: { w: number; h: number }): number {
  return r.w * r.h * ACRES_PER_CELL;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

// ------------------------------------------------------------ the land

/** The east-west road; parcels sit above and below it. */
export const ROAD_RECT: Rect = rect(0, 27, WORLD_WIDTH, 2);

/** Parcel grid: two rows of eight, split by the road. */
export const PARCEL_COLS = 8;
export const PARCEL_W = WORLD_WIDTH / PARCEL_COLS; // 12 cells
const PARCEL_H = 27;

export interface ParcelDef {
  readonly id: number;
  readonly name: string;
  readonly rect: Rect;
  readonly acres: number;
  /** The homestead parcel is owned from day one. */
  readonly isHomestead: boolean;
}

export const HOMESTEAD_PARCEL_ID = 2; // north row, third from the west

export const PARCELS: readonly ParcelDef[] = Object.freeze(
  Array.from({ length: PARCEL_COLS * 2 }, (_, id) => {
    const col = id % PARCEL_COLS;
    const north = id < PARCEL_COLS;
    const r = rect(col * PARCEL_W, north ? 0 : ROAD_RECT.y + ROAD_RECT.h, PARCEL_W, PARCEL_H);
    return {
      id,
      name: `${north ? "N" : "S"}${col + 1}`,
      rect: r,
      acres: rectAcres(r),
      isHomestead: id === HOMESTEAD_PARCEL_ID,
    };
  }),
);

export const PARCEL_COUNT = PARCELS.length;

/** The farmyard (buildings, storage) and its driveway down to the road —
 * inside the homestead parcel, and never workable ground. */
export const FARMSTEAD_RECT: Rect = rect(28, 18, 6, 6);
export const DRIVEWAY_RECT: Rect = rect(30, 24, 2, 3);

/** Ground no field may cover, even on owned parcels. */
export const BLOCKED_RECTS: readonly Rect[] = Object.freeze([FARMSTEAD_RECT, DRIVEWAY_RECT]);

export const NO_PARCEL = 255;

/** Static parcel-id map: one byte per cell, NO_PARCEL on the road. */
export function buildParcelIdMap(): Uint8Array {
  const map = new Uint8Array(WORLD_WIDTH * WORLD_HEIGHT).fill(NO_PARCEL);
  for (const p of PARCELS) {
    for (let y = p.rect.y; y < p.rect.y + p.rect.h; y += 1) {
      map.fill(p.id, y * WORLD_WIDTH + p.rect.x, y * WORLD_WIDTH + p.rect.x + p.rect.w);
    }
  }
  return map;
}

// ------------------------------------------------------------ soil map

const SALT_SOIL = 401;
/** Coarse lattice pitch for the soil map — quality varies farm-scale, not
 * cell-scale. */
const SOIL_GRID = 8;

function latticeValue(seedHash: number, gx: number, gy: number): number {
  return hashCell(seedHash, gx, gy, 0, SALT_SOIL) / 0x100000000;
}

/**
 * Per-cell soil quality in ~[0.72, 1.14], a smooth (bilinear over a coarse
 * lattice) pure function of the seed — the same for every run, knowable
 * before a field is placed, and the reason placement matters.
 */
export function soilQualityAt(seedHash: number, x: number, y: number): number {
  const gx = Math.floor(x / SOIL_GRID);
  const gy = Math.floor(y / SOIL_GRID);
  const fx = (x - gx * SOIL_GRID) / SOIL_GRID;
  const fy = (y - gy * SOIL_GRID) / SOIL_GRID;
  const v00 = latticeValue(seedHash, gx, gy);
  const v10 = latticeValue(seedHash, gx + 1, gy);
  const v01 = latticeValue(seedHash, gx, gy + 1);
  const v11 = latticeValue(seedHash, gx + 1, gy + 1);
  const v = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
  return 0.72 + v * 0.42;
}

/** Mean soil quality over a rect — a new field's quality. */
export function soilQualityOver(seedHash: number, r: Rect): number {
  let sum = 0;
  for (let y = r.y; y < r.y + r.h; y += 1) {
    for (let x = r.x; x < r.x + r.w; x += 1) {
      sum += soilQualityAt(seedHash, x, y);
    }
  }
  return sum / (r.w * r.h);
}

// ------------------------------------------------------------ placement

export const MIN_FIELD_SIDE = 3;
export const MAX_FIELD_SIDE = 24;

/**
 * Why a field cannot go at `r`, or null when it can. Pure: the sim validates
 * commands with it, and tests pin it directly.
 * @param parcelOwned owned flag per parcel id
 * @param fieldRects the active fields' rects
 */
export function fieldPlacementError(
  r: Rect,
  parcelOwned: ArrayLike<number>,
  fieldRects: readonly Rect[],
): string | null {
  if (
    !Number.isInteger(r.x) || !Number.isInteger(r.y) ||
    !Number.isInteger(r.w) || !Number.isInteger(r.h)
  ) {
    return "field bounds must be whole cells";
  }
  if (r.w < MIN_FIELD_SIDE || r.h < MIN_FIELD_SIDE) {
    return `fields must be at least ${MIN_FIELD_SIDE}×${MIN_FIELD_SIDE} cells`;
  }
  if (r.w > MAX_FIELD_SIDE || r.h > MAX_FIELD_SIDE) {
    return `fields can be at most ${MAX_FIELD_SIDE} cells on a side`;
  }
  if (r.x < 0 || r.y < 0 || r.x + r.w > WORLD_WIDTH || r.y + r.h > WORLD_HEIGHT) {
    return "the field must fit inside the world";
  }
  // Every covered cell must sit on one owned parcel's ground. A field may
  // span two owned parcels — the ground is what matters, not the deed line.
  const parcelIds = parcelIdMapSingleton();
  for (let y = r.y; y < r.y + r.h; y += 1) {
    for (let x = r.x; x < r.x + r.w; x += 1) {
      const parcel = parcelIds[y * WORLD_WIDTH + x]!;
      if (parcel === NO_PARCEL) {
        return "fields cannot cover the road";
      }
      if (parcelOwned[parcel] !== 1) {
        return "that ground is not yours — buy the parcel first";
      }
    }
  }
  for (const blocked of BLOCKED_RECTS) {
    if (rectsOverlap(r, blocked)) {
      return "the farmstead and driveway are not workable ground";
    }
  }
  for (const other of fieldRects) {
    if (rectsOverlap(r, other)) {
      return "that overlaps an existing field";
    }
  }
  return null;
}

let cachedParcelIds: Uint8Array | null = null;
function parcelIdMapSingleton(): Uint8Array {
  cachedParcelIds ??= buildParcelIdMap();
  return cachedParcelIds;
}

// ---------------------------------------------------------- cell codes
//
// One byte per cell on the wire. Codes 0..7 are terrain; from CROP_CODE_BASE
// upward each (crop, growth bucket) pair gets its own code so the renderer's
// appearance registry can map every distinct look without decoding structure.

export const CELL_UNOWNED = 0;
export const CELL_FARMSTEAD = 1;
export const CELL_ROAD = 2;
export const CELL_FALLOW = 3;
export const CELL_OWNED_GRASS = 4;
export const CELL_DRIVEWAY = 5;
export const CROP_CODE_BASE = 8;
/** Growth buckets within a crop's code block. */
export const BUCKET_PLANTED = 0;
export const BUCKET_GERMINATING = 1;
export const BUCKET_GROWING = 2;
export const BUCKET_MATURE = 3;
export const BUCKETS_PER_CROP = 4;

export function cropCellCode(cropCode: number, bucket: number): number {
  return CROP_CODE_BASE + (cropCode - 1) * BUCKETS_PER_CROP + bucket;
}

export const MAX_CELL_CODE = CROP_CODE_BASE + CROP_COUNT * BUCKETS_PER_CROP - 1;

export const NO_FIELD = 255;

export interface FieldCellState {
  readonly rect: Rect;
  readonly crop: number;
  /** Growth stage as stored in FIELD_STAGE (see state.ts). */
  readonly stage: number;
}

/** The appearance code for a field's cells, from that field's state. */
export function fieldCellCode(state: { crop: number; stage: number }): number {
  if (state.crop === 0 || state.stage === 0) {
    return CELL_FALLOW;
  }
  const bucket = Math.min(state.stage - 1, BUCKET_MATURE);
  return cropCellCode(state.crop, bucket);
}

function paintRect(cells: Uint8Array, r: Rect, code: number): void {
  for (let y = r.y; y < r.y + r.h; y += 1) {
    const row = y * WORLD_WIDTH;
    cells.fill(code, row + r.x, row + r.x + r.w);
  }
}

/**
 * Render the whole map to appearance codes: parcel ground (owned or not),
 * the road, farmstead, and driveway, then the active fields on top.
 */
export function buildCellCodes(
  parcelOwned: ArrayLike<number>,
  fields: readonly FieldCellState[],
): Uint8Array {
  const cells = new Uint8Array(WORLD_WIDTH * WORLD_HEIGHT).fill(CELL_UNOWNED);
  for (const p of PARCELS) {
    if (parcelOwned[p.id] === 1) {
      paintRect(cells, p.rect, CELL_OWNED_GRASS);
    }
  }
  paintRect(cells, ROAD_RECT, CELL_ROAD);
  paintRect(cells, DRIVEWAY_RECT, CELL_DRIVEWAY);
  paintRect(cells, FARMSTEAD_RECT, CELL_FARMSTEAD);
  for (const f of fields) {
    paintRect(cells, f.rect, fieldCellCode(f));
  }
  return cells;
}

/** The field-id map for the current set of active fields (NO_FIELD elsewhere). */
export function buildFieldIdMap(fields: ReadonlyArray<{ id: number; rect: Rect }>): Uint8Array {
  const map = new Uint8Array(WORLD_WIDTH * WORLD_HEIGHT).fill(NO_FIELD);
  for (const f of fields) {
    for (let y = f.rect.y; y < f.rect.y + f.rect.h; y += 1) {
      map.fill(f.id, y * WORLD_WIDTH + f.rect.x, y * WORLD_WIDTH + f.rect.x + f.rect.w);
    }
  }
  return map;
}
