// Behavioral suite: the farm's systems produce the strategic dynamics the
// design asks for — planting windows and capacity limits bind, conditions
// (not a die roll) set yields, fertilizer/irrigation/rotation pay, storage
// and finances work, and the year closes with a readable summary.

import { describe, expect, it } from "vitest";
import { seedToU32 } from "@sim/runtime";
import {
  CORN, EQUIP_HARVESTER, EQUIP_PLANTER, FARM_BORROW, FARM_BUY_EQUIPMENT,
  FARM_BUY_FIELD, FARM_CANCEL_OP, FARM_REPAY, FARM_SCHEDULE_OP, FARM_SELL,
  FARM_SET_WORKERS, HAY, OP_FERTILIZE, OP_HARVEST, OP_IRRIGATE, OP_PLANT,
  EQUIPMENT, LAND_PRICE_PER_ACRE, SOYBEANS, STORAGE_CAPACITY, TOMATOES, WHEAT,
  calendarDate, createFarmSim, cropByCode, forecastFor, weatherFor,
  type FarmEvent, type FarmSim,
} from "@sim/farm";

async function runDays(sim: FarmSim, days: number, collect?: FarmEvent[]): Promise<void> {
  for (let i = 0; i < days; i += 1) {
    sim.step();
    if (collect) {
      sim.events.drain((e) => collect.push(e));
    }
  }
}

async function grow(seed: string, field: number, crop: number, opts: { fertilize?: boolean; irrigate?: boolean } = {}): Promise<{ sim: FarmSim; events: FarmEvent[] }> {
  const sim = await createFarmSim({ seed });
  const events: FarmEvent[] = [];
  sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field, crop });
  if (opts.fertilize) {
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_FERTILIZE, field, crop: 0 });
  }
  await runDays(sim, 170, events);
  if (opts.irrigate) {
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_IRRIGATE, field, crop: 0 });
  }
  sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_HARVEST, field, crop: 0 });
  await runDays(sim, 190, events);
  return { sim, events };
}

describe("calendar and weather", () => {
  it("maps days to dates and seasons", () => {
    expect(calendarDate(0)).toMatchObject({ year: 1, month: "Jan", dayOfMonth: 1, season: "winter" });
    expect(calendarDate(120)).toMatchObject({ year: 1, month: "May", dayOfMonth: 1, season: "spring" });
    expect(calendarDate(365 + 200)).toMatchObject({ year: 2, season: "summer" });
  });

  it("weather is a pure function of (seed, day), with seasonal shape", () => {
    const h = seedToU32("w");
    expect(weatherFor(h, 42)).toEqual(weatherFor(h, 42));
    expect(weatherFor(h, 42)).not.toEqual(weatherFor(seedToU32("x"), 42));
    // July is warmer than January, averaged over enough days to drown noise.
    const avg = (days: number[]): number =>
      days.reduce((a, d) => a + weatherFor(h, d).high, 0) / days.length;
    const january = Array.from({ length: 30 }, (_, i) => i);
    const july = Array.from({ length: 30 }, (_, i) => 185 + i);
    expect(avg(july)).toBeGreaterThan(avg(january) + 30);
  });

  it("forecasts are deterministic per issue day and degrade with lead", () => {
    const h = seedToU32("f");
    expect(forecastFor(h, 100, 1)).toEqual(forecastFor(h, 100, 1));
    // Tomorrow's forecast tracks truth closely; a week out it need not.
    let nearError = 0;
    let farError = 0;
    for (let day = 100; day < 160; day += 1) {
      nearError += Math.abs(forecastFor(h, day, 1).high - weatherFor(h, day + 1).high);
      farError += Math.abs(forecastFor(h, day, 7).high - weatherFor(h, day + 7).high);
    }
    expect(nearError).toBeLessThan(farError);
  });
});

describe("operations and capacity", () => {
  it("a plant op waits for its window, then completes over multiple days", async () => {
    const sim = await createFarmSim({ seed: "ops" });
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field: 6, crop: CORN }); // 126 ac
    await runDays(sim, 99);
    // Window opens day 100; nothing before.
    expect(sim.fields()[6]!.crop).toBeNull();
    const events: FarmEvent[] = [];
    await runDays(sim, 70, events);
    const field = sim.fields()[6]!;
    expect(field.crop).toBe("corn");
    expect(field.plantDay).toBeGreaterThanOrEqual(100);
    // 126 acres through a 40 ac/day planter needs several working days.
    const planted = events.find((e) => e.message.includes("planted Corn"));
    expect(planted).toBeDefined();
    expect(planted!.data?.["field"]).toBe(6);
  });

  it("one planter is a bottleneck across many fields; upgrading widens it", async () => {
    const plantAll = async (upgrade: boolean): Promise<number[]> => {
      const sim = await createFarmSim({ seed: "bottleneck" });
      if (upgrade) {
        sim.apply({ kind: FARM_BUY_EQUIPMENT, category: EQUIP_PLANTER });
      }
      for (const f of [0, 1, 3, 6, 7]) {
        sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field: f, crop: CORN });
      }
      await runDays(sim, 170);
      return sim.fields().filter((f) => f.crop === "corn").map((f) => f.plantDay);
    };
    const basic = await plantAll(false);
    const upgraded = await plantAll(true);
    expect(basic.length).toBeGreaterThan(0);
    expect(upgraded.length).toBeGreaterThanOrEqual(basic.length);
    const last = (days: number[]): number => Math.max(...days);
    // The bigger planter finishes the same program strictly sooner.
    expect(last(upgraded)).toBeLessThan(last(basic));
  });

  it("ops can be cancelled while queued, and the queue lists them", async () => {
    const sim = await createFarmSim({ seed: "cancel" });
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field: 0, crop: WHEAT });
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_FERTILIZE, field: 1, crop: 0 });
    expect(sim.ops()).toHaveLength(2);
    const seq = sim.ops()[0]!.seq;
    sim.apply({ kind: FARM_CANCEL_OP, opSeq: seq });
    expect(sim.ops()).toHaveLength(1);
    expect(sim.ops()[0]!.kind).toBe("fertilize");
    expect(() => sim.apply({ kind: FARM_CANCEL_OP, opSeq: 999 })).toThrow(/no queued operation/);
  });

  it("rejects duplicate ops, unowned fields, and bad kinds", async () => {
    const sim = await createFarmSim({ seed: "validate" });
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field: 0, crop: CORN });
    expect(() => sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field: 0, crop: WHEAT })).toThrow(/already has a plant/);
    expect(() => sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field: 2, crop: CORN })).toThrow(/not owned/);
    expect(() => sim.apply({ kind: FARM_SCHEDULE_OP, op: 9, field: 0, crop: CORN })).toThrow(/op must be/);
  });

  it("a plant op whose window closes fails with an event", async () => {
    const sim = await createFarmSim({ seed: "window" });
    const events: FarmEvent[] = [];
    await runDays(sim, 160); // corn window (closes day 152) has passed
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field: 0, crop: CORN });
    await runDays(sim, 5, events);
    expect(sim.ops()).toHaveLength(0);
    expect(events.some((e) => e.message.includes("window closed"))).toBe(true);
    expect(sim.fields()[0]!.crop).toBeNull();
  });
});

describe("growth and yield", () => {
  it("a crop moves through the growth states to harvest", async () => {
    const sim = await createFarmSim({ seed: "stages" });
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field: 0, crop: CORN });
    const seen = new Set<string>();
    for (let d = 0; d < 250; d += 1) {
      sim.step();
      seen.add(sim.fields()[0]!.stage);
    }
    for (const stage of ["unplanted", "planted", "germinating", "growing", "mature"]) {
      expect(seen).toContain(stage);
    }
  });

  it("yields land in a plausible band and respond to conditions, not a roll", async () => {
    const { sim, events } = await grow("yield-a", 0, CORN, { fertilize: true });
    const harvest = events.find((e) => e.kind === "harvest");
    expect(harvest).toBeDefined();
    const perAcre = harvest!.data?.["yieldPerAcre"] as number;
    expect(perAcre).toBeGreaterThan(40);
    expect(perAcre).toBeLessThan(230);
    expect(sim.fields()[0]!.lastYield).toBeCloseTo(perAcre, 3);
  });

  it("fertilizing raises the same field's yield in the same weather", async () => {
    const bare = await grow("fert-cmp", 0, CORN);
    const fed = await grow("fert-cmp", 0, CORN, { fertilize: true });
    const yieldOf = (r: { events: FarmEvent[] }): number =>
      (r.events.find((e) => e.kind === "harvest")!.data?.["yieldPerAcre"] as number) ?? 0;
    expect(yieldOf(fed)).toBeGreaterThan(yieldOf(bare));
  });

  it("late planting yields less than in-window planting", async () => {
    const plantOn = async (day: number): Promise<number> => {
      const sim = await createFarmSim({ seed: "late" });
      await runDays(sim, day);
      sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field: 0, crop: SOYBEANS });
      await runDays(sim, 200 - day);
      sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_HARVEST, field: 0, crop: 0 });
      const events: FarmEvent[] = [];
      await runDays(sim, 130, events);
      return (events.find((e) => e.kind === "harvest")?.data?.["yieldPerAcre"] as number) ?? 0;
    };
    const onTime = await plantOn(125);
    const late = await plantOn(170); // window closes at 175
    expect(onTime).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(0);
    expect(late).toBeLessThan(onTime * 0.85);
  });

  it("rotation matters: soybeans before corn beat corn-on-corn", async () => {
    // Year 1 sets the previous crop; year 2 measures corn on both histories.
    const secondYearCorn = async (firstCrop: number): Promise<number> => {
      const sim = await createFarmSim({ seed: "rotate" });
      sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field: 3, crop: firstCrop });
      await runDays(sim, 200);
      sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_HARVEST, field: 3, crop: 0 });
      await runDays(sim, 165); // into year 2
      sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field: 3, crop: CORN });
      await runDays(sim, 200);
      sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_HARVEST, field: 3, crop: 0 });
      const events: FarmEvent[] = [];
      await runDays(sim, 120, events);
      const harvests = events.filter((e) => e.kind === "harvest" && e.data?.["crop"] === "corn");
      return (harvests.at(-1)?.data?.["yieldPerAcre"] as number) ?? 0;
    };
    const afterBeans = await secondYearCorn(SOYBEANS);
    const afterCorn = await secondYearCorn(CORN);
    expect(afterBeans).toBeGreaterThan(afterCorn);
  });

  it("hay gives multiple cuttings in a season", async () => {
    const sim = await createFarmSim({ seed: "hay" });
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field: 4, crop: HAY });
    const events: FarmEvent[] = [];
    for (let d = 0; d < 365; d += 1) {
      sim.step();
      sim.events.drain((e) => events.push(e));
      // Keep a harvest op standing whenever the stand is ready.
      const hasHarvest = sim.ops().some((o) => o.kind === "harvest" && o.field === 4);
      if (!hasHarvest && sim.fields()[4]!.crop === "hay") {
        sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_HARVEST, field: 4, crop: 0 });
      }
    }
    const cuttings = events.filter((e) => e.kind === "harvest" && e.data?.["crop"] === "hay");
    expect(cuttings.length).toBeGreaterThanOrEqual(2);
  });

  it("an unharvested crop is lost to winter", async () => {
    const sim = await createFarmSim({ seed: "loss" });
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field: 0, crop: CORN });
    const events: FarmEvent[] = [];
    await runDays(sim, 365, events);
    expect(events.some((e) => e.kind === "loss")).toBe(true);
    expect(sim.fields()[0]!.crop).toBeNull();
    expect(sim.fields()[0]!.prevCrop).toBe("corn");
  });
});

describe("markets, storage, and sales", () => {
  it("prices wander but stay in a plausible band", async () => {
    const sim = await createFarmSim({ seed: "market" });
    let minRatio = Infinity;
    let maxRatio = 0;
    let moved = false;
    let last = sim.markets().map((m) => m.price);
    for (let d = 0; d < 3 * 365; d += 1) {
      sim.step();
      const prices = sim.markets().map((m) => m.price);
      prices.forEach((p, i) => {
        const base = cropByCode(i + 1).basePrice;
        minRatio = Math.min(minRatio, p / base);
        maxRatio = Math.max(maxRatio, p / base);
        if (p !== last[i]) {
          moved = true;
        }
      });
      last = prices;
    }
    expect(moved).toBe(true);
    expect(minRatio).toBeGreaterThan(0.4);
    expect(maxRatio).toBeLessThan(2.3);
  });

  it("harvest fills storage; selling converts it to revenue at the current price", async () => {
    const { sim } = await grow("sell", 0, CORN, { fertilize: true });
    const stored = sim.markets().find((m) => m.key === "corn")!.stored;
    expect(stored).toBeGreaterThan(1000);
    expect(sim.finance().storageUsed).toBeCloseTo(stored, 5);
    expect(sim.finance().storageCapacity).toBe(STORAGE_CAPACITY);

    const price = sim.markets().find((m) => m.key === "corn")!.price;
    const cashBefore = sim.finance().cash;
    sim.apply({ kind: FARM_SELL, crop: CORN, units: 1000 });
    expect(sim.finance().cash).toBeCloseTo(cashBefore + 1000 * price, 2);
    expect(sim.markets().find((m) => m.key === "corn")!.stored).toBeCloseTo(stored - 1000, 3);
    expect(() => sim.apply({ kind: FARM_SELL, crop: SOYBEANS, units: 10 })).toThrow(/no Soybeans in storage/);
  });
});

describe("finances and expansion", () => {
  it("interest accrues daily on debt", async () => {
    const sim = await createFarmSim({ seed: "interest", startDebt: 100_000 });
    const debt0 = sim.finance().debt;
    await runDays(sim, 100);
    const debt1 = sim.finance().debt;
    expect(debt1).toBeGreaterThan(debt0 * 1.015);
    expect(debt1).toBeLessThan(debt0 * 1.025);
  });

  it("a negative cash balance accrues punitive overdraft interest", async () => {
    const sim = await createFarmSim({ seed: "overdraft", startCash: 0, startDebt: 0 });
    await runDays(sim, 60); // wages drive cash below zero with no loan taken
    const cash = sim.finance().cash;
    const wagesAlone = -(2 * 160 * 60);
    expect(cash).toBeLessThan(wagesAlone); // strictly worse than the wages alone
  });

  it("borrowing is capped by assets; repay comes out of cash", async () => {
    const sim = await createFarmSim({ seed: "loans", startDebt: 0, startCash: 10_000 });
    const limit = sim.finance().borrowLimit;
    expect(() => sim.apply({ kind: FARM_BORROW, amount: limit + 1 })).toThrow(/borrowing limit/);
    sim.apply({ kind: FARM_BORROW, amount: 100_000 });
    expect(sim.finance().cash).toBeCloseTo(110_000, 5);
    expect(sim.finance().debt).toBeCloseTo(100_000, 5);
    sim.apply({ kind: FARM_REPAY, amount: 40_000 });
    expect(sim.finance().debt).toBeCloseTo(60_000, 5);
    expect(sim.finance().cash).toBeCloseTo(70_000, 5);
  });

  it("buying a neighboring parcel makes it workable and prices it by acreage", async () => {
    const sim = await createFarmSim({ seed: "expand", startCash: 1_000_000 });
    const parcel = sim.fields().find((f) => !f.owned)!;
    expect(() => sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field: parcel.id, crop: CORN })).toThrow(/not owned/);
    const cashBefore = sim.finance().cash;
    sim.apply({ kind: FARM_BUY_FIELD, field: parcel.id });
    expect(sim.finance().cash).toBeCloseTo(cashBefore - parcel.acres * LAND_PRICE_PER_ACRE, 2);
    expect(sim.fields()[parcel.id]!.owned).toBe(true);
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field: parcel.id, crop: CORN }); // now allowed
    // Owning more land raises the borrowing base.
    expect(sim.finance().borrowLimit).toBeGreaterThan(0);
  });

  it("equipment upgrades cost cash and raise capacity; workers are clamped", async () => {
    const sim = await createFarmSim({ seed: "equip", startCash: 1_000_000 });
    const before = sim.equipment().find((e) => e.cat === EQUIP_HARVESTER)!;
    sim.apply({ kind: FARM_BUY_EQUIPMENT, category: EQUIP_HARVESTER });
    const after = sim.equipment().find((e) => e.cat === EQUIP_HARVESTER)!;
    expect(after.level).toBe(before.level + 1);
    expect(after.capacity).toBeGreaterThan(before.capacity);
    expect(sim.finance().cash).toBeCloseTo(1_000_000 - EQUIPMENT[EQUIP_HARVESTER]!.upgradeCost[1]!, 2);

    sim.apply({ kind: FARM_SET_WORKERS, workers: 5 });
    expect(sim.finance().workers).toBe(5);
    expect(() => sim.apply({ kind: FARM_SET_WORKERS, workers: 0 })).toThrow(/workers/);
    expect(() => sim.apply({ kind: FARM_SET_WORKERS, workers: 99 })).toThrow(/workers/);
  });

  it("a poor sim cannot buy what it cannot afford", async () => {
    const sim = await createFarmSim({ seed: "broke", startCash: 1_000 });
    expect(() => sim.apply({ kind: FARM_BUY_EQUIPMENT, category: EQUIP_PLANTER })).toThrow(/not enough cash/);
    const parcel = sim.fields().find((f) => !f.owned)!;
    expect(() => sim.apply({ kind: FARM_BUY_FIELD, field: parcel.id })).toThrow(/not enough cash/);
  });

  it("tomatoes demand far more labor than grain", () => {
    expect(cropByCode(TOMATOES).laborPlant).toBeGreaterThan(cropByCode(CORN).laborPlant * 3);
  });
});

describe("year end", () => {
  it("closes the year with a full summary and resets the annual ledgers", async () => {
    const sim = await createFarmSim({ seed: "year" });
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field: 0, crop: CORN });
    await runDays(sim, 200);
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_HARVEST, field: 0, crop: 0 });
    const events: FarmEvent[] = [];
    await runDays(sim, 170, events); // crosses day 364
    const year = events.find((e) => e.kind === "year");
    expect(year).toBeDefined();
    const summary = year!.data?.["summary"] as {
      year: number; revenue: number; expenses: number; profit: number;
      netWorth: number; expenseBreakdown: Record<string, number>;
      byCrop: Array<{ crop: string; units: number }>;
      byField: Array<{ field: string; units: number }>;
    };
    expect(summary.year).toBe(1);
    expect(summary.expenses).toBeGreaterThan(0);
    expect(summary.profit).toBeCloseTo(summary.revenue - summary.expenses, 5);
    expect(summary.expenseBreakdown["labor"]).toBeGreaterThan(0);
    expect(summary.expenseBreakdown["interest"]).toBeGreaterThan(0);
    expect(summary.byCrop.some((r) => r.crop === "corn" && r.units > 0)).toBe(true);
    expect(summary.byField.some((r) => r.units > 0)).toBe(true);
    // The annual ledgers restart with the new year.
    expect(sim.finance().revenueYtd).toBe(0);
  });
});
