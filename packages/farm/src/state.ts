// State layout: every piece of simulation state lives in a typed-array
// buffer keyed by a branded BufferId, which is what makes the whole farm
// hashable, snapshotable, and replayable. No object graphs.

import { bufferId, type BufferId, type BufferRegistry } from "@sim/runtime";
import { CROP_COUNT, EQUIP_COUNT } from "./catalog.js";
import { PARCEL_COUNT } from "./layout.js";

// ------------------------------------------------------------ fields
//
// Fields are dynamic: the player creates them on owned ground and can plow
// them under again. A field lives in one of MAX_FIELDS slots; FIELD_ACTIVE
// marks live slots and the geometry buffers carry each field's rectangle.

export const MAX_FIELDS = 24;

export const FIELD_ACTIVE: BufferId = bufferId("farm.field.active"); // u8[NF]
export const FIELD_NUM: BufferId = bufferId("farm.field.num"); // u8[NF], display number
export const FIELD_X: BufferId = bufferId("farm.field.x"); // u8[NF]
export const FIELD_Y: BufferId = bufferId("farm.field.y"); // u8[NF]
export const FIELD_W: BufferId = bufferId("farm.field.w"); // u8[NF]
export const FIELD_H: BufferId = bufferId("farm.field.h"); // u8[NF]
export const FIELD_ACRES: BufferId = bufferId("farm.field.acres"); // f32[NF]
export const FIELD_SOIL_QUALITY: BufferId = bufferId("farm.field.soilQuality"); // f32[NF]
export const FIELD_MOISTURE: BufferId = bufferId("farm.field.moisture"); // f32[NF]
export const FIELD_FERTILITY: BufferId = bufferId("farm.field.fertility"); // f32[NF]
export const FIELD_CROP: BufferId = bufferId("farm.field.crop"); // u8[NF]
export const FIELD_PREV_CROP: BufferId = bufferId("farm.field.prevCrop"); // u8[NF]
export const FIELD_STAGE: BufferId = bufferId("farm.field.stage"); // u8[NF]
export const FIELD_PROGRESS: BufferId = bufferId("farm.field.progress"); // f32[NF]
export const FIELD_PLANT_DAY: BufferId = bufferId("farm.field.plantDay"); // i32[NF], -1 unplanted
export const FIELD_MATURE_DAY: BufferId = bufferId("farm.field.matureDay"); // i32[NF], -1
export const FIELD_GROW_DAYS: BufferId = bufferId("farm.field.growDays"); // i32[NF]
export const FIELD_PLANT_FACTOR: BufferId = bufferId("farm.field.plantFactor"); // f32[NF]
export const FIELD_STRESS: BufferId = bufferId("farm.field.stress"); // f32[NF]
/** Sum of daily fertility readings over the crop's grow days — the yield
 * model scores the season's average supply, not what is left at harvest. */
export const FIELD_FERT_SUM: BufferId = bufferId("farm.field.fertSum"); // f32[NF]
export const FIELD_DAMAGE: BufferId = bufferId("farm.field.damage"); // f32[NF], 1 = unhurt
export const FIELD_CUTTINGS: BufferId = bufferId("farm.field.cuttings"); // u8[NF]
export const FIELD_YIELD_EST: BufferId = bufferId("farm.field.yieldEst"); // f32[NF], units/ac
export const FIELD_YIELD_LAST: BufferId = bufferId("farm.field.yieldLast"); // f32[NF], units/ac

/** Growth stages stored in FIELD_STAGE. */
export const STAGE_UNPLANTED = 0;
export const STAGE_PLANTED = 1;
export const STAGE_GERMINATING = 2;
export const STAGE_GROWING = 3;
export const STAGE_MATURE = 4;

export const STAGE_NAMES: readonly string[] = Object.freeze([
  "unplanted", "planted", "germinating", "growing", "mature",
]);

// ------------------------------------------------------------ operations

export const MAX_OPS = 64;

export const OP_KIND: BufferId = bufferId("farm.op.kind"); // u8[MAX_OPS], 0 = free slot
export const OP_FIELD: BufferId = bufferId("farm.op.field"); // u8[MAX_OPS]
export const OP_CROP: BufferId = bufferId("farm.op.crop"); // u8[MAX_OPS]
export const OP_STATUS: BufferId = bufferId("farm.op.status"); // u8[MAX_OPS]
export const OP_ACRES_DONE: BufferId = bufferId("farm.op.acresDone"); // f32[MAX_OPS]
export const OP_SEQ: BufferId = bufferId("farm.op.seq"); // i32[MAX_OPS], creation order
export const OP_FACTOR_SUM: BufferId = bufferId("farm.op.factorSum"); // f32[MAX_OPS], acre-weighted

// ------------------------------------------------------------ land

export const PARCEL_OWNED: BufferId = bufferId("farm.parcel.owned"); // u8[PARCEL_COUNT]

// ------------------------------------------------------------ capacity

export const EQUIP_LEVEL: BufferId = bufferId("farm.equip.level"); // u8[EQUIP_COUNT], 1-based
export const WORKERS: BufferId = bufferId("farm.workers"); // u8[1]

// ------------------------------------------------------------ market / storage

export const PRICE: BufferId = bufferId("farm.market.price"); // f32[CROP_COUNT+1], [0] unused
export const STORED: BufferId = bufferId("farm.storage.stored"); // f64[CROP_COUNT+1], units

// ------------------------------------------------------------ weather

/** Today's weather, written by the weather system each tick. */
export const WEATHER: BufferId = bufferId("farm.weather"); // f32[3]
export const WEATHER_HIGH = 0;
export const WEATHER_LOW = 1;
export const WEATHER_RAIN = 2;

// ------------------------------------------------------------ finances

/** Core money scalars (f64). */
export const MONEY: BufferId = bufferId("farm.money"); // f64[MONEY_SLOTS]
export const M_CASH = 0;
export const M_DEBT = 1;
/** Monotonic op-sequence counter (stored as money so it snapshots; integer-valued). */
export const M_NEXT_OP_SEQ = 2;
/** Monotonic field display-number counter, same trick. */
export const M_NEXT_FIELD_NUM = 3;
export const MONEY_SLOTS = 4;

/** Year-to-date totals (f64), reset at each year end. */
export const YTD: BufferId = bufferId("farm.ytd"); // f64[YTD_SLOTS]
export const YTD_REVENUE = 0;
export const YTD_SEED = 1;
export const YTD_FERTILIZER = 2;
export const YTD_IRRIGATION = 3;
export const YTD_MACHINERY = 4;
export const YTD_LABOR = 5;
export const YTD_INTEREST = 6;
export const YTD_LAND = 7;
export const YTD_SLOTS = 8;

/** Per-crop year-to-date: [revenue, cost, unitsHarvested] × (CROP_COUNT+1). */
export const CROP_YTD: BufferId = bufferId("farm.cropYtd"); // f64[(CROP_COUNT+1)*3]
export const CY_REVENUE = 0;
export const CY_COST = 1;
export const CY_UNITS = 2;
export const CY_STRIDE = 3;

/** Units harvested per field this year (f64[NF]). */
export const FIELD_YTD_UNITS: BufferId = bufferId("farm.fieldYtdUnits");

// ------------------------------------------------------------ config

export interface FarmConfig {
  readonly seed: number | string;
  readonly startCash: number;
  readonly startDebt: number;
  readonly startWorkers: number;
}

export const DEFAULT_CONFIG: FarmConfig = {
  seed: "farm",
  startCash: 150_000,
  startDebt: 200_000,
  startWorkers: 2,
};

export function resolveConfig(partial: Partial<FarmConfig>): FarmConfig {
  const cfg = { ...DEFAULT_CONFIG, ...partial };
  if (typeof cfg.seed === "number" && (!Number.isInteger(cfg.seed) || cfg.seed < 0 || cfg.seed > 0xffffffff)) {
    throw new Error("numeric seed must be a whole number in [0, 4294967295]");
  }
  if (!Number.isFinite(cfg.startCash) || cfg.startCash < 0) {
    throw new Error("startCash must be a non-negative number");
  }
  if (!Number.isFinite(cfg.startDebt) || cfg.startDebt < 0) {
    throw new Error("startDebt must be a non-negative number");
  }
  if (!Number.isInteger(cfg.startWorkers) || cfg.startWorkers < 1 || cfg.startWorkers > 8) {
    throw new Error("startWorkers must be a whole number in [1, 8]");
  }
  return cfg;
}

// ------------------------------------------------------------ registry

/** Every state buffer, in a pinned order — the hash and snapshot both walk
 * this list, so the order is part of the schema. */
export const STATE_BUFFERS: readonly BufferId[] = Object.freeze([
  FIELD_ACTIVE, FIELD_NUM, FIELD_X, FIELD_Y, FIELD_W, FIELD_H,
  FIELD_ACRES, FIELD_SOIL_QUALITY, FIELD_MOISTURE, FIELD_FERTILITY,
  FIELD_CROP, FIELD_PREV_CROP, FIELD_STAGE, FIELD_PROGRESS, FIELD_PLANT_DAY,
  FIELD_MATURE_DAY, FIELD_GROW_DAYS, FIELD_PLANT_FACTOR, FIELD_STRESS,
  FIELD_FERT_SUM, FIELD_DAMAGE, FIELD_CUTTINGS, FIELD_YIELD_EST, FIELD_YIELD_LAST,
  PARCEL_OWNED,
  OP_KIND, OP_FIELD, OP_CROP, OP_STATUS, OP_ACRES_DONE, OP_SEQ, OP_FACTOR_SUM,
  EQUIP_LEVEL, WORKERS, PRICE, STORED, WEATHER, MONEY, YTD, CROP_YTD,
  FIELD_YTD_UNITS,
]);

export function defineFarmBuffers(buffers: BufferRegistry): void {
  const NF = MAX_FIELDS;
  buffers.define(FIELD_ACTIVE, { type: Uint8Array, length: NF });
  buffers.define(FIELD_NUM, { type: Uint8Array, length: NF });
  buffers.define(FIELD_X, { type: Uint8Array, length: NF });
  buffers.define(FIELD_Y, { type: Uint8Array, length: NF });
  buffers.define(FIELD_W, { type: Uint8Array, length: NF });
  buffers.define(FIELD_H, { type: Uint8Array, length: NF });
  buffers.define(FIELD_ACRES, { type: Float32Array, length: NF });
  buffers.define(FIELD_SOIL_QUALITY, { type: Float32Array, length: NF });
  buffers.define(FIELD_MOISTURE, { type: Float32Array, length: NF });
  buffers.define(FIELD_FERTILITY, { type: Float32Array, length: NF });
  buffers.define(FIELD_CROP, { type: Uint8Array, length: NF });
  buffers.define(FIELD_PREV_CROP, { type: Uint8Array, length: NF });
  buffers.define(FIELD_STAGE, { type: Uint8Array, length: NF });
  buffers.define(FIELD_PROGRESS, { type: Float32Array, length: NF });
  buffers.define(FIELD_PLANT_DAY, { type: Int32Array, length: NF });
  buffers.define(FIELD_MATURE_DAY, { type: Int32Array, length: NF });
  buffers.define(FIELD_GROW_DAYS, { type: Int32Array, length: NF });
  buffers.define(FIELD_PLANT_FACTOR, { type: Float32Array, length: NF });
  buffers.define(FIELD_STRESS, { type: Float32Array, length: NF });
  buffers.define(FIELD_FERT_SUM, { type: Float32Array, length: NF });
  buffers.define(FIELD_DAMAGE, { type: Float32Array, length: NF });
  buffers.define(FIELD_CUTTINGS, { type: Uint8Array, length: NF });
  buffers.define(FIELD_YIELD_EST, { type: Float32Array, length: NF });
  buffers.define(FIELD_YIELD_LAST, { type: Float32Array, length: NF });

  buffers.define(OP_KIND, { type: Uint8Array, length: MAX_OPS });
  buffers.define(OP_FIELD, { type: Uint8Array, length: MAX_OPS });
  buffers.define(OP_CROP, { type: Uint8Array, length: MAX_OPS });
  buffers.define(OP_STATUS, { type: Uint8Array, length: MAX_OPS });
  buffers.define(OP_ACRES_DONE, { type: Float32Array, length: MAX_OPS });
  buffers.define(OP_SEQ, { type: Int32Array, length: MAX_OPS });
  buffers.define(OP_FACTOR_SUM, { type: Float32Array, length: MAX_OPS });

  buffers.define(PARCEL_OWNED, { type: Uint8Array, length: PARCEL_COUNT });
  buffers.define(EQUIP_LEVEL, { type: Uint8Array, length: EQUIP_COUNT });
  buffers.define(WORKERS, { type: Uint8Array, length: 1 });
  buffers.define(PRICE, { type: Float32Array, length: CROP_COUNT + 1 });
  buffers.define(STORED, { type: Float64Array, length: CROP_COUNT + 1 });
  buffers.define(WEATHER, { type: Float32Array, length: 3 });
  buffers.define(MONEY, { type: Float64Array, length: MONEY_SLOTS });
  buffers.define(YTD, { type: Float64Array, length: YTD_SLOTS });
  buffers.define(CROP_YTD, { type: Float64Array, length: (CROP_COUNT + 1) * CY_STRIDE });
  buffers.define(FIELD_YTD_UNITS, { type: Float64Array, length: NF });
}
