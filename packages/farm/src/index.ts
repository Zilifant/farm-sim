// @sim/farm — a farm-management simulation on @sim/runtime. One tick is one
// day; the player plans operations, allocates capacity, and runs the farm as
// a business. Deterministic: (seed, config, command log) reproduces a run.

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
  CROPS, CROP_COUNT, DEBT_LIMIT_RATIO, EQUIPMENT, EQUIP_COUNT,
  LAND_PRICE_PER_ACRE, MAX_EQUIP_LEVEL, MAX_WORKERS, MIN_WORKERS,
  OP_FERTILIZE, OP_HARVEST, OP_IRRIGATE, OP_KEYS, OP_PLANT,
  OP_STATUS_EMPTY, OP_STATUS_QUEUED, STORAGE_CAPACITY,
  calendarDate, cropByCode,
  CORN, SOYBEANS, WHEAT,
  type CalendarDate,
} from "./catalog.js";
import {
  FARM_BORROW, FARM_BUY_EQUIPMENT, FARM_BUY_FIELD, FARM_CANCEL_OP,
  FARM_REPAY, FARM_SCHEDULE_OP, FARM_SELL, FARM_SET_WORKERS,
  type BorrowCommand, type BuyEquipmentCommand, type BuyFieldCommand,
  type CancelOpCommand, type FarmCommand, type RepayCommand,
  type ScheduleOpCommand, type SellCommand, type SetWorkersCommand,
} from "./commands.js";
import { FIELDS, FIELD_COUNT } from "./layout.js";
import { makeFarmSnapshot, restoreFarmSnapshot } from "./snapshot.js";
import {
  FinanceSystem, GrowthSystem, MarketSystem, OperationsSystem,
  SoilSystem, WeatherSystem, YearEndSystem, computeNetWorth,
  type FarmEvent,
} from "./systems.js";
import {
  CROP_YTD, CY_STRIDE, CY_REVENUE,
  EQUIP_LEVEL, FIELD_ACRES, FIELD_CROP, FIELD_CUTTINGS, FIELD_DAMAGE,
  FIELD_FERTILITY, FIELD_GROW_DAYS, FIELD_MATURE_DAY, FIELD_MOISTURE,
  FIELD_OWNED, FIELD_PLANT_DAY, FIELD_PLANT_FACTOR, FIELD_PREV_CROP,
  FIELD_PROGRESS, FIELD_SOIL_QUALITY, FIELD_STAGE, FIELD_STRESS,
  FIELD_YIELD_EST, FIELD_YIELD_LAST, FIELD_YTD_UNITS,
  MAX_OPS, MONEY, M_CASH, M_DEBT, M_NEXT_OP_SEQ,
  OP_ACRES_DONE, OP_CROP, OP_FACTOR_SUM, OP_FIELD, OP_KIND, OP_SEQ, OP_STATUS,
  PRICE, STAGE_NAMES, STORED, WEATHER,
  WORKERS, YTD, YTD_REVENUE,
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
  readonly acres: number;
  readonly owned: boolean;
  readonly price: number;
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
  fields(): FieldView[];
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

  const b = {
    acres: buffers.get<Float32Array>(FIELD_ACRES),
    owned: buffers.get<Uint8Array>(FIELD_OWNED),
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
    damage: buffers.get<Float32Array>(FIELD_DAMAGE),
    cuttings: buffers.get<Uint8Array>(FIELD_CUTTINGS),
    yieldEst: buffers.get<Float32Array>(FIELD_YIELD_EST),
    yieldLast: buffers.get<Float32Array>(FIELD_YIELD_LAST),
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
    weather: buffers.get<Float32Array>(WEATHER),
    money: buffers.get<Float64Array>(MONEY),
    ytd: buffers.get<Float64Array>(YTD),
    cropYtd: buffers.get<Float64Array>(CROP_YTD),
    fieldYtd: buffers.get<Float64Array>(FIELD_YTD_UNITS),
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
      return FIELDS.map((def) => {
        const f = def.id;
        const cropCode = b.crop[f]!;
        return {
          id: f,
          name: def.name,
          acres: b.acres[f]!,
          owned: b.owned[f] === 1,
          price: Math.round(def.acres * LAND_PRICE_PER_ACRE),
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
        };
      });
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
          fieldName: FIELDS[f]!.name,
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

  const acres = buffers.get<Float32Array>(FIELD_ACRES);
  const owned = buffers.get<Uint8Array>(FIELD_OWNED);
  const soilQ = buffers.get<Float32Array>(FIELD_SOIL_QUALITY);
  const moisture = buffers.get<Float32Array>(FIELD_MOISTURE);
  const fertility = buffers.get<Float32Array>(FIELD_FERTILITY);
  const prevCrop = buffers.get<Uint8Array>(FIELD_PREV_CROP);
  const plantDay = buffers.get<Int32Array>(FIELD_PLANT_DAY);
  const matureDay = buffers.get<Int32Array>(FIELD_MATURE_DAY);
  const damage = buffers.get<Float32Array>(FIELD_DAMAGE);
  const plantFactor = buffers.get<Float32Array>(FIELD_PLANT_FACTOR);

  const startingRotation = [CORN, SOYBEANS, WHEAT];
  for (const def of FIELDS) {
    const f = def.id;
    acres[f] = def.acres;
    owned[f] = def.startsOwned ? 1 : 0;
    soilQ[f] = 0.78 + u() * 0.34;
    moisture[f] = 0.45 + u() * 0.2;
    fertility[f] = 0.5 + u() * 0.2;
    prevCrop[f] = def.startsOwned ? startingRotation[Math.floor(u() * startingRotation.length)]! : 0;
    plantDay[f] = -1;
    matureDay[f] = -1;
    damage[f] = 1;
    plantFactor[f] = 1;
  }

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
}

// ------------------------------------------------------------ commands

type Views = {
  acres: Float32Array; owned: Uint8Array; crop: Uint8Array; stage: Uint8Array;
  opKind: Uint8Array; opField: Uint8Array; opCrop: Uint8Array; opStatus: Uint8Array;
  opAcres: Float32Array; opSeq: Int32Array; opFactor: Float32Array;
  equip: Uint8Array; workers: Uint8Array; price: Float32Array; stored: Float64Array;
  money: Float64Array; ytd: Float64Array; cropYtd: Float64Array;
};

function borrowLimit(v: Pick<Views, "owned" | "acres" | "equip" | "money">): number {
  let assetValue = 0;
  for (let f = 0; f < FIELD_COUNT; f += 1) {
    if (v.owned[f] === 1) {
      assetValue += v.acres[f]! * LAND_PRICE_PER_ACRE;
    }
  }
  for (let e = 0; e < EQUIP_COUNT; e += 1) {
    assetValue += EQUIPMENT[e]!.value[v.equip[e]! - 1]!;
  }
  return assetValue * DEBT_LIMIT_RATIO;
}

function requireField(v: Views, field: number): void {
  if (!Number.isInteger(field) || field < 0 || field >= FIELD_COUNT) {
    throw new Error(`field must be a whole number in [0, ${FIELD_COUNT})`);
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
    case FARM_BUY_FIELD:
      return buyField(v, cmd);
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

function scheduleOp(v: Views, cmd: ScheduleOpCommand): void {
  requireField(v, cmd.field);
  if (v.owned[cmd.field] !== 1) {
    throw new Error(`${FIELDS[cmd.field]!.name} is not owned`);
  }
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
      throw new Error(`${FIELDS[cmd.field]!.name} already has a ${OP_KEYS[cmd.op]} operation queued`);
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

function buyField(v: Views, cmd: BuyFieldCommand): void {
  requireField(v, cmd.field);
  if (v.owned[cmd.field] === 1) {
    throw new Error(`${FIELDS[cmd.field]!.name} is already owned`);
  }
  const cost = v.acres[cmd.field]! * LAND_PRICE_PER_ACRE;
  if (v.money[M_CASH]! < cost) {
    throw new Error(
      `buying ${FIELDS[cmd.field]!.name} costs $${Math.round(cost).toLocaleString("en-US")}; not enough cash (borrow first?)`,
    );
  }
  v.money[M_CASH]! -= cost;
  v.owned[cmd.field] = 1;
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
