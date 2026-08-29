// Static domain data: crops, equipment, labor, and economic constants.
// Everything here is *rules*, not state — a snapshot never carries it, and
// changing a number here is a balance change, not a schema change.

/** Crop codes as stored in FIELD_CROP (0 = no crop). */
export const NO_CROP = 0;
export const CORN = 1;
export const SOYBEANS = 2;
export const WHEAT = 3;
export const POTATOES = 4;
export const HAY = 5;
export const TOMATOES = 6;
/** Number of plantable crops; crop codes are 1..CROP_COUNT. */
export const CROP_COUNT = 6;

export type RotationGroup = "grass" | "legume" | "root" | "veg";

export interface CropDef {
  readonly code: number;
  /** Stable protocol key ("corn"), used on the wire and in UI registries. */
  readonly key: string;
  readonly name: string;
  /** Sale unit: bushels, hundredweight, or tons. */
  readonly unit: string;
  /** Units/acre under ideal conditions. */
  readonly baseYield: number;
  /** $/acre charged when planting works the acre. */
  readonly seedCost: number;
  /** Day-of-year planting window: [opens, optimal-through, closes]. Planting
   * inside [opens, optimalEnd] carries no date penalty; from optimalEnd to
   * closes the potential decays linearly to LATE_PLANT_FLOOR. */
  readonly plantWindow: readonly [number, number, number];
  /** Days from planting to maturity when temperature and moisture are ideal. */
  readonly growDays: number;
  /** Fraction of the fertility scale the crop draws over a full season. */
  readonly fertNeed: number;
  /** Soil-moisture level (0..1) below which the crop accumulates stress. */
  readonly waterNeed: number;
  /** Multiplier on daily moisture stress — how badly drought hurts. */
  readonly droughtSensitivity: number;
  /** Overnight low (°F) at or below which a standing crop takes frost damage. */
  readonly frostKillTemp: number;
  /** Long-term average price, $/unit. */
  readonly basePrice: number;
  /** Daily price volatility as a fraction of price. */
  readonly volatility: number;
  /** Seasonal price swing amplitude (fraction of base, peak in spring). */
  readonly seasonalAmp: number;
  /** Labor, hours/acre. */
  readonly laborPlant: number;
  readonly laborHarvest: number;
  /** Days past maturity before yield starts decaying. */
  readonly harvestGraceDays: number;
  /** Hay-style regrowth: cuttings per season past the first. */
  readonly maxCuttings: number;
  /** Days from a cutting back to mature regrowth. */
  readonly regrowDays: number;
  readonly rotationGroup: RotationGroup;
}

export const CROPS: readonly CropDef[] = Object.freeze([
  {
    code: CORN, key: "corn", name: "Corn", unit: "bu",
    baseYield: 180, seedCost: 195,
    plantWindow: [100, 130, 152], growDays: 115,
    fertNeed: 0.55, waterNeed: 0.55, droughtSensitivity: 1.2, frostKillTemp: 30,
    basePrice: 4.8, volatility: 0.012, seasonalAmp: 0.05,
    laborPlant: 0.12, laborHarvest: 0.18, harvestGraceDays: 21,
    maxCuttings: 1, regrowDays: 0, rotationGroup: "grass",
  },
  {
    code: SOYBEANS, key: "soybeans", name: "Soybeans", unit: "bu",
    baseYield: 55, seedCost: 115,
    plantWindow: [120, 152, 175], growDays: 95,
    fertNeed: 0.2, waterNeed: 0.5, droughtSensitivity: 1.0, frostKillTemp: 32,
    basePrice: 11.5, volatility: 0.011, seasonalAmp: 0.04,
    laborPlant: 0.1, laborHarvest: 0.15, harvestGraceDays: 18,
    maxCuttings: 1, regrowDays: 0, rotationGroup: "legume",
  },
  {
    code: WHEAT, key: "wheat", name: "Wheat", unit: "bu",
    baseYield: 75, seedCost: 85,
    plantWindow: [70, 96, 118], growDays: 85,
    fertNeed: 0.35, waterNeed: 0.45, droughtSensitivity: 0.8, frostKillTemp: 24,
    basePrice: 6.1, volatility: 0.01, seasonalAmp: 0.04,
    laborPlant: 0.09, laborHarvest: 0.14, harvestGraceDays: 14,
    maxCuttings: 1, regrowDays: 0, rotationGroup: "grass",
  },
  {
    code: POTATOES, key: "potatoes", name: "Potatoes", unit: "cwt",
    baseYield: 380, seedCost: 620,
    plantWindow: [95, 122, 142], growDays: 100,
    fertNeed: 0.6, waterNeed: 0.65, droughtSensitivity: 1.5, frostKillTemp: 31,
    basePrice: 9.75, volatility: 0.02, seasonalAmp: 0.06,
    laborPlant: 0.2, laborHarvest: 0.35, harvestGraceDays: 14,
    maxCuttings: 1, regrowDays: 0, rotationGroup: "root",
  },
  {
    code: HAY, key: "hay", name: "Hay / Alfalfa", unit: "ton",
    baseYield: 1.6, seedCost: 70,
    plantWindow: [80, 122, 152], growDays: 55,
    fertNeed: 0.22, waterNeed: 0.45, droughtSensitivity: 0.7, frostKillTemp: 22,
    basePrice: 165, volatility: 0.008, seasonalAmp: 0.03,
    laborPlant: 0.08, laborHarvest: 0.12, harvestGraceDays: 12,
    maxCuttings: 3, regrowDays: 35, rotationGroup: "legume",
  },
  {
    code: TOMATOES, key: "tomatoes", name: "Tomatoes", unit: "ton",
    baseYield: 26, seedCost: 1350,
    plantWindow: [130, 148, 162], growDays: 85,
    fertNeed: 0.65, waterNeed: 0.7, droughtSensitivity: 1.8, frostKillTemp: 34,
    basePrice: 92, volatility: 0.028, seasonalAmp: 0.05,
    laborPlant: 0.4, laborHarvest: 0.6, harvestGraceDays: 8,
    maxCuttings: 1, regrowDays: 0, rotationGroup: "veg",
  },
]);

/** Crop by code (1..CROP_COUNT); throws on anything else. */
export function cropByCode(code: number): CropDef {
  const crop = CROPS[code - 1];
  if (crop === undefined || crop.code !== code) {
    throw new Error(`no crop with code ${code}`);
  }
  return crop;
}

export function cropByKey(key: string): CropDef {
  const crop = CROPS.find((c) => c.key === key);
  if (crop === undefined) {
    throw new Error(`no crop with key "${key}"`);
  }
  return crop;
}

// ------------------------------------------------------------ operations

/** Operation kinds as stored in OP_KIND (0 = empty slot). */
export const OP_NONE = 0;
export const OP_PLANT = 1;
export const OP_FERTILIZE = 2;
export const OP_IRRIGATE = 3;
export const OP_HARVEST = 4;

export const OP_KEYS: Readonly<Record<number, string>> = Object.freeze({
  [OP_PLANT]: "plant",
  [OP_FERTILIZE]: "fertilize",
  [OP_IRRIGATE]: "irrigate",
  [OP_HARVEST]: "harvest",
});

export function opKindByKey(key: string): number {
  const entry = Object.entries(OP_KEYS).find(([, k]) => k === key);
  if (entry === undefined) {
    throw new Error(`no operation kind "${key}"`);
  }
  return Number(entry[0]);
}

/** Op-slot statuses. */
export const OP_STATUS_EMPTY = 0;
export const OP_STATUS_QUEUED = 1;
export const OP_STATUS_ACTIVE = 2;

// ------------------------------------------------------------ equipment

export const EQUIP_PLANTER = 0;
export const EQUIP_APPLICATOR = 1;
export const EQUIP_HARVESTER = 2;
export const EQUIP_IRRIGATOR = 3;
export const EQUIP_COUNT = 4;

export interface EquipDef {
  readonly cat: number;
  readonly key: string;
  readonly name: string;
  /** Which op kind this machine performs. */
  readonly opKind: number;
  /** Acres/day by level (index 0 = level 1). */
  readonly capacity: readonly number[];
  /** Purchase price of the upgrade *to* each level (index 0 unused: level 1
   * comes with the farm). */
  readonly upgradeCost: readonly number[];
  /** Resale/book value by level, for net worth. */
  readonly value: readonly number[];
  /** Operating cost, $/acre worked (fuel + wear). */
  readonly opCost: number;
  /** Material cost, $/acre worked (fertilizer product, irrigation water). */
  readonly materialCost: number;
  /** Labor, hours/acre worked. */
  readonly laborPerAcre: number;
}

export const EQUIPMENT: readonly EquipDef[] = Object.freeze([
  {
    cat: EQUIP_PLANTER, key: "planter", name: "Planter", opKind: OP_PLANT,
    capacity: [40, 70, 110], upgradeCost: [0, 85_000, 150_000],
    value: [60_000, 130_000, 260_000],
    opCost: 9, materialCost: 0, laborPerAcre: 0.12,
  },
  {
    cat: EQUIP_APPLICATOR, key: "applicator", name: "Fertilizer applicator", opKind: OP_FERTILIZE,
    capacity: [60, 100, 150], upgradeCost: [0, 40_000, 70_000],
    value: [25_000, 60_000, 120_000],
    opCost: 6, materialCost: 38, laborPerAcre: 0.05,
  },
  {
    cat: EQUIP_HARVESTER, key: "harvester", name: "Harvester", opKind: OP_HARVEST,
    capacity: [30, 55, 85], upgradeCost: [0, 220_000, 380_000],
    value: [180_000, 360_000, 700_000],
    opCost: 16, materialCost: 0, laborPerAcre: 0.18,
  },
  {
    cat: EQUIP_IRRIGATOR, key: "irrigator", name: "Irrigation rig", opKind: OP_IRRIGATE,
    capacity: [35, 60, 90], upgradeCost: [0, 60_000, 110_000],
    value: [40_000, 90_000, 180_000],
    opCost: 4, materialCost: 14, laborPerAcre: 0.03,
  },
]);

export const MAX_EQUIP_LEVEL = 3;

export function equipForOp(opKind: number): EquipDef {
  const def = EQUIPMENT.find((e) => e.opKind === opKind);
  if (def === undefined) {
    throw new Error(`no equipment performs op kind ${opKind}`);
  }
  return def;
}

// ------------------------------------------------------------ economy

/** Hours one worker contributes per day. */
export const HOURS_PER_WORKER = 10;
/** $/worker/day, charged every day workers are on the payroll. */
export const WAGE_PER_DAY = 160;
export const MIN_WORKERS = 1;
export const MAX_WORKERS = 8;

/** $/acre to buy neighboring parcels; also the land value for net worth. */
export const LAND_PRICE_PER_ACRE = 5500;
/** $/acre to clear and work new ground into a field. */
export const CLEAR_COST_PER_ACRE = 30;
/** $/acre/year property + upkeep cost, charged at year end on owned acres. */
export const LAND_COST_PER_ACRE = 18;

/** Annual interest rate on the operating debt. */
export const INTEREST_RATE = 0.065;
/** Punitive annual rate on a negative cash balance — running the checkbook
 * red is an implicit loan on far worse terms than the bank's. */
export const OVERDRAFT_RATE = 0.14;
/** Borrowing is capped at this fraction of land + equipment value. */
export const DEBT_LIMIT_RATIO = 0.65;

/** Total on-farm crop storage, in sale units (shared across crops). */
export const STORAGE_CAPACITY = 25_000;
/** Discount taken when a harvest overflows storage and is sold at once. */
export const OVERFLOW_SALE_DISCOUNT = 0.97;

/** Effect of one completed fertilizer pass on a field's fertility (0..1). */
export const FERTILIZE_EFFECT = 0.28;
/** Effect of one completed irrigation pass on soil moisture (0..1). */
export const IRRIGATE_EFFECT = 0.25;

/** Fieldwork stops when today's rain exceeds this (inches)... */
export const RAIN_BLOCK_INCHES = 0.35;
/** ...or when the field itself is wetter than this. */
export const MUD_BLOCK_MOISTURE = 0.85;
/** Planting also needs the ground thawed. */
export const PLANT_MIN_HIGH_TEMP = 40;

/** Late planting decays yield potential linearly to this floor at window close. */
export const LATE_PLANT_FLOOR = 0.55;

/** Day of year on which any still-standing crop is lost to winter. */
export const SEASON_END_DOY = 340;

// ------------------------------------------------------------ calendar

export const DAYS_PER_YEAR = 365;

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export interface CalendarDate {
  /** 1-based simulation year. */
  readonly year: number;
  /** 0-based day of year. */
  readonly doy: number;
  readonly month: string;
  readonly dayOfMonth: number;
  readonly season: "winter" | "spring" | "summer" | "fall";
  /** e.g. "Y3 Apr 12". */
  readonly label: string;
}

/** Absolute day (tick) → calendar date. Day 0 is Jan 1 of year 1. */
export function calendarDate(day: number): CalendarDate {
  const year = Math.floor(day / DAYS_PER_YEAR) + 1;
  const doy = ((day % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
  let remaining = doy;
  let monthIndex = 0;
  while (remaining >= MONTH_LENGTHS[monthIndex]!) {
    remaining -= MONTH_LENGTHS[monthIndex]!;
    monthIndex += 1;
  }
  const season =
    doy < 59 || doy >= 335 ? "winter" : doy < 151 ? "spring" : doy < 243 ? "summer" : "fall";
  const month = MONTH_NAMES[monthIndex]!;
  const dayOfMonth = remaining + 1;
  return { year, doy, month, dayOfMonth, season, label: `Y${year} ${month} ${dayOfMonth}` };
}

export function dayOfYear(day: number): number {
  return ((day % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
}
