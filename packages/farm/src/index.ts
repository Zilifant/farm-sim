// @sim/farm — a farm-management simulation on @sim/runtime. One tick is one
// day; the player starts with a homestead on one parcel of land, places
// fields freely on owned ground, and runs the farm as a business — buying
// neighboring parcels to grow the placeable area. Deterministic:
// (seed, config, command log) reproduces a run.

import {
  BufferRegistry,
  RingProfiler,
  Sfc32Stream,
  SimEventQueue,
  SystemScheduler,
  TickExecutor,
  hashBuffers,
  seedToU32,
  type ReplayLog,
  type Snapshot,
} from "@sim/runtime";
import {
  CLEAR_COST_PER_ACRE, CROPS, CROP_COUNT, DEBT_LIMIT_RATIO, EQUIPMENT, EQUIP_COUNT,
  ROAD_COST_PER_CELL,
  LAND_PRICE_PER_ACRE, MAX_EQUIP_LEVEL, MAX_WORKERS, MIN_WORKERS,
  OP_FERTILIZE, OP_HARVEST, OP_IRRIGATE, OP_KEYS, OP_PLANT,
  OP_STATUS_EMPTY, OP_STATUS_QUEUED, STORAGE_CAPACITY,
  calendarDate, cropByCode,
  type CalendarDate,
} from "./catalog.js";
import {
  FARM_BORROW, FARM_BUILD_ROAD, FARM_BUY_EQUIPMENT, FARM_BUY_PARCEL,
  FARM_CANCEL_OP, FARM_CREATE_FIELD, FARM_REMOVE_FIELD, FARM_REMOVE_ROAD,
  FARM_REPAY, FARM_SCHEDULE_OP, FARM_SELL, FARM_SET_WORKERS,
  type BorrowCommand, type BuildRoadCommand, type BuyEquipmentCommand,
  type BuyParcelCommand, type CancelOpCommand, type CreateFieldCommand,
  type FarmCommand, type RemoveFieldCommand, type RemoveRoadCommand,
  type RepayCommand, type ScheduleOpCommand, type SellCommand,
  type SetWorkersCommand,
} from "./commands.js";
import {
  HOMESTEAD_PARCEL_ID, PARCELS, PARCEL_COUNT, WORLD_WIDTH,
  computeFieldReachability, fieldPlacementError, rectAcres, roadPlacementError,
  soilQualityOver,
  type Cell, type Rect,
} from "./layout.js";
import { makeFarmSnapshot, restoreFarmSnapshot } from "./snapshot.js";
import {
  FinanceSystem, GrowthSystem, MarketSystem, OperationsSystem,
  SoilSystem, WeatherSystem, YearEndSystem, computeNetWorth, fieldLabel,
  ownedLandValue,
  type FarmEvent,
} from "./systems.js";
import {
  CROP_YTD, CY_STRIDE, CY_REVENUE,
  EQUIP_LEVEL, FIELD_ACRES, FIELD_ACTIVE, FIELD_CROP, FIELD_CUTTINGS,
  FIELD_DAMAGE, FIELD_FERTILITY, FIELD_GROW_DAYS, FIELD_H, FIELD_MATURE_DAY,
  FIELD_MOISTURE, FIELD_NUM, FIELD_PLANT_DAY, FIELD_PLANT_FACTOR,
  FIELD_PREV_CROP, FIELD_PROGRESS, FIELD_SOIL_QUALITY, FIELD_STAGE,
  FIELD_STRESS, FIELD_FERT_SUM, FIELD_W, FIELD_X, FIELD_Y,
  FIELD_YIELD_EST, FIELD_YIELD_LAST, FIELD_YTD_UNITS,
  DIRT_ROADS, MAX_FIELDS, MAX_OPS, MONEY, M_CASH, M_DEBT, M_NEXT_FIELD_NUM, M_NEXT_OP_SEQ,
  OP_ACRES_DONE, OP_CROP, OP_FACTOR_SUM, OP_FIELD, OP_KIND, OP_SEQ, OP_STATUS,
  PARCEL_OWNED, PRICE, STAGE_NAMES, STAGE_UNPLANTED, STORED, WORKERS,
  YTD, YTD_LAND, YTD_REVENUE,
  STATE_BUFFERS, defineFarmBuffers, resolveConfig,
  type FarmConfig,
} from "./state.js";
import { forecastFor, weatherFor, type DailyWeather, type ForecastDay } from "./weather.js";

export * from "./catalog.js";
export * from "./commands.js";
export * from "./layout.js";
export * from "./snapshot.js";
export * from "./state.js";
export * from "./systems.js";
export * from "./weather.js";

export const FARM_NAME = "@sim/farm";
/** Wall pace: one simulated day per second at speed 1. */
export const FIXED_DT_MS = 1000;

// ------------------------------------------------------------ view shapes

export interface FieldView {
  readonly id: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly acres: number;
  readonly crop: string | null;
  readonly cropCode: number;
  readonly stage: string;
  readonly stageCode: number;
  readonly progress: number;
  readonly soilQuality: number;
  readonly moisture: number;
  readonly fertility: number;
  readonly prevCrop: string | null;
  readonly plantDay: number;
  readonly expectedYield: number;
  readonly lastYield: number;
  readonly cuttings: number;
  /** Whether equipment can drive to this field (roads/driveway/neighbors). */
  readonly reachable: boolean;
}

export interface ParcelView {
  readonly id: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly acres: number;
  readonly owned: boolean;
  readonly price: number;
  readonly isHomestead: boolean;
}

export interface OpView {
  readonly seq: number;
  readonly kind: string;
  readonly field: number;
  readonly fieldName: string;
  readonly crop: string | null;
  readonly status: "queued" | "active";
  readonly acresDone: number;
  readonly acresTotal: number;
}

export interface EquipmentView {
  readonly cat: number;
  readonly key: string;
  readonly name: string;
  readonly level: number;
  readonly capacity: number;
  readonly nextCapacity: number | null;
  readonly nextCost: number | null;
}

export interface MarketView {
  readonly key: string;
  readonly name: string;
  readonly unit: string;
  readonly price: number;
  readonly basePrice: number;
  readonly stored: number;
}

export interface FinanceView {
  readonly cash: number;
  readonly debt: number;
  readonly netWorth: number;
  readonly borrowLimit: number;
  readonly revenueYtd: number;
  readonly expensesYtd: number;
  readonly workers: number;
  readonly storageUsed: number;
  readonly storageCapacity: number;
}

// ------------------------------------------------------------ sim surface

export interface FarmSim {
  readonly config: FarmConfig;
  /** Completed ticks (days). */
  readonly tick: bigint;
  readonly events: SimEventQueue<FarmEvent>;
  readonly profiler: RingProfiler;
  step(): void;
  run(ticks: number): void;
  /** FNV-1a over every state buffer, in schema order. */
  stateHash(): number;
  /** Apply a player command at the current tick boundary; validated, and
   * recorded to the replay log when one was supplied. Throws on invalid. */
  apply(cmd: FarmCommand): void;
  captureSnapshot(): Snapshot;
  restoreSnapshot(s: Snapshot): void;
  // ---- read views (for hosts/renderers; plain data, computed on demand)
  date(): CalendarDate;
  weather(): DailyWeather;
  forecast(days: number): ForecastDay[];
  /** The active fields (slot ids are stable while a field lives). */
  fields(): FieldView[];
  parcels(): ParcelView[];
  /** The player-built dirt roads, one flag per world cell (read-only view). */
  roads(): Uint8Array;
  ops(): OpView[];
  equipment(): EquipmentView[];
  markets(): MarketView[];
  finance(): FinanceView;
}

export interface FarmSimOptions {
  /** Externally injected commands are recorded here for replay. */
  readonly record?: ReplayLog;
}

export async function createFarmSim(
  config: Partial<FarmConfig> = {},
  opts: FarmSimOptions = {},
): Promise<FarmSim> {
  const cfg = resolveConfig(config);
  const seedHash = seedToU32(String(cfg.seed));

  const buffers = new BufferRegistry();
  defineFarmBuffers(buffers);
  seedInitialState(buffers, cfg);

  const events = new SimEventQueue<FarmEvent>();
  const scheduler = new SystemScheduler(buffers);
  scheduler.register(new WeatherSystem(cfg), { workerGroup: "main" });
  scheduler.register(new SoilSystem(), { workerGroup: "main" });
  scheduler.register(new OperationsSystem(events), { workerGroup: "main" });
  scheduler.register(new GrowthSystem(events), { workerGroup: "main" });
  scheduler.register(new MarketSystem(cfg), { workerGroup: "main" });
  scheduler.register(new FinanceSystem(), { workerGroup: "main" });
  scheduler.register(new YearEndSystem(events, LAND_PRICE_PER_ACRE), { workerGroup: "main" });

  const profiler = new RingProfiler();
  const executor = new TickExecutor({
    plan: scheduler.plan(),
    buffers,
    rng: Sfc32Stream.create(cfg.seed, "farm"),
    fixedDtMs: FIXED_DT_MS,
    profiler,
  });
  await executor.init();

  let tick = 0n;

  const b: Views = {
    active: buffers.get<Uint8Array>(FIELD_ACTIVE),
    num: buffers.get<Uint8Array>(FIELD_NUM),
    fx: buffers.get<Uint8Array>(FIELD_X),
    fy: buffers.get<Uint8Array>(FIELD_Y),
    fw: buffers.get<Uint8Array>(FIELD_W),
    fh: buffers.get<Uint8Array>(FIELD_H),
    acres: buffers.get<Float32Array>(FIELD_ACRES),
    soilQ: buffers.get<Float32Array>(FIELD_SOIL_QUALITY),
    moisture: buffers.get<Float32Array>(FIELD_MOISTURE),
    fertility: buffers.get<Float32Array>(FIELD_FERTILITY),
    crop: buffers.get<Uint8Array>(FIELD_CROP),
    prevCrop: buffers.get<Uint8Array>(FIELD_PREV_CROP),
    stage: buffers.get<Uint8Array>(FIELD_STAGE),
    progress: buffers.get<Float32Array>(FIELD_PROGRESS),
    plantDay: buffers.get<Int32Array>(FIELD_PLANT_DAY),
    matureDay: buffers.get<Int32Array>(FIELD_MATURE_DAY),
    growDays: buffers.get<Int32Array>(FIELD_GROW_DAYS),
    plantFactor: buffers.get<Float32Array>(FIELD_PLANT_FACTOR),
    stress: buffers.get<Float32Array>(FIELD_STRESS),
    fertSum: buffers.get<Float32Array>(FIELD_FERT_SUM),
    damage: buffers.get<Float32Array>(FIELD_DAMAGE),
    cuttings: buffers.get<Uint8Array>(FIELD_CUTTINGS),
    yieldEst: buffers.get<Float32Array>(FIELD_YIELD_EST),
    yieldLast: buffers.get<Float32Array>(FIELD_YIELD_LAST),
    parcelOwned: buffers.get<Uint8Array>(PARCEL_OWNED),
    dirtRoads: buffers.get<Uint8Array>(DIRT_ROADS),
    opKind: buffers.get<Uint8Array>(OP_KIND),
    opField: buffers.get<Uint8Array>(OP_FIELD),
    opCrop: buffers.get<Uint8Array>(OP_CROP),
    opStatus: buffers.get<Uint8Array>(OP_STATUS),
    opAcres: buffers.get<Float32Array>(OP_ACRES_DONE),
    opSeq: buffers.get<Int32Array>(OP_SEQ),
    opFactor: buffers.get<Float32Array>(OP_FACTOR_SUM),
    equip: buffers.get<Uint8Array>(EQUIP_LEVEL),
    workers: buffers.get<Uint8Array>(WORKERS),
    price: buffers.get<Float32Array>(PRICE),
    stored: buffers.get<Float64Array>(STORED),
    money: buffers.get<Float64Array>(MONEY),
    ytd: buffers.get<Float64Array>(YTD),
    cropYtd: buffers.get<Float64Array>(CROP_YTD),
    fieldYtd: buffers.get<Float64Array>(FIELD_YTD_UNITS),
    seedHash,
  };

  const stateViews = (): ArrayBufferView[] => STATE_BUFFERS.map((id) => buffers.get(id));

  const apply = (cmd: FarmCommand): void => {
    applyCommand(b, cmd);
    opts.record?.record(tick, { tick, commands: [cmd] });
  };

  return {
    config: cfg,
    get tick(): bigint {
      return tick;
    },
    events,
    profiler,
    step(): void {
      executor.runTick(tick);
      tick += 1n;
    },
    run(ticks: number): void {
      if (!Number.isInteger(ticks) || ticks < 0) {
        throw new Error("ticks must be an integer >= 0");
      }
      for (let i = 0; i < ticks; i += 1) {
        executor.runTick(tick);
        tick += 1n;
      }
    },
    stateHash(): number {
      return hashBuffers(stateViews());
    },
    apply,
    captureSnapshot(): Snapshot {
      return makeFarmSnapshot(cfg, tick, buffers);
    },
    restoreSnapshot(s: Snapshot): void {
      tick = restoreFarmSnapshot(cfg, buffers, s);
    },
    date(): CalendarDate {
      return calendarDate(Number(tick));
    },
    weather(): DailyWeather {
      // Today's weather is what the *next* tick will apply; computing it from
      // the counter keeps the view exact even before the first step.
      return weatherFor(seedHash, Number(tick));
    },
    forecast(days: number): ForecastDay[] {
      const n = Math.max(1, Math.min(10, Math.floor(days)));
      const today = Number(tick);
      return Array.from({ length: n }, (_, i) => forecastFor(seedHash, today, i + 1));
    },
    fields(): FieldView[] {
      const rows: FieldView[] = [];
      const slots: number[] = [];
      for (let f = 0; f < MAX_FIELDS; f += 1) {
        if (b.active[f] !== 1) {
          continue;
        }
        slots.push(f);
      }
      const reachable = computeFieldReachability(
        slots.map((f) => ({ x: b.fx[f]!, y: b.fy[f]!, w: b.fw[f]!, h: b.fh[f]! })),
        b.dirtRoads,
      );
      for (let i = 0; i < slots.length; i += 1) {
        const f = slots[i]!;
        const cropCode = b.crop[f]!;
        rows.push({
          id: f,
          name: fieldLabel(b.num[f]!),
          x: b.fx[f]!,
          y: b.fy[f]!,
          w: b.fw[f]!,
          h: b.fh[f]!,
          acres: b.acres[f]!,
          crop: cropCode === 0 ? null : cropByCode(cropCode).key,
          cropCode,
          stage: STAGE_NAMES[b.stage[f]!]!,
          stageCode: b.stage[f]!,
          progress: b.progress[f]!,
          soilQuality: b.soilQ[f]!,
          moisture: b.moisture[f]!,
          fertility: b.fertility[f]!,
          prevCrop: b.prevCrop[f]! === 0 ? null : cropByCode(b.prevCrop[f]!).key,
          plantDay: b.plantDay[f]!,
          expectedYield: b.yieldEst[f]!,
          lastYield: b.yieldLast[f]!,
          cuttings: b.cuttings[f]!,
          reachable: reachable[i]!,
        });
      }
      return rows;
    },
    roads(): Uint8Array {
      return b.dirtRoads;
    },
    parcels(): ParcelView[] {
      return PARCELS.map((p) => ({
        id: p.id,
        name: p.name,
        x: p.rect.x,
        y: p.rect.y,
        w: p.rect.w,
        h: p.rect.h,
        acres: p.acres,
        owned: b.parcelOwned[p.id] === 1,
        price: Math.round(p.acres * LAND_PRICE_PER_ACRE),
        isHomestead: p.isHomestead,
      }));
    },
    ops(): OpView[] {
      const rows: OpView[] = [];
      for (let s = 0; s < MAX_OPS; s += 1) {
        if (b.opStatus[s] === OP_STATUS_EMPTY) {
          continue;
        }
        const f = b.opField[s]!;
        rows.push({
          seq: b.opSeq[s]!,
          kind: OP_KEYS[b.opKind[s]!]!,
          field: f,
          fieldName: fieldLabel(b.num[f]!),
          crop: b.opCrop[s]! === 0 ? null : cropByCode(b.opCrop[s]!).key,
          status: b.opStatus[s] === OP_STATUS_QUEUED ? "queued" : "active",
          acresDone: b.opAcres[s]!,
          acresTotal: b.acres[f]!,
        });
      }
      rows.sort((x, y) => x.seq - y.seq);
      return rows;
    },
    equipment(): EquipmentView[] {
      return EQUIPMENT.map((def) => {
        const level = b.equip[def.cat]!;
        const upgradable = level < MAX_EQUIP_LEVEL;
        return {
          cat: def.cat,
          key: def.key,
          name: def.name,
          level,
          capacity: def.capacity[level - 1]!,
          nextCapacity: upgradable ? def.capacity[level]! : null,
          nextCost: upgradable ? def.upgradeCost[level]! : null,
        };
      });
    },
    markets(): MarketView[] {
      return CROPS.map((crop) => ({
        key: crop.key,
        name: crop.name,
        unit: crop.unit,
        price: b.price[crop.code]!,
        basePrice: crop.basePrice,
        stored: b.stored[crop.code]!,
      }));
    },
    finance(): FinanceView {
      let storageUsed = 0;
      for (let c = 1; c <= CROP_COUNT; c += 1) {
        storageUsed += b.stored[c]!;
      }
      let expensesYtd = 0;
      for (let i = 1; i < b.ytd.length; i += 1) {
        expensesYtd += b.ytd[i]!;
      }
      return {
        cash: b.money[M_CASH]!,
        debt: b.money[M_DEBT]!,
        netWorth: computeNetWorth(b, LAND_PRICE_PER_ACRE),
        borrowLimit: borrowLimit(b),
        revenueYtd: b.ytd[YTD_REVENUE]!,
        expensesYtd,
        workers: b.workers[0]!,
        storageUsed,
        storageCapacity: STORAGE_CAPACITY,
      };
    },
  };
}

// ------------------------------------------------------------ init

function seedInitialState(buffers: BufferRegistry, cfg: FarmConfig): void {
  const rng = Sfc32Stream.create(cfg.seed, "farm-init");
  const u = (): number => rng.nextU32() / 0x100000000;

  // The land: the homestead parcel and nothing else. Fields are the
  // player's to place.
  buffers.get<Uint8Array>(PARCEL_OWNED)[HOMESTEAD_PARCEL_ID] = 1;
  buffers.get<Int32Array>(FIELD_PLANT_DAY).fill(-1);
  buffers.get<Int32Array>(FIELD_MATURE_DAY).fill(-1);

  buffers.get<Uint8Array>(EQUIP_LEVEL).fill(1);
  buffers.get<Uint8Array>(WORKERS)[0] = cfg.startWorkers;

  const price = buffers.get<Float32Array>(PRICE);
  for (const crop of CROPS) {
    price[crop.code] = crop.basePrice * (0.92 + u() * 0.16);
  }

  const money = buffers.get<Float64Array>(MONEY);
  money[M_CASH] = cfg.startCash;
  money[M_DEBT] = cfg.startDebt;
  money[M_NEXT_OP_SEQ] = 1;
  money[M_NEXT_FIELD_NUM] = 1;
}

// ------------------------------------------------------------ commands

interface Views {
  active: Uint8Array; num: Uint8Array;
  fx: Uint8Array; fy: Uint8Array; fw: Uint8Array; fh: Uint8Array;
  acres: Float32Array; soilQ: Float32Array; moisture: Float32Array;
  fertility: Float32Array; crop: Uint8Array; prevCrop: Uint8Array;
  stage: Uint8Array; progress: Float32Array; plantDay: Int32Array;
  matureDay: Int32Array; growDays: Int32Array; plantFactor: Float32Array;
  stress: Float32Array; fertSum: Float32Array; damage: Float32Array;
  cuttings: Uint8Array; yieldEst: Float32Array; yieldLast: Float32Array;
  parcelOwned: Uint8Array;
  dirtRoads: Uint8Array;
  opKind: Uint8Array; opField: Uint8Array; opCrop: Uint8Array; opStatus: Uint8Array;
  opAcres: Float32Array; opSeq: Int32Array; opFactor: Float32Array;
  equip: Uint8Array; workers: Uint8Array; price: Float32Array; stored: Float64Array;
  money: Float64Array; ytd: Float64Array; cropYtd: Float64Array; fieldYtd: Float64Array;
  seedHash: number;
}

function borrowLimit(v: Pick<Views, "parcelOwned" | "equip">): number {
  let assetValue = ownedLandValue(v.parcelOwned, LAND_PRICE_PER_ACRE);
  for (let e = 0; e < EQUIP_COUNT; e += 1) {
    assetValue += EQUIPMENT[e]!.value[v.equip[e]! - 1]!;
  }
  return assetValue * DEBT_LIMIT_RATIO;
}

function requireActiveField(v: Views, field: number): void {
  if (!Number.isInteger(field) || field < 0 || field >= MAX_FIELDS || v.active[field] !== 1) {
    throw new Error(`no field with id ${field}`);
  }
}

function requireAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("amount must be a positive number");
  }
}

function applyCommand(v: Views, cmd: FarmCommand): void {
  switch (cmd.kind) {
    case FARM_SCHEDULE_OP:
      return scheduleOp(v, cmd);
    case FARM_CANCEL_OP:
      return cancelOp(v, cmd);
    case FARM_SELL:
      return sell(v, cmd);
    case FARM_BORROW:
      return borrow(v, cmd);
    case FARM_REPAY:
      return repay(v, cmd);
    case FARM_CREATE_FIELD:
      return createField(v, cmd);
    case FARM_REMOVE_FIELD:
      return removeField(v, cmd);
    case FARM_BUY_PARCEL:
      return buyParcel(v, cmd);
    case FARM_BUILD_ROAD:
      return buildRoad(v, cmd);
    case FARM_REMOVE_ROAD:
      return removeRoad(v, cmd);
    case FARM_BUY_EQUIPMENT:
      return buyEquipment(v, cmd);
    case FARM_SET_WORKERS:
      return setWorkers(v, cmd);
    default: {
      const unknown: never = cmd;
      throw new Error(`unknown farm command ${JSON.stringify(unknown)}`);
    }
  }
}

function activeFieldRects(v: Views): Rect[] {
  const rects: Rect[] = [];
  for (let f = 0; f < MAX_FIELDS; f += 1) {
    if (v.active[f] === 1) {
      rects.push({ x: v.fx[f]!, y: v.fy[f]!, w: v.fw[f]!, h: v.fh[f]! });
    }
  }
  return rects;
}

function createField(v: Views, cmd: CreateFieldCommand): void {
  const r: Rect = { x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h };
  const error = fieldPlacementError(r, v.parcelOwned, activeFieldRects(v), v.dirtRoads);
  if (error !== null) {
    throw new Error(error);
  }
  let slot = -1;
  for (let f = 0; f < MAX_FIELDS; f += 1) {
    if (v.active[f] !== 1) {
      slot = f;
      break;
    }
  }
  if (slot === -1) {
    throw new Error(`the farm already has its maximum of ${MAX_FIELDS} fields`);
  }
  const acres = rectAcres(r);
  const cost = acres * CLEAR_COST_PER_ACRE;
  if (v.money[M_CASH]! < cost) {
    throw new Error(`clearing ${Math.round(acres)} acres costs $${Math.round(cost).toLocaleString("en-US")}; not enough cash`);
  }
  v.money[M_CASH]! -= cost;

  const num = v.money[M_NEXT_FIELD_NUM]!;
  v.money[M_NEXT_FIELD_NUM] = num + 1;
  v.active[slot] = 1;
  v.num[slot] = num;
  v.fx[slot] = r.x;
  v.fy[slot] = r.y;
  v.fw[slot] = r.w;
  v.fh[slot] = r.h;
  v.acres[slot] = acres;
  // Ground conditions come from *where* the field is: the seeded soil map
  // for quality, position hashes for the starting moisture/fertility.
  v.soilQ[slot] = soilQualityOver(v.seedHash, r);
  const posU = (salt: number): number =>
    ((v.seedHash ^ (r.x * 73856093) ^ (r.y * 19349663) ^ (salt * 83492791)) >>> 0) / 0x100000000;
  v.moisture[slot] = 0.45 + posU(1) * 0.2;
  v.fertility[slot] = 0.5 + posU(2) * 0.2;
  v.crop[slot] = 0;
  v.prevCrop[slot] = 0;
  v.stage[slot] = STAGE_UNPLANTED;
  v.progress[slot] = 0;
  v.plantDay[slot] = -1;
  v.matureDay[slot] = -1;
  v.growDays[slot] = 0;
  v.plantFactor[slot] = 1;
  v.stress[slot] = 0;
  v.fertSum[slot] = 0;
  v.damage[slot] = 1;
  v.cuttings[slot] = 0;
  v.yieldEst[slot] = 0;
  v.yieldLast[slot] = 0;
  v.fieldYtd[slot] = 0;
}

function removeField(v: Views, cmd: RemoveFieldCommand): void {
  requireActiveField(v, cmd.field);
  if (v.crop[cmd.field] !== 0) {
    throw new Error(`${fieldLabel(v.num[cmd.field]!)} has a standing crop — harvest it first`);
  }
  for (let s = 0; s < MAX_OPS; s += 1) {
    if (v.opStatus[s] !== OP_STATUS_EMPTY && v.opField[s] === cmd.field) {
      throw new Error(`${fieldLabel(v.num[cmd.field]!)} has queued work — cancel it first`);
    }
  }
  v.active[cmd.field] = 0;
  v.num[cmd.field] = 0;
  v.fx[cmd.field] = 0;
  v.fy[cmd.field] = 0;
  v.fw[cmd.field] = 0;
  v.fh[cmd.field] = 0;
  v.acres[cmd.field] = 0;
  v.soilQ[cmd.field] = 0;
  v.moisture[cmd.field] = 0;
  v.fertility[cmd.field] = 0;
  v.prevCrop[cmd.field] = 0;
  v.yieldEst[cmd.field] = 0;
  v.yieldLast[cmd.field] = 0;
  v.fieldYtd[cmd.field] = 0;
}

function buildRoad(v: Views, cmd: BuildRoadCommand): void {
  const cells = normalizeCells(cmd.cells);
  const error = roadPlacementError(cells, v.parcelOwned, activeFieldRects(v), v.dirtRoads);
  if (error !== null) {
    throw new Error(error);
  }
  const cost = cells.length * ROAD_COST_PER_CELL;
  if (v.money[M_CASH]! < cost) {
    throw new Error(`grading ${cells.length} road cells costs $${cost.toLocaleString("en-US")}; not enough cash`);
  }
  v.money[M_CASH]! -= cost;
  v.ytd[YTD_LAND]! += cost;
  for (const c of cells) {
    v.dirtRoads[c.y * WORLD_WIDTH + c.x] = 1;
  }
}

function removeRoad(v: Views, cmd: RemoveRoadCommand): void {
  const cells = normalizeCells(cmd.cells);
  for (const c of cells) {
    if (v.dirtRoads[c.y * WORLD_WIDTH + c.x] !== 1) {
      throw new Error(`there is no dirt road at ${c.x},${c.y}`);
    }
  }
  for (const c of cells) {
    v.dirtRoads[c.y * WORLD_WIDTH + c.x] = 0;
  }
}

function normalizeCells(cells: BuildRoadCommand["cells"]): Cell[] {
  if (!Array.isArray(cells)) {
    throw new Error("cells must be an array of {x, y}");
  }
  const seen = new Set<string>();
  const out: Cell[] = [];
  for (const c of cells) {
    const key = `${c.x},${c.y}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ x: c.x, y: c.y });
    }
  }
  return out;
}

function buyParcel(v: Views, cmd: BuyParcelCommand): void {
  const parcel = PARCELS[cmd.parcel];
  if (parcel === undefined) {
    throw new Error(`parcel must be a whole number in [0, ${PARCEL_COUNT})`);
  }
  if (v.parcelOwned[cmd.parcel] === 1) {
    throw new Error(`parcel ${parcel.name} is already owned`);
  }
  const cost = parcel.acres * LAND_PRICE_PER_ACRE;
  if (v.money[M_CASH]! < cost) {
    throw new Error(
      `buying parcel ${parcel.name} costs $${Math.round(cost).toLocaleString("en-US")}; not enough cash (borrow first?)`,
    );
  }
  v.money[M_CASH]! -= cost;
  v.parcelOwned[cmd.parcel] = 1;
}

function scheduleOp(v: Views, cmd: ScheduleOpCommand): void {
  requireActiveField(v, cmd.field);
  if (cmd.op !== OP_PLANT && cmd.op !== OP_FERTILIZE && cmd.op !== OP_IRRIGATE && cmd.op !== OP_HARVEST) {
    throw new Error("op must be plant (1), fertilize (2), irrigate (3), or harvest (4)");
  }
  if (cmd.op === OP_PLANT) {
    cropByCode(cmd.crop); // validates
  }
  let slot = -1;
  for (let s = 0; s < MAX_OPS; s += 1) {
    if (v.opStatus[s] === OP_STATUS_EMPTY) {
      slot = s;
      break;
    }
  }
  if (slot === -1) {
    throw new Error(`the work queue is full (${MAX_OPS} operations)`);
  }
  // One live op of a kind per field keeps the queue legible.
  for (let s = 0; s < MAX_OPS; s += 1) {
    if (v.opStatus[s] !== OP_STATUS_EMPTY && v.opField[s] === cmd.field && v.opKind[s] === cmd.op) {
      throw new Error(`${fieldLabel(v.num[cmd.field]!)} already has a ${OP_KEYS[cmd.op]} operation queued`);
    }
  }
  const seq = v.money[M_NEXT_OP_SEQ]!;
  v.money[M_NEXT_OP_SEQ] = seq + 1;
  v.opKind[slot] = cmd.op;
  v.opField[slot] = cmd.field;
  v.opCrop[slot] = cmd.op === OP_PLANT ? cmd.crop : 0;
  v.opStatus[slot] = OP_STATUS_QUEUED;
  v.opAcres[slot] = 0;
  v.opSeq[slot] = seq;
  v.opFactor[slot] = 0;
}

function cancelOp(v: Views, cmd: CancelOpCommand): void {
  for (let s = 0; s < MAX_OPS; s += 1) {
    if (v.opStatus[s] !== OP_STATUS_EMPTY && v.opSeq[s] === cmd.opSeq) {
      v.opKind[s] = 0;
      v.opField[s] = 0;
      v.opCrop[s] = 0;
      v.opStatus[s] = OP_STATUS_EMPTY;
      v.opAcres[s] = 0;
      v.opSeq[s] = 0;
      v.opFactor[s] = 0;
      return;
    }
  }
  throw new Error(`no queued operation with id ${cmd.opSeq}`);
}

function sell(v: Views, cmd: SellCommand): void {
  const crop = cropByCode(cmd.crop);
  requireAmount(cmd.units);
  const available = v.stored[cmd.crop]!;
  if (available < 0.01) {
    throw new Error(`no ${crop.name} in storage`);
  }
  const units = Math.min(cmd.units, available);
  const revenue = units * v.price[cmd.crop]!;
  v.stored[cmd.crop] = available - units;
  v.money[M_CASH]! += revenue;
  v.ytd[YTD_REVENUE]! += revenue;
  v.cropYtd[cmd.crop * CY_STRIDE + CY_REVENUE]! += revenue;
}

function borrow(v: Views, cmd: BorrowCommand): void {
  requireAmount(cmd.amount);
  const limit = borrowLimit(v);
  if (v.money[M_DEBT]! + cmd.amount > limit) {
    throw new Error(
      `that would exceed the borrowing limit of $${Math.floor(limit).toLocaleString("en-US")}`,
    );
  }
  v.money[M_DEBT]! += cmd.amount;
  v.money[M_CASH]! += cmd.amount;
}

function repay(v: Views, cmd: RepayCommand): void {
  requireAmount(cmd.amount);
  const payment = Math.min(cmd.amount, v.money[M_DEBT]!, Math.max(0, v.money[M_CASH]!));
  if (payment <= 0) {
    throw new Error("nothing to repay (no debt, or no cash)");
  }
  v.money[M_CASH]! -= payment;
  v.money[M_DEBT]! -= payment;
}

function buyEquipment(v: Views, cmd: BuyEquipmentCommand): void {
  const def = EQUIPMENT[cmd.category];
  if (def === undefined) {
    throw new Error(`equipment category must be in [0, ${EQUIP_COUNT})`);
  }
  const level = v.equip[cmd.category]!;
  if (level >= MAX_EQUIP_LEVEL) {
    throw new Error(`${def.name} is already at its top level`);
  }
  const cost = def.upgradeCost[level]!;
  if (v.money[M_CASH]! < cost) {
    throw new Error(`upgrading the ${def.name} costs $${cost.toLocaleString("en-US")}; not enough cash`);
  }
  v.money[M_CASH]! -= cost;
  v.equip[cmd.category] = level + 1;
}

function setWorkers(v: Views, cmd: SetWorkersCommand): void {
  if (!Number.isInteger(cmd.workers) || cmd.workers < MIN_WORKERS || cmd.workers > MAX_WORKERS) {
    throw new Error(`workers must be a whole number in [${MIN_WORKERS}, ${MAX_WORKERS}]`);
  }
  v.workers[0] = cmd.workers;
}
