// The farm's systems, in tick order: weather → soil → operations → growth →
// market → finance → year end. One tick is one day. All randomness is
// counter-hashed from (seed, day), so a run is a pure function of
// (seed, config, command log).

import { hashCell, seedToU32, type BufferId, type EventQueue, type System, type SystemContext } from "@sim/runtime";
import {
  CROPS, CROP_COUNT, DAYS_PER_YEAR, EQUIPMENT, EQUIP_COUNT,
  FERTILIZE_EFFECT, HOURS_PER_WORKER, INTEREST_RATE, IRRIGATE_EFFECT,
  LAND_COST_PER_ACRE, LATE_PLANT_FLOOR, MUD_BLOCK_MOISTURE,
  OP_FERTILIZE, OP_HARVEST, OP_IRRIGATE, OP_KEYS, OP_PLANT,
  OVERFLOW_SALE_DISCOUNT, PLANT_MIN_HIGH_TEMP, RAIN_BLOCK_INCHES,
  SEASON_END_DOY, STORAGE_CAPACITY, WAGE_PER_DAY,
  calendarDate, cropByCode, dayOfYear, equipForOp,
  OP_STATUS_ACTIVE, OP_STATUS_EMPTY,
  type CropDef,
} from "./catalog.js";
import { FIELDS, FIELD_COUNT } from "./layout.js";
import {
  CROP_YTD, CY_COST, CY_REVENUE, CY_STRIDE, CY_UNITS,
  EQUIP_LEVEL, FIELD_ACRES, FIELD_CROP, FIELD_CUTTINGS, FIELD_DAMAGE,
  FIELD_FERTILITY, FIELD_GROW_DAYS, FIELD_MATURE_DAY, FIELD_MOISTURE,
  FIELD_OWNED, FIELD_PLANT_DAY, FIELD_PLANT_FACTOR, FIELD_PREV_CROP,
  FIELD_PROGRESS, FIELD_SOIL_QUALITY, FIELD_STAGE, FIELD_STRESS,
  FIELD_FERT_SUM, FIELD_YIELD_EST, FIELD_YIELD_LAST, FIELD_YTD_UNITS,
  MAX_OPS, MONEY, M_CASH, M_DEBT, OP_ACRES_DONE, OP_CROP, OP_FACTOR_SUM,
  OP_FIELD, OP_KIND, OP_SEQ, OP_STATUS, PRICE, STORED, WEATHER,
  WEATHER_HIGH, WEATHER_LOW, WEATHER_RAIN, WORKERS,
  STAGE_GERMINATING, STAGE_GROWING, STAGE_MATURE, STAGE_PLANTED, STAGE_UNPLANTED,
  YTD, YTD_FERTILIZER, YTD_INTEREST, YTD_IRRIGATION, YTD_LABOR, YTD_LAND,
  YTD_MACHINERY, YTD_REVENUE, YTD_SEED,
  type FarmConfig,
} from "./state.js";
import { weatherFor } from "./weather.js";

// ------------------------------------------------------------- events

export interface FarmEvent {
  readonly tick: bigint;
  /** "op" | "harvest" | "frost" | "loss" | "year" */
  readonly kind: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

export interface YearSummary {
  readonly year: number;
  readonly revenue: number;
  readonly expenses: number;
  readonly profit: number;
  readonly cash: number;
  readonly debt: number;
  readonly netWorth: number;
  readonly expenseBreakdown: Record<string, number>;
  readonly byCrop: Array<{ crop: string; units: number; unit: string; revenue: number; cost: number; profit: number }>;
  readonly byField: Array<{ field: string; units: number }>;
}

// ------------------------------------------------------------- salts

const SALT_PRICE = 301;

// ------------------------------------------------------------- pure rules
// Exported so tests can pin the yield model down without running a season.

/** Planting-date yield factor; NaN when outside the window (ineligible). */
export function plantDateFactor(crop: CropDef, doy: number): number {
  const [opens, optimal, closes] = crop.plantWindow;
  if (doy < opens || doy > closes) {
    return Number.NaN;
  }
  if (doy <= optimal) {
    return 1;
  }
  return 1 - (1 - LATE_PLANT_FLOOR) * ((doy - optimal) / (closes - optimal));
}

/** Rotation factor applied at planting, from what the field grew last. */
export function rotationFactor(crop: CropDef, prevCropCode: number): number {
  if (prevCropCode === 0) {
    return 1;
  }
  const prev = cropByCode(prevCropCode);
  if (prev.code === crop.code) {
    return 0.9; // monoculture drag
  }
  if (prev.rotationGroup === "legume" && crop.rotationGroup !== "legume") {
    return 1.06; // nitrogen credit
  }
  return 1;
}

/** Growth-rate factor from the day's mean temperature. */
export function tempGrowthFactor(avgTemp: number): number {
  let tf = Math.min(1, Math.max(0, (avgTemp - 38) / 27));
  if (avgTemp > 92) {
    tf *= Math.max(0.5, 1 - (avgTemp - 92) * 0.03);
  }
  return tf;
}

/** Season-long moisture factor from accumulated stress-days. */
export function moistureFactor(crop: CropDef, stress: number): number {
  return Math.min(1.05, Math.max(0.25, 1 - (0.7 * stress) / crop.growDays));
}

export function fertilityFactor(fertility: number): number {
  return Math.min(1.08, Math.max(0.5, 0.5 + 0.65 * fertility));
}

/** Season-average fertility from the accumulator, falling back to the
 * current reading before any grow days have passed. */
export function seasonFertility(fertSum: number, growDays: number, current: number): number {
  return growDays > 0 ? fertSum / growDays : current;
}

/** Harvest-timing factor for working the field *today*. */
export function harvestTimingFactor(crop: CropDef, stage: number, progress: number, day: number, matureDay: number): number {
  if (stage === STAGE_MATURE) {
    const over = day - matureDay - crop.harvestGraceDays;
    return over <= 0 ? 1 : Math.max(0.4, 1 - 0.012 * over);
  }
  // Early harvest, allowed from 85% maturity at a steep discount.
  return 0.55 + 0.45 * ((Math.min(progress, 1) - 0.85) / 0.15);
}

/** Uniform [0,1) for a (day, salt) pair. */
function u01(seedHash: number, day: number, salt: number): number {
  return hashCell(seedHash, day | 0, 0, 0, salt) / 0x100000000;
}

/** Mean-zero noise in [-1, 1]. */
function noise2(seedHash: number, day: number, salt: number): number {
  return u01(seedHash, day, salt) + u01(seedHash, day, salt + 5000) - 1;
}

// ------------------------------------------------------------- weather

export class WeatherSystem implements System {
  readonly id = "farm.weather";
  readonly everyNTicks = 1;
  readonly reads: readonly BufferId[] = [WEATHER];
  readonly writes: readonly BufferId[] = [WEATHER];
  readonly #seedHash: number;
  #weather!: Float32Array;

  constructor(cfg: FarmConfig) {
    this.#seedHash = seedToU32(String(cfg.seed));
  }

  init(ctx: SystemContext): void {
    this.#weather = ctx.buffer<Float32Array>(WEATHER);
  }

  update(ctx: SystemContext): void {
    const day = Number(ctx.tick);
    const w = weatherFor(this.#seedHash, day);
    this.#weather[WEATHER_HIGH] = w.high;
    this.#weather[WEATHER_LOW] = w.low;
    this.#weather[WEATHER_RAIN] = w.rain;
  }
}

// ------------------------------------------------------------- soil

export class SoilSystem implements System {
  readonly id = "farm.soil";
  readonly everyNTicks = 1;
  readonly reads: readonly BufferId[] = [WEATHER, FIELD_CROP, FIELD_STAGE, FIELD_MOISTURE, FIELD_FERTILITY];
  readonly writes: readonly BufferId[] = [FIELD_MOISTURE, FIELD_FERTILITY];
  #weather!: Float32Array;
  #crop!: Uint8Array;
  #stage!: Uint8Array;
  #moisture!: Float32Array;
  #fertility!: Float32Array;

  init(ctx: SystemContext): void {
    this.#weather = ctx.buffer<Float32Array>(WEATHER);
    this.#crop = ctx.buffer<Uint8Array>(FIELD_CROP);
    this.#stage = ctx.buffer<Uint8Array>(FIELD_STAGE);
    this.#moisture = ctx.buffer<Float32Array>(FIELD_MOISTURE);
    this.#fertility = ctx.buffer<Float32Array>(FIELD_FERTILITY);
  }

  update(): void {
    const rain = this.#weather[WEATHER_RAIN]!;
    const avg = (this.#weather[WEATHER_HIGH]! + this.#weather[WEATHER_LOW]!) / 2;
    for (let f = 0; f < FIELD_COUNT; f += 1) {
      const cropCode = this.#crop[f]!;
      const growingCover = cropCode !== 0 && this.#stage[f]! >= STAGE_GROWING;
      const et = (0.004 + Math.max(0, avg - 40) * 0.00045) * (growingCover ? 1.35 : 1);
      // Wetter ground sheds more of each rain as runoff, so the balance
      // settles near ~0.78 through winter/spring and ~0.4 under a summer
      // crop — with real droughty dips when the rain stays away.
      const soak = rain * 0.42 * Math.pow(1 - this.#moisture[f]!, 1.2);
      const m = this.#moisture[f]! + soak - et;
      this.#moisture[f] = Math.min(1, Math.max(0.03, m));
      if (cropCode === 0) {
        this.#fertility[f] = Math.min(0.9, this.#fertility[f]! + 0.0004);
      } else if (this.#stage[f]! < STAGE_MATURE) {
        const crop = cropByCode(cropCode);
        this.#fertility[f] = Math.max(0.05, this.#fertility[f]! - crop.fertNeed / crop.growDays);
      }
    }
  }
}

// ------------------------------------------------------------- operations

const OPS_READS_WRITES: readonly BufferId[] = [
  WEATHER, EQUIP_LEVEL, WORKERS, PRICE,
  OP_KIND, OP_FIELD, OP_CROP, OP_STATUS, OP_ACRES_DONE, OP_SEQ, OP_FACTOR_SUM,
  FIELD_ACRES, FIELD_OWNED, FIELD_CROP, FIELD_PREV_CROP, FIELD_STAGE,
  FIELD_PROGRESS, FIELD_PLANT_DAY, FIELD_MATURE_DAY, FIELD_GROW_DAYS,
  FIELD_PLANT_FACTOR, FIELD_STRESS, FIELD_FERT_SUM, FIELD_DAMAGE, FIELD_CUTTINGS,
  FIELD_SOIL_QUALITY, FIELD_MOISTURE, FIELD_FERTILITY,
  FIELD_YIELD_LAST, FIELD_YTD_UNITS,
  STORED, MONEY, YTD, CROP_YTD,
];

/** The work queue: each day, queued operations compete for machine capacity
 * and labor hours, in creation order, subject to weather and field state. */
export class OperationsSystem implements System {
  readonly id = "farm.operations";
  readonly everyNTicks = 1;
  readonly reads = OPS_READS_WRITES;
  readonly writes = OPS_READS_WRITES;
  #b!: {
    weather: Float32Array; equip: Uint8Array; workers: Uint8Array; price: Float32Array;
    opKind: Uint8Array; opField: Uint8Array; opCrop: Uint8Array; opStatus: Uint8Array;
    opAcres: Float32Array; opSeq: Int32Array; opFactor: Float32Array;
    acres: Float32Array; owned: Uint8Array; crop: Uint8Array; prevCrop: Uint8Array;
    stage: Uint8Array; progress: Float32Array; plantDay: Int32Array; matureDay: Int32Array;
    growDays: Int32Array; plantFactor: Float32Array; stress: Float32Array;
    fertSum: Float32Array; damage: Float32Array; cuttings: Uint8Array; soilQ: Float32Array;
    moisture: Float32Array; fertility: Float32Array; yieldLast: Float32Array;
    fieldYtd: Float64Array; stored: Float64Array; money: Float64Array;
    ytd: Float64Array; cropYtd: Float64Array;
  };
  readonly #events: EventQueue<FarmEvent>;

  constructor(events: EventQueue<FarmEvent>) {
    this.#events = events;
  }

  init(ctx: SystemContext): void {
    this.#b = {
      weather: ctx.buffer<Float32Array>(WEATHER),
      equip: ctx.buffer<Uint8Array>(EQUIP_LEVEL),
      workers: ctx.buffer<Uint8Array>(WORKERS),
      price: ctx.buffer<Float32Array>(PRICE),
      opKind: ctx.buffer<Uint8Array>(OP_KIND),
      opField: ctx.buffer<Uint8Array>(OP_FIELD),
      opCrop: ctx.buffer<Uint8Array>(OP_CROP),
      opStatus: ctx.buffer<Uint8Array>(OP_STATUS),
      opAcres: ctx.buffer<Float32Array>(OP_ACRES_DONE),
      opSeq: ctx.buffer<Int32Array>(OP_SEQ),
      opFactor: ctx.buffer<Float32Array>(OP_FACTOR_SUM),
      acres: ctx.buffer<Float32Array>(FIELD_ACRES),
      owned: ctx.buffer<Uint8Array>(FIELD_OWNED),
      crop: ctx.buffer<Uint8Array>(FIELD_CROP),
      prevCrop: ctx.buffer<Uint8Array>(FIELD_PREV_CROP),
      stage: ctx.buffer<Uint8Array>(FIELD_STAGE),
      progress: ctx.buffer<Float32Array>(FIELD_PROGRESS),
      plantDay: ctx.buffer<Int32Array>(FIELD_PLANT_DAY),
      matureDay: ctx.buffer<Int32Array>(FIELD_MATURE_DAY),
      growDays: ctx.buffer<Int32Array>(FIELD_GROW_DAYS),
      plantFactor: ctx.buffer<Float32Array>(FIELD_PLANT_FACTOR),
      stress: ctx.buffer<Float32Array>(FIELD_STRESS),
      fertSum: ctx.buffer<Float32Array>(FIELD_FERT_SUM),
      damage: ctx.buffer<Float32Array>(FIELD_DAMAGE),
      cuttings: ctx.buffer<Uint8Array>(FIELD_CUTTINGS),
      soilQ: ctx.buffer<Float32Array>(FIELD_SOIL_QUALITY),
      moisture: ctx.buffer<Float32Array>(FIELD_MOISTURE),
      fertility: ctx.buffer<Float32Array>(FIELD_FERTILITY),
      yieldLast: ctx.buffer<Float32Array>(FIELD_YIELD_LAST),
      fieldYtd: ctx.buffer<Float64Array>(FIELD_YTD_UNITS),
      stored: ctx.buffer<Float64Array>(STORED),
      money: ctx.buffer<Float64Array>(MONEY),
      ytd: ctx.buffer<Float64Array>(YTD),
      cropYtd: ctx.buffer<Float64Array>(CROP_YTD),
    };
  }

  update(ctx: SystemContext): void {
    const b = this.#b;
    const day = Number(ctx.tick);
    const doy = dayOfYear(day);
    const rain = b.weather[WEATHER_RAIN]!;
    const high = b.weather[WEATHER_HIGH]!;

    // Today's capacity pools, consumed in op-creation order.
    const capacityLeft = new Float64Array(EQUIP_COUNT);
    for (let e = 0; e < EQUIP_COUNT; e += 1) {
      capacityLeft[e] = EQUIPMENT[e]!.capacity[b.equip[e]! - 1]!;
    }
    let laborLeft = b.workers[0]! * HOURS_PER_WORKER;

    const order: number[] = [];
    for (let s = 0; s < MAX_OPS; s += 1) {
      if (b.opStatus[s] !== OP_STATUS_EMPTY) {
        order.push(s);
      }
    }
    order.sort((x, y) => b.opSeq[x]! - b.opSeq[y]!);

    for (const s of order) {
      const kind = b.opKind[s]!;
      const f = b.opField[s]!;
      const fieldAcres = b.acres[f]!;
      const opCropCode = b.opCrop[s]!;

      // --- standing eligibility; a failed op frees its slot with an event.
      if (kind === OP_PLANT) {
        if (b.crop[f]! !== 0 || b.stage[f]! !== STAGE_UNPLANTED) {
          this.#fail(ctx, s, `${FIELDS[f]!.name} already has a crop`);
          continue;
        }
        const crop = cropByCode(opCropCode);
        if (doy > crop.plantWindow[2]) {
          this.#fail(ctx, s, `${crop.name} planting window closed before ${FIELDS[f]!.name} was planted`);
          continue;
        }
        if (doy < crop.plantWindow[0]) {
          continue; // waits for the window to open
        }
      } else if (kind === OP_HARVEST) {
        const cropCode = b.crop[f]!;
        if (cropCode === 0) {
          this.#fail(ctx, s, `${FIELDS[f]!.name} has nothing to harvest`);
          continue;
        }
        if (b.stage[f]! !== STAGE_MATURE && b.progress[f]! < 0.85) {
          continue; // not ripe yet; waits
        }
      }

      // --- weather gates. Blocked ops wait; they never fail on weather.
      if (kind === OP_PLANT || kind === OP_HARVEST) {
        if (rain > RAIN_BLOCK_INCHES || b.moisture[f]! > MUD_BLOCK_MOISTURE) {
          continue;
        }
        if (kind === OP_PLANT && high < PLANT_MIN_HIGH_TEMP) {
          continue;
        }
      } else if (kind === OP_FERTILIZE) {
        if (rain > RAIN_BLOCK_INCHES) {
          continue;
        }
      } else if (kind === OP_IRRIGATE) {
        if (rain > 0.1) {
          continue; // pointless in the rain
        }
      }

      // --- capacity
      const equip = equipForOp(kind);
      const capLeft = capacityLeft[equip.cat]!;
      if (capLeft <= 0.01 || laborLeft <= 0.01) {
        continue;
      }
      const laborPerAcre =
        kind === OP_PLANT ? cropByCode(opCropCode).laborPlant
        : kind === OP_HARVEST ? cropByCode(b.crop[f]!).laborHarvest
        : equip.laborPerAcre;
      const remaining = fieldAcres - b.opAcres[s]!;
      const acresToday = Math.min(remaining, capLeft, laborLeft / laborPerAcre);
      if (acresToday <= 0.01) {
        continue;
      }

      // --- work: costs and per-acre effects
      capacityLeft[equip.cat] = capLeft - acresToday;
      laborLeft -= acresToday * laborPerAcre;
      b.opStatus[s] = OP_STATUS_ACTIVE;

      const machineCost = acresToday * equip.opCost;
      b.money[M_CASH]! -= machineCost;
      b.ytd[YTD_MACHINERY]! += machineCost;
      const costCrop = kind === OP_PLANT ? opCropCode : b.crop[f]!;
      if (costCrop !== 0) {
        b.cropYtd[costCrop * CY_STRIDE + CY_COST]! += machineCost;
      }
      if (equip.materialCost > 0) {
        const material = acresToday * equip.materialCost;
        b.money[M_CASH]! -= material;
        const slot = kind === OP_FERTILIZE ? YTD_FERTILIZER : YTD_IRRIGATION;
        b.ytd[slot]! += material;
        if (costCrop !== 0) {
          b.cropYtd[costCrop * CY_STRIDE + CY_COST]! += material;
        }
      }

      if (kind === OP_PLANT) {
        const crop = cropByCode(opCropCode);
        const seed = acresToday * crop.seedCost;
        b.money[M_CASH]! -= seed;
        b.ytd[YTD_SEED]! += seed;
        b.cropYtd[opCropCode * CY_STRIDE + CY_COST]! += seed;
        b.opFactor[s]! += acresToday * plantDateFactor(crop, doy);
      } else if (kind === OP_FERTILIZE) {
        b.fertility[f] = Math.min(1, b.fertility[f]! + FERTILIZE_EFFECT * (acresToday / fieldAcres));
      } else if (kind === OP_IRRIGATE) {
        b.moisture[f] = Math.min(1, b.moisture[f]! + IRRIGATE_EFFECT * (acresToday / fieldAcres));
      } else if (kind === OP_HARVEST) {
        const crop = cropByCode(b.crop[f]!);
        b.opFactor[s]! += acresToday * harvestTimingFactor(crop, b.stage[f]!, b.progress[f]!, day, b.matureDay[f]!);
      }

      b.opAcres[s]! += acresToday;

      // --- completion
      if (b.opAcres[s]! >= fieldAcres - 0.01) {
        this.#complete(ctx, s, day);
      }
    }
  }

  #fail(ctx: SystemContext, s: number, why: string): void {
    const b = this.#b;
    this.#events.emit({
      tick: ctx.tick,
      kind: "op",
      message: `${OP_KEYS[b.opKind[s]!] ?? "op"} cancelled: ${why}`,
      data: { opSeq: b.opSeq[s]!, failed: true },
    });
    this.#free(s);
  }

  #free(s: number): void {
    const b = this.#b;
    b.opKind[s] = 0;
    b.opField[s] = 0;
    b.opCrop[s] = 0;
    b.opStatus[s] = OP_STATUS_EMPTY;
    b.opAcres[s] = 0;
    b.opSeq[s] = 0;
    b.opFactor[s] = 0;
  }

  #complete(ctx: SystemContext, s: number, day: number): void {
    const b = this.#b;
    const kind = b.opKind[s]!;
    const f = b.opField[s]!;
    const fieldName = FIELDS[f]!.name;
    const fieldAcres = b.acres[f]!;

    if (kind === OP_PLANT) {
      const cropCode = b.opCrop[s]!;
      const crop = cropByCode(cropCode);
      const dateFactor = b.opFactor[s]! / fieldAcres;
      b.crop[f] = cropCode;
      b.stage[f] = STAGE_PLANTED;
      b.progress[f] = 0;
      b.plantDay[f] = day;
      b.matureDay[f] = -1;
      b.growDays[f] = 0;
      b.stress[f] = 0;
      b.fertSum[f] = 0;
      b.damage[f] = 1;
      b.cuttings[f] = 0;
      b.plantFactor[f] = dateFactor * rotationFactor(crop, b.prevCrop[f]!);
      this.#events.emit({
        tick: ctx.tick,
        kind: "op",
        message: `planted ${crop.name} on ${fieldName} (${Math.round(fieldAcres)} ac)`,
        data: { field: f, crop: crop.key },
      });
    } else if (kind === OP_FERTILIZE) {
      this.#events.emit({
        tick: ctx.tick,
        kind: "op",
        message: `fertilized ${fieldName}`,
        data: { field: f },
      });
    } else if (kind === OP_IRRIGATE) {
      this.#events.emit({
        tick: ctx.tick,
        kind: "op",
        message: `irrigated ${fieldName}`,
        data: { field: f },
      });
    } else if (kind === OP_HARVEST) {
      this.#harvest(ctx, s, day);
    }
    this.#free(s);
  }

  #harvest(ctx: SystemContext, s: number, day: number): void {
    const b = this.#b;
    const f = b.opField[s]!;
    const fieldAcres = b.acres[f]!;
    const cropCode = b.crop[f]!;
    const crop = cropByCode(cropCode);
    const timingFactor = b.opFactor[s]! / fieldAcres;
    const yieldPerAcre = Math.max(
      0,
      crop.baseYield *
        b.soilQ[f]! *
        b.plantFactor[f]! *
        moistureFactor(crop, b.stress[f]!) *
        fertilityFactor(seasonFertility(b.fertSum[f]!, b.growDays[f]!, b.fertility[f]!)) *
        b.damage[f]! *
        timingFactor,
    );
    const units = yieldPerAcre * fieldAcres;
    b.yieldLast[f] = yieldPerAcre;
    b.fieldYtd[f]! += units;
    b.cropYtd[cropCode * CY_STRIDE + CY_UNITS]! += units;

    // Store what fits; the overflow sells immediately at a hauling discount.
    let totalStored = 0;
    for (let c = 1; c <= CROP_COUNT; c += 1) {
      totalStored += b.stored[c]!;
    }
    const space = Math.max(0, STORAGE_CAPACITY - totalStored);
    const toStore = Math.min(units, space);
    const overflow = units - toStore;
    b.stored[cropCode]! += toStore;
    let saleNote = "";
    if (overflow > 0.01) {
      const revenue = overflow * b.price[cropCode]! * OVERFLOW_SALE_DISCOUNT;
      b.money[M_CASH]! += revenue;
      b.ytd[YTD_REVENUE]! += revenue;
      b.cropYtd[cropCode * CY_STRIDE + CY_REVENUE]! += revenue;
      saleNote = `; storage full — ${Math.round(overflow)} ${crop.unit} sold at $${(b.price[cropCode]! * OVERFLOW_SALE_DISCOUNT).toFixed(2)}`;
    }

    this.#events.emit({
      tick: ctx.tick,
      kind: "harvest",
      message: `harvested ${FIELDS[f]!.name}: ${Math.round(units)} ${crop.unit} of ${crop.name} (${yieldPerAcre.toFixed(1)}/ac)${saleNote}`,
      data: { field: f, crop: crop.key, units, yieldPerAcre },
    });

    const doy = dayOfYear(day);
    const nextCutting = b.cuttings[f]! + 1;
    if (crop.maxCuttings > nextCutting && doy < 280) {
      // Hay-style regrowth: the stand stays, growth rewinds to regrow.
      b.cuttings[f] = nextCutting;
      b.stage[f] = STAGE_GROWING;
      b.progress[f] = Math.max(0, 1 - crop.regrowDays / crop.growDays);
      b.matureDay[f] = -1;
      b.stress[f] = b.stress[f]! * 0.5;
    } else {
      this.#resetField(f, cropCode, crop);
    }
  }

  #resetField(f: number, cropCode: number, crop: CropDef): void {
    const b = this.#b;
    b.prevCrop[f] = cropCode;
    b.crop[f] = 0;
    b.stage[f] = STAGE_UNPLANTED;
    b.progress[f] = 0;
    b.plantDay[f] = -1;
    b.matureDay[f] = -1;
    b.growDays[f] = 0;
    b.stress[f] = 0;
    b.fertSum[f] = 0;
    b.damage[f] = 1;
    b.cuttings[f] = 0;
    if (crop.rotationGroup === "legume") {
      b.fertility[f] = Math.min(1, b.fertility[f]! + 0.08);
    }
  }
}

// ------------------------------------------------------------- growth

const GROWTH_READS: readonly BufferId[] = [
  WEATHER, FIELD_CROP, FIELD_STAGE, FIELD_PROGRESS, FIELD_MOISTURE,
  FIELD_FERTILITY, FIELD_STRESS, FIELD_FERT_SUM, FIELD_DAMAGE, FIELD_GROW_DAYS,
  FIELD_MATURE_DAY, FIELD_PLANT_FACTOR, FIELD_SOIL_QUALITY, FIELD_YIELD_EST,
  FIELD_PREV_CROP, FIELD_PLANT_DAY, FIELD_CUTTINGS,
];

export class GrowthSystem implements System {
  readonly id = "farm.growth";
  readonly everyNTicks = 1;
  readonly reads = GROWTH_READS;
  readonly writes = GROWTH_READS;
  readonly #events: EventQueue<FarmEvent>;
  #b!: {
    weather: Float32Array; crop: Uint8Array; stage: Uint8Array; progress: Float32Array;
    moisture: Float32Array; fertility: Float32Array; stress: Float32Array;
    fertSum: Float32Array; damage: Float32Array; growDays: Int32Array; matureDay: Int32Array;
    plantFactor: Float32Array; soilQ: Float32Array; yieldEst: Float32Array;
    prevCrop: Uint8Array; plantDay: Int32Array; cuttings: Uint8Array;
  };

  constructor(events: EventQueue<FarmEvent>) {
    this.#events = events;
  }

  init(ctx: SystemContext): void {
    this.#b = {
      weather: ctx.buffer<Float32Array>(WEATHER),
      crop: ctx.buffer<Uint8Array>(FIELD_CROP),
      stage: ctx.buffer<Uint8Array>(FIELD_STAGE),
      progress: ctx.buffer<Float32Array>(FIELD_PROGRESS),
      moisture: ctx.buffer<Float32Array>(FIELD_MOISTURE),
      fertility: ctx.buffer<Float32Array>(FIELD_FERTILITY),
      stress: ctx.buffer<Float32Array>(FIELD_STRESS),
      fertSum: ctx.buffer<Float32Array>(FIELD_FERT_SUM),
      damage: ctx.buffer<Float32Array>(FIELD_DAMAGE),
      growDays: ctx.buffer<Int32Array>(FIELD_GROW_DAYS),
      matureDay: ctx.buffer<Int32Array>(FIELD_MATURE_DAY),
      plantFactor: ctx.buffer<Float32Array>(FIELD_PLANT_FACTOR),
      soilQ: ctx.buffer<Float32Array>(FIELD_SOIL_QUALITY),
      yieldEst: ctx.buffer<Float32Array>(FIELD_YIELD_EST),
      prevCrop: ctx.buffer<Uint8Array>(FIELD_PREV_CROP),
      plantDay: ctx.buffer<Int32Array>(FIELD_PLANT_DAY),
      cuttings: ctx.buffer<Uint8Array>(FIELD_CUTTINGS),
    };
  }

  update(ctx: SystemContext): void {
    const b = this.#b;
    const day = Number(ctx.tick);
    const doy = dayOfYear(day);
    const high = b.weather[WEATHER_HIGH]!;
    const low = b.weather[WEATHER_LOW]!;
    const avg = (high + low) / 2;

    for (let f = 0; f < FIELD_COUNT; f += 1) {
      const cropCode = b.crop[f]!;
      if (cropCode === 0) {
        b.yieldEst[f] = 0;
        continue;
      }
      const crop = cropByCode(cropCode);

      // End of season: winter takes anything still standing.
      if (doy === SEASON_END_DOY) {
        this.#events.emit({
          tick: ctx.tick,
          kind: "loss",
          message: `winter killed the unharvested ${crop.name} on ${FIELDS[f]!.name}`,
          data: { field: f, crop: crop.key },
        });
        this.#clearField(f, cropCode);
        continue;
      }

      // Daily growth and stress; a mature crop is done accumulating both.
      if (b.stage[f]! < STAGE_MATURE) {
        b.growDays[f]! += 1;
        b.fertSum[f]! += b.fertility[f]!;
        const tf = tempGrowthFactor(avg);
        const mf = Math.min(1, Math.max(0.2, b.moisture[f]! / crop.waterNeed));
        // Drought slows development far less than it cuts yield — the yield
        // cost lives in the stress accumulator, not the calendar.
        b.progress[f]! += (tf * (0.6 + 0.4 * mf)) / crop.growDays;
        const dry = Math.max(0, (crop.waterNeed - b.moisture[f]!) / crop.waterNeed);
        const wet = Math.max(0, b.moisture[f]! - 0.92) * 4;
        b.stress[f]! += Math.min(1, crop.droughtSensitivity * dry * dry + wet * 0.5);
      }

      // Stage transitions from progress.
      const p = b.progress[f]!;
      if (p >= 1 && b.stage[f]! < STAGE_MATURE) {
        b.stage[f] = STAGE_MATURE;
        b.matureDay[f] = day;
        this.#events.emit({
          tick: ctx.tick,
          kind: "op",
          message: `${crop.name} on ${FIELDS[f]!.name} is mature`,
          data: { field: f, crop: crop.key },
        });
      } else if (p >= 0.2 && b.stage[f]! < STAGE_GROWING) {
        b.stage[f] = STAGE_GROWING;
      } else if (p >= 0.05 && b.stage[f]! < STAGE_GERMINATING) {
        b.stage[f] = STAGE_GERMINATING;
      }

      // Frost. Seedlings underground barely notice, mature crops have dried
      // down and hold (lateness is already punished by the timing decay);
      // it is the green, growing crop that a freeze ruins.
      if (low <= crop.frostKillTemp && b.stage[f]! >= STAGE_GERMINATING && b.stage[f]! < STAGE_MATURE) {
        const hard = low <= crop.frostKillTemp - 8;
        const factor =
          b.stage[f]! === STAGE_GERMINATING ? 0.9
          : hard ? 0.45
          : 0.7;
        b.damage[f]! *= factor;
        this.#events.emit({
          tick: ctx.tick,
          kind: "frost",
          message: `${hard ? "hard frost" : "frost"} (${low.toFixed(0)}°F) hit the ${crop.name} on ${FIELDS[f]!.name}`,
          data: { field: f, crop: crop.key, low },
        });
      }

      // Live expected yield for the planner's eyes.
      b.yieldEst[f] =
        crop.baseYield *
        b.soilQ[f]! *
        b.plantFactor[f]! *
        moistureFactor(crop, b.stress[f]!) *
        fertilityFactor(seasonFertility(b.fertSum[f]!, b.growDays[f]!, b.fertility[f]!)) *
        b.damage[f]!;
    }
  }

  #clearField(f: number, cropCode: number): void {
    const b = this.#b;
    b.prevCrop[f] = cropCode;
    b.crop[f] = 0;
    b.stage[f] = STAGE_UNPLANTED;
    b.progress[f] = 0;
    b.plantDay[f] = -1;
    b.matureDay[f] = -1;
    b.growDays[f] = 0;
    b.stress[f] = 0;
    b.fertSum[f] = 0;
    b.damage[f] = 1;
    b.cuttings[f] = 0;
    b.yieldEst[f] = 0;
  }
}

// ------------------------------------------------------------- market

export class MarketSystem implements System {
  readonly id = "farm.market";
  readonly everyNTicks = 1;
  readonly reads: readonly BufferId[] = [PRICE];
  readonly writes: readonly BufferId[] = [PRICE];
  readonly #seedHash: number;
  #price!: Float32Array;

  constructor(cfg: FarmConfig) {
    this.#seedHash = seedToU32(String(cfg.seed));
  }

  init(ctx: SystemContext): void {
    this.#price = ctx.buffer<Float32Array>(PRICE);
  }

  update(ctx: SystemContext): void {
    const day = Number(ctx.tick);
    const doy = dayOfYear(day);
    for (const crop of CROPS) {
      const c = crop.code;
      const seasonal =
        crop.basePrice * (1 + crop.seasonalAmp * Math.cos((2 * Math.PI * (doy - 130)) / DAYS_PER_YEAR));
      const z = noise2(this.#seedHash, day, SALT_PRICE + c) * 1.7;
      let p = this.#price[c]! + 0.02 * (seasonal - this.#price[c]!) + this.#price[c]! * crop.volatility * z;
      p = Math.min(crop.basePrice * 2.2, Math.max(crop.basePrice * 0.45, p));
      this.#price[c] = p;
    }
  }
}

// ------------------------------------------------------------- finance

export class FinanceSystem implements System {
  readonly id = "farm.finance";
  readonly everyNTicks = 1;
  readonly reads: readonly BufferId[] = [MONEY, YTD, WORKERS];
  readonly writes: readonly BufferId[] = [MONEY, YTD];
  #money!: Float64Array;
  #ytd!: Float64Array;
  #workers!: Uint8Array;

  init(ctx: SystemContext): void {
    this.#money = ctx.buffer<Float64Array>(MONEY);
    this.#ytd = ctx.buffer<Float64Array>(YTD);
    this.#workers = ctx.buffer<Uint8Array>(WORKERS);
  }

  update(): void {
    const interest = (this.#money[M_DEBT]! * INTEREST_RATE) / DAYS_PER_YEAR;
    this.#money[M_DEBT]! += interest;
    this.#ytd[YTD_INTEREST]! += interest;

    const wages = this.#workers[0]! * WAGE_PER_DAY;
    this.#money[M_CASH]! -= wages;
    this.#ytd[YTD_LABOR]! += wages;
  }
}

// ------------------------------------------------------------- year end

const YEAR_END_READS: readonly BufferId[] = [
  MONEY, YTD, CROP_YTD, FIELD_YTD_UNITS, FIELD_OWNED, FIELD_ACRES,
  EQUIP_LEVEL, STORED, PRICE,
];

/** Net worth from the state buffers: cash + land + equipment + stored crops − debt. */
export function computeNetWorth(views: {
  money: Float64Array; owned: Uint8Array; acres: Float32Array;
  equip: Uint8Array; stored: Float64Array; price: Float32Array;
}, landPricePerAcre: number): number {
  let landValue = 0;
  for (let f = 0; f < FIELD_COUNT; f += 1) {
    if (views.owned[f] === 1) {
      landValue += views.acres[f]! * landPricePerAcre;
    }
  }
  let equipValue = 0;
  for (let e = 0; e < EQUIP_COUNT; e += 1) {
    equipValue += EQUIPMENT[e]!.value[views.equip[e]! - 1]!;
  }
  let storedValue = 0;
  for (let c = 1; c <= CROP_COUNT; c += 1) {
    storedValue += views.stored[c]! * views.price[c]!;
  }
  return views.money[M_CASH]! + landValue + equipValue + storedValue - views.money[M_DEBT]!;
}

export class YearEndSystem implements System {
  readonly id = "farm.yearEnd";
  readonly everyNTicks = 1;
  readonly reads = YEAR_END_READS;
  readonly writes = YEAR_END_READS;
  readonly #events: EventQueue<FarmEvent>;
  readonly #landPricePerAcre: number;
  #b!: {
    money: Float64Array; ytd: Float64Array; cropYtd: Float64Array;
    fieldYtd: Float64Array; owned: Uint8Array; acres: Float32Array;
    equip: Uint8Array; stored: Float64Array; price: Float32Array;
  };

  constructor(events: EventQueue<FarmEvent>, landPricePerAcre: number) {
    this.#events = events;
    this.#landPricePerAcre = landPricePerAcre;
  }

  init(ctx: SystemContext): void {
    this.#b = {
      money: ctx.buffer<Float64Array>(MONEY),
      ytd: ctx.buffer<Float64Array>(YTD),
      cropYtd: ctx.buffer<Float64Array>(CROP_YTD),
      fieldYtd: ctx.buffer<Float64Array>(FIELD_YTD_UNITS),
      owned: ctx.buffer<Uint8Array>(FIELD_OWNED),
      acres: ctx.buffer<Float32Array>(FIELD_ACRES),
      equip: ctx.buffer<Uint8Array>(EQUIP_LEVEL),
      stored: ctx.buffer<Float64Array>(STORED),
      price: ctx.buffer<Float32Array>(PRICE),
    };
  }

  update(ctx: SystemContext): void {
    const day = Number(ctx.tick);
    if (dayOfYear(day) !== DAYS_PER_YEAR - 1) {
      return;
    }
    const b = this.#b;

    // Annual land costs on owned acres.
    let ownedAcres = 0;
    for (let f = 0; f < FIELD_COUNT; f += 1) {
      if (b.owned[f] === 1) {
        ownedAcres += b.acres[f]!;
      }
    }
    const landCost = ownedAcres * LAND_COST_PER_ACRE;
    b.money[M_CASH]! -= landCost;
    b.ytd[YTD_LAND]! += landCost;

    const expenseBreakdown = {
      seed: b.ytd[YTD_SEED]!,
      fertilizer: b.ytd[YTD_FERTILIZER]!,
      irrigation: b.ytd[YTD_IRRIGATION]!,
      machinery: b.ytd[YTD_MACHINERY]!,
      labor: b.ytd[YTD_LABOR]!,
      interest: b.ytd[YTD_INTEREST]!,
      land: b.ytd[YTD_LAND]!,
    };
    const expenses = Object.values(expenseBreakdown).reduce((a, v) => a + v, 0);
    const revenue = b.ytd[YTD_REVENUE]!;
    const summary: YearSummary = {
      year: calendarDate(day).year,
      revenue,
      expenses,
      profit: revenue - expenses,
      cash: b.money[M_CASH]!,
      debt: b.money[M_DEBT]!,
      netWorth: computeNetWorth(b, this.#landPricePerAcre),
      expenseBreakdown,
      byCrop: CROPS.map((crop) => {
        const base = crop.code * CY_STRIDE;
        return {
          crop: crop.key,
          unit: crop.unit,
          units: b.cropYtd[base + CY_UNITS]!,
          revenue: b.cropYtd[base + CY_REVENUE]!,
          cost: b.cropYtd[base + CY_COST]!,
          profit: b.cropYtd[base + CY_REVENUE]! - b.cropYtd[base + CY_COST]!,
        };
      }).filter((row) => row.units > 0 || row.revenue > 0 || row.cost > 0),
      byField: FIELDS.map((f) => ({ field: f.name, units: b.fieldYtd[f.id]! })).filter((row) => row.units > 0),
    };
    this.#events.emit({
      tick: ctx.tick,
      kind: "year",
      message: `Year ${summary.year} closed: revenue $${Math.round(revenue).toLocaleString("en-US")}, profit $${Math.round(summary.profit).toLocaleString("en-US")}`,
      data: { summary },
    });

    b.ytd.fill(0);
    b.cropYtd.fill(0);
    b.fieldYtd.fill(0);
  }
}
