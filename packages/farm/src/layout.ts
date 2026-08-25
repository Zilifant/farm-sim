// The farm map: a fixed layout of rectangular fields on a cell grid, plus
// the appearance-code scheme the renderer draws from. The sim itself only
// needs acreage; the grid exists for presentation and inspection, so the
// renderer can stay a pure grid-of-glyphs view (one byte per cell on the
// wire).

import { CROP_COUNT } from "./catalog.js";

export const WORLD_WIDTH = 64;
export const WORLD_HEIGHT = 40;
export const ACRES_PER_CELL = 0.5;

export interface FieldRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface FieldDef {
  readonly id: number;
  readonly name: string;
  readonly rect: FieldRect;
  readonly acres: number;
  /** Owned at the start, or a neighboring parcel available for purchase. */
  readonly startsOwned: boolean;
}

const rect = (x: number, y: number, w: number, h: number): FieldRect => ({ x, y, w, h });
const acresOf = (r: FieldRect): number => r.w * r.h * ACRES_PER_CELL;

function field(id: number, name: string, r: FieldRect, startsOwned: boolean): FieldDef {
  return { id, name, rect: r, acres: acresOf(r), startsOwned };
}

/** Three tiers of fields with grass lanes between; the east column is the
 * neighboring land that can be bought later. */
export const FIELDS: readonly FieldDef[] = Object.freeze([
  field(0, "North A", rect(1, 1, 18, 10), true),
  field(1, "North B", rect(20, 1, 18, 10), true),
  field(2, "North East", rect(39, 1, 24, 10), false),
  field(3, "Home West", rect(1, 12, 18, 12), true),
  field(4, "Home Strip", rect(29, 12, 9, 12), true),
  field(5, "Home East", rect(39, 12, 24, 12), false),
  field(6, "South A", rect(1, 25, 18, 14), true),
  field(7, "South B", rect(20, 25, 18, 14), true),
  field(8, "South East", rect(39, 25, 24, 14), false),
]);

export const FIELD_COUNT = FIELDS.length;

/** The farmyard block (buildings, storage) — decorative, not workable. */
export const FARMSTEAD_RECT: FieldRect = rect(20, 12, 8, 6);

// ---------------------------------------------------------- cell codes
//
// One byte per cell on the wire. Codes 0..7 are terrain; from CROP_CODE_BASE
// upward each (crop, growth bucket) pair gets its own code so the renderer's
// appearance registry can map every distinct look without decoding structure.

export const CELL_GRASS = 0;
export const CELL_FARMSTEAD = 1;
export const CELL_FOR_SALE = 2;
export const CELL_FALLOW = 3;
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

/** Static field-id map: one byte per cell, 255 = not part of any field. */
export const NO_FIELD = 255;

export function buildFieldIdMap(): Uint8Array {
  const map = new Uint8Array(WORLD_WIDTH * WORLD_HEIGHT).fill(NO_FIELD);
  for (const f of FIELDS) {
    for (let y = f.rect.y; y < f.rect.y + f.rect.h; y += 1) {
      const row = y * WORLD_WIDTH;
      for (let x = f.rect.x; x < f.rect.x + f.rect.w; x += 1) {
        map[row + x] = f.id;
      }
    }
  }
  return map;
}

export interface FieldCellState {
  readonly owned: boolean;
  readonly crop: number;
  /** Growth stage as stored in FIELD_STAGE (see state.ts). */
  readonly stage: number;
}

/** The appearance code for one field cell, given that field's state. */
export function fieldCellCode(state: FieldCellState): number {
  if (!state.owned) {
    return CELL_FOR_SALE;
  }
  if (state.crop === 0 || state.stage === 0) {
    return CELL_FALLOW;
  }
  const bucket = Math.min(state.stage - 1, BUCKET_MATURE);
  return cropCellCode(state.crop, bucket);
}

/**
 * Render the whole map to appearance codes. `fieldState` is queried once per
 * field, not per cell.
 */
export function buildCellCodes(fieldState: (fieldId: number) => FieldCellState): Uint8Array {
  const cells = new Uint8Array(WORLD_WIDTH * WORLD_HEIGHT).fill(CELL_GRASS);
  for (const f of FIELDS) {
    const code = fieldCellCode(fieldState(f.id));
    for (let y = f.rect.y; y < f.rect.y + f.rect.h; y += 1) {
      const row = y * WORLD_WIDTH;
      cells.fill(code, row + f.rect.x, row + f.rect.x + f.rect.w);
    }
  }
  const fr = FARMSTEAD_RECT;
  for (let y = fr.y; y < fr.y + fr.h; y += 1) {
    const row = y * WORLD_WIDTH;
    cells.fill(CELL_FARMSTEAD, row + fr.x, row + fr.x + fr.w);
  }
  return cells;
}
