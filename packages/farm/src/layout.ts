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
  dirtRoads?: ArrayLike<number>,
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
      if (dirtRoads !== undefined && dirtRoads[y * WORLD_WIDTH + x] === 1) {
        return "there is a dirt road in the way — remove it first";
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
export const CELL_DIRT_ROAD = 6;
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
  /** In-progress work: the first `cells` sweep cells draw as `code`. */
  readonly worked?: { readonly cells: number; readonly code: number };
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
  dirtRoads?: ArrayLike<number>,
): Uint8Array {
  const cells = new Uint8Array(WORLD_WIDTH * WORLD_HEIGHT).fill(CELL_UNOWNED);
  for (const p of PARCELS) {
    if (parcelOwned[p.id] === 1) {
      paintRect(cells, p.rect, CELL_OWNED_GRASS);
    }
  }
  if (dirtRoads !== undefined) {
    for (let i = 0; i < cells.length; i += 1) {
      if (dirtRoads[i] === 1) {
        cells[i] = CELL_DIRT_ROAD;
      }
    }
  }
  paintRect(cells, ROAD_RECT, CELL_ROAD);
  paintRect(cells, DRIVEWAY_RECT, CELL_DRIVEWAY);
  paintRect(cells, FARMSTEAD_RECT, CELL_FARMSTEAD);
  for (const f of fields) {
    paintRect(cells, f.rect, fieldCellCode(f));
    if (f.worked !== undefined && f.worked.cells > 0) {
      // The swept portion shows the operation's after-state cell by cell.
      const n = Math.min(f.worked.cells, f.rect.w * f.rect.h);
      for (let i = 0; i < n; i += 1) {
        const c = serpentineCell(f.rect, i);
        cells[c.y * WORLD_WIDTH + c.x] = f.worked.code;
      }
    }
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

// ------------------------------------------------------------ dirt roads
//
// Fields must be *reachable*: equipment leaves the farmstead by the
// driveway, travels the public road and the player's dirt roads, and can
// only work a field it can drive to. A field is reachable when its edge
// touches a connected road cell — or another reachable field (equipment
// crosses a neighboring field's headland).

export const MAX_ROAD_CELLS_PER_COMMAND = 256;

export interface Cell {
  readonly x: number;
  readonly y: number;
}

/** Why dirt road cannot be built on these cells, or null when it can. */
export function roadPlacementError(
  cells: readonly Cell[],
  parcelOwned: ArrayLike<number>,
  fieldRects: readonly Rect[],
  dirtRoads: ArrayLike<number>,
): string | null {
  if (cells.length === 0) {
    return "no cells to build on";
  }
  if (cells.length > MAX_ROAD_CELLS_PER_COMMAND) {
    return `at most ${MAX_ROAD_CELLS_PER_COMMAND} road cells per command`;
  }
  const parcelIds = parcelIdMapSingleton();
  for (const c of cells) {
    if (!Number.isInteger(c.x) || !Number.isInteger(c.y) || c.x < 0 || c.y < 0 || c.x >= WORLD_WIDTH || c.y >= WORLD_HEIGHT) {
      return "road cells must be whole cells inside the world";
    }
    const parcel = parcelIds[c.y * WORLD_WIDTH + c.x]!;
    if (parcel === NO_PARCEL) {
      return "the public road is already there";
    }
    if (parcelOwned[parcel] !== 1) {
      return "that ground is not yours — buy the parcel first";
    }
    for (const blocked of BLOCKED_RECTS) {
      if (rectContains(blocked, c.x, c.y)) {
        return "the farmstead and driveway already carry traffic";
      }
    }
    for (const f of fieldRects) {
      if (rectContains(f, c.x, c.y)) {
        return "a field is in the way — roads go around fields";
      }
    }
    if (dirtRoads[c.y * WORLD_WIDTH + c.x] === 1) {
      return "there is already a dirt road there";
    }
  }
  return null;
}

/**
 * Which cells the road network reaches: BFS from the driveway across the
 * public road, the driveway, and the player's dirt roads.
 */
export function computeRoadNetwork(dirtRoads: ArrayLike<number>): Uint8Array {
  const isRoad = (x: number, y: number): boolean =>
    rectContains(ROAD_RECT, x, y) ||
    rectContains(DRIVEWAY_RECT, x, y) ||
    dirtRoads[y * WORLD_WIDTH + x] === 1;
  const reached = new Uint8Array(WORLD_WIDTH * WORLD_HEIGHT);
  const queue: number[] = [];
  const push = (x: number, y: number): void => {
    const i = y * WORLD_WIDTH + x;
    if (reached[i] === 0 && isRoad(x, y)) {
      reached[i] = 1;
      queue.push(i);
    }
  };
  push(DRIVEWAY_RECT.x, DRIVEWAY_RECT.y);
  while (queue.length > 0) {
    const i = queue.pop()!;
    const x = i % WORLD_WIDTH;
    const y = (i - x) / WORLD_WIDTH;
    if (x > 0) push(x - 1, y);
    if (x < WORLD_WIDTH - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < WORLD_HEIGHT - 1) push(x, y + 1);
  }
  return reached;
}

function rectTouchesMask(r: Rect, mask: Uint8Array): boolean {
  const check = (x: number, y: number): boolean =>
    x >= 0 && x < WORLD_WIDTH && y >= 0 && y < WORLD_HEIGHT && mask[y * WORLD_WIDTH + x] === 1;
  for (let x = r.x; x < r.x + r.w; x += 1) {
    if (check(x, r.y - 1) || check(x, r.y + r.h)) {
      return true;
    }
  }
  for (let y = r.y; y < r.y + r.h; y += 1) {
    if (check(r.x - 1, y) || check(r.x + r.w, y)) {
      return true;
    }
  }
  return false;
}

function rectsTouch(a: Rect, b: Rect): boolean {
  // Orthogonally adjacent (or overlapping — impossible for fields).
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h &&
    // ...but not merely corner-to-corner:
    !((a.x + a.w === b.x || b.x + b.w === a.x) && (a.y + a.h === b.y || b.y + b.h === a.y));
}

/**
 * Which fields equipment can reach: adjacent to the connected road network,
 * or (transitively) adjacent to another reachable field — machines cross a
 * neighbor's headland. Returns reachability per input index.
 */
export function computeFieldReachability(
  fieldRects: readonly Rect[],
  dirtRoads: ArrayLike<number>,
): boolean[] {
  const network = computeRoadNetwork(dirtRoads);
  const reachable = fieldRects.map((r) => rectTouchesMask(r, network));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < fieldRects.length; i += 1) {
      if (reachable[i]) {
        continue;
      }
      for (let j = 0; j < fieldRects.length; j += 1) {
        if (reachable[j] && rectsTouch(fieldRects[i]!, fieldRects[j]!)) {
          reachable[i] = true;
          changed = true;
          break;
        }
      }
    }
  }
  return reachable;
}

// ------------------------------------------------------------ work sweep
//
// Equipment works a field cell-by-cell in a boustrophedon sweep: row by
// row, alternating direction. The sim's daily acres map onto this order,
// the host paints the worked portion, and the renderer drives its machine
// glyph along the same path — one convention, restated on the wire.

/** The i-th cell (0-based) of the serpentine sweep over a rect. */
export function serpentineCell(r: Rect, i: number): Cell {
  const row = Math.floor(i / r.w);
  const col = i - row * r.w;
  const x = row % 2 === 0 ? r.x + col : r.x + r.w - 1 - col;
  return { x, y: r.y + row };
}
