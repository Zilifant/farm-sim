// Behavioral suite: the farm's systems produce the strategic dynamics the
// design asks for — the player starts with bare owned ground and places
// fields freely, planting windows and capacity limits bind, conditions
// (not a die roll) set yields, fertilizer/irrigation/rotation pay, storage
// and finances work, and the year closes with a readable summary.

import { describe, expect, it } from "vitest";
import { seedToU32 } from "@sim/runtime";
import {
  CORN, EQUIP_HARVESTER, EQUIP_PLANTER, FARM_BORROW, FARM_BUILD_ROAD,
  FARM_BUY_EQUIPMENT, FARM_BUY_PARCEL, FARM_CANCEL_OP, FARM_CREATE_FIELD,
  FARM_REMOVE_FIELD, FARM_REMOVE_ROAD, FARM_REPAY, FARM_SCHEDULE_OP,
  FARM_SELL, FARM_SET_WORKERS,
  HAY, HOMESTEAD_PARCEL_ID, OP_FERTILIZE, OP_HARVEST, OP_IRRIGATE, OP_PLANT,
  EQUIPMENT, LAND_PRICE_PER_ACRE, PARCELS, ROAD_COST_PER_CELL, SOYBEANS,
  STORAGE_CAPACITY, TOMATOES, WHEAT, WORLD_WIDTH,
  calendarDate, createFarmSim, cropByCode, fieldPlacementError, forecastFor,
  roadPlacementError, soilQualityAt, weatherFor,
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

// The homestead parcel spans x 24..35, y 0..26, minus the farmstead
// (28,18,6,6) and driveway (30,24,2,3). The test farm keeps x34 as a road
// corridor from the public road up the parcel's east side; fields sit west
// of it, touching it (or each other — reachability is transitive).
const HOME_A = { x: 24, y: 0, w: 10, h: 9 }; // 45 ac
const HOME_B = { x: 24, y: 9, w: 10, h: 9 }; // 45 ac
/** Small plot beside the road corridor (used where a quick field will do). */
const HOME_SMALL = { x: 30, y: 0, w: 4, h: 9 }; // 18 ac
/** Six plots across the homestead's north half; the east pair touch the
 * road corridor, the rest chain through their neighbors. */
const SMALL_PLOTS = [
  { x: 24, y: 0, w: 3, h: 9 }, { x: 27, y: 0, w: 3, h: 9 }, { x: 30, y: 0, w: 4, h: 9 },
  { x: 24, y: 9, w: 3, h: 9 }, { x: 27, y: 9, w: 3, h: 9 }, { x: 30, y: 9, w: 4, h: 9 },
];

/** The dirt-road corridor: column x34 from the parcel's top to the public
 * road, connecting everything placed against it. */
const ROAD_LINK = Array.from({ length: 27 }, (_, y) => ({ x: 34, y }));

function linkRoad(sim: FarmSim): void {
  sim.apply({ kind: FARM_BUILD_ROAD, cells: ROAD_LINK });
}

/** Create a field and return its slot id. */
function addField(sim: FarmSim, r: { x: number; y: number; w: number; h: number } = HOME_A): number {
  sim.apply({ kind: FARM_CREATE_FIELD, ...r });
  return sim.fields().at(-1)!.id;
}

async function grow(seed: string, crop: number, opts: { fertilize?: boolean; irrigate?: boolean } = {}): Promise<{ sim: FarmSim; field: number; events: FarmEvent[] }> {
  const sim = await createFarmSim({ seed });
  linkRoad(sim);
  const field = addField(sim, HOME_A);
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
  return { sim, field, events };
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

describe("land and field placement", () => {
  it("starts with the homestead parcel only, and no fields", async () => {
    const sim = await createFarmSim({ seed: "start" });
    expect(sim.fields()).toHaveLength(0);
    const parcels = sim.parcels();
    expect(parcels).toHaveLength(PARCELS.length);
    expect(parcels.filter((p) => p.owned).map((p) => p.id)).toEqual([HOMESTEAD_PARCEL_ID]);
    expect(parcels.find((p) => p.owned)!.isHomestead).toBe(true);
  });

  it("creates fields of any shape on owned ground, charging a clearing cost", async () => {
    const sim = await createFarmSim({ seed: "place" });
    const cashBefore = sim.finance().cash;
    const wide = addField(sim, { x: 24, y: 0, w: 12, h: 4 });
    const tall = addField(sim, { x: 24, y: 5, w: 4, h: 12 });
    const fields = sim.fields();
    expect(fields).toHaveLength(2);
    expect(fields.find((f) => f.id === wide)).toMatchObject({ w: 12, h: 4, acres: 24 });
    expect(fields.find((f) => f.id === tall)).toMatchObject({ w: 4, h: 12, acres: 24 });
    expect(fields[0]!.name).toBe("Field 1");
    expect(fields[1]!.name).toBe("Field 2");
    expect(sim.finance().cash).toBeLessThan(cashBefore); // clearing costs money
  });

  it("rejects placements off owned ground, over the road/farmstead, overlapping, or too small", async () => {
    const sim = await createFarmSim({ seed: "reject" });
    // unowned parcel
    expect(() => addField(sim, { x: 0, y: 0, w: 6, h: 6 })).toThrow(/not yours/);
    // across the road
    expect(() => addField(sim, { x: 24, y: 25, w: 4, h: 6 })).toThrow(/road|farmstead|not yours/);
    // over the farmstead
    expect(() => addField(sim, { x: 27, y: 17, w: 5, h: 5 })).toThrow(/farmstead/);
    // too small
    expect(() => addField(sim, { x: 24, y: 0, w: 2, h: 8 })).toThrow(/at least/);
    // overlap
    addField(sim, HOME_A);
    expect(() => addField(sim, { x: 28, y: 4, w: 4, h: 4 })).toThrow(/overlaps/);
    expect(sim.fields()).toHaveLength(1);
  });

  it("placement matters: the seeded soil map varies across the world", () => {
    const h = seedToU32("soil");
    expect(soilQualityAt(h, 10, 10)).toBe(soilQualityAt(h, 10, 10));
    const samples = [];
    for (let x = 0; x < WORLD_WIDTH; x += 6) {
      samples.push(soilQualityAt(h, x, 12));
    }
    const spread = Math.max(...samples) - Math.min(...samples);
    expect(spread).toBeGreaterThan(0.1); // meaningfully different ground
    for (const q of samples) {
      expect(q).toBeGreaterThan(0.7);
      expect(q).toBeLessThan(1.15);
    }
  });

  it("removes an empty field, but never one with a crop or queued work", async () => {
    const sim = await createFarmSim({ seed: "remove" });
    linkRoad(sim); // so the plant op at the end can actually run
    const field = addField(sim, HOME_A);
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_FERTILIZE, field, crop: 0 });
    expect(() => sim.apply({ kind: FARM_REMOVE_FIELD, field })).toThrow(/queued work/);
    sim.apply({ kind: FARM_CANCEL_OP, opSeq: sim.ops()[0]!.seq });
    sim.apply({ kind: FARM_REMOVE_FIELD, field });
    expect(sim.fields()).toHaveLength(0);
    // The ground is open again: the same rect can host a new field.
    const again = addField(sim, HOME_A);
    expect(sim.fields()).toHaveLength(1);
    expect(sim.fields()[0]!.id).toBe(again);
    // And a planted field refuses removal.
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field: again, crop: CORN });
    await runDays(sim, 130);
    expect(() => sim.apply({ kind: FARM_REMOVE_FIELD, field: again })).toThrow(/standing crop/);
  });

  it("buying a parcel opens its ground for placement", async () => {
    const sim = await createFarmSim({ seed: "expand", startCash: 2_000_000 });
    const parcel = sim.parcels().find((p) => !p.owned)!;
    expect(() => addField(sim, { x: parcel.x, y: parcel.y, w: 6, h: 6 })).toThrow(/not yours/);
    const cashBefore = sim.finance().cash;
    sim.apply({ kind: FARM_BUY_PARCEL, parcel: parcel.id });
    expect(sim.finance().cash).toBeCloseTo(cashBefore - parcel.acres * LAND_PRICE_PER_ACRE, 2);
    expect(sim.parcels()[parcel.id]!.owned).toBe(true);
    addField(sim, { x: parcel.x, y: parcel.y, w: 6, h: 6 }); // now allowed
    // A field may straddle two owned parcels but never owned + unowned.
    expect(() => sim.apply({ kind: FARM_BUY_PARCEL, parcel: parcel.id })).toThrow(/already owned/);
  });

  it("the pure placement checker names each failure", () => {
    const owned = new Uint8Array(PARCELS.length);
    owned[HOMESTEAD_PARCEL_ID] = 1;
    expect(fieldPlacementError({ x: 24, y: 0, w: 6, h: 6 }, owned, [])).toBeNull();
    expect(fieldPlacementError({ x: 24, y: 0, w: 2, h: 6 }, owned, [])).toMatch(/at least/);
    expect(fieldPlacementError({ x: 0, y: 0, w: 6, h: 6 }, owned, [])).toMatch(/not yours/);
    expect(fieldPlacementError({ x: 24, y: 20, w: 12, h: 12 }, owned, [])).toMatch(/road|not yours|farmstead/);
    expect(fieldPlacementError({ x: 24, y: 0, w: 6, h: 6 }, owned, [{ x: 26, y: 2, w: 4, h: 4 }])).toMatch(/overlaps/);
  });
});

describe("dirt roads and reachability", () => {
  it("a field with no road stays unworked; building the road unblocks it", async () => {
    const sim = await createFarmSim({ seed: "roads" });
    const field = addField(sim, HOME_A); // far from the driveway and road
    expect(sim.fields()[0]!.reachable).toBe(false);
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_FERTILIZE, field, crop: 0 });
    await runDays(sim, 10);
    expect(sim.ops()).toHaveLength(1); // waiting, not failed
    expect(sim.ops()[0]!.acresDone).toBe(0);

    const cashBefore = sim.finance().cash;
    linkRoad(sim);
    expect(sim.finance().cash).toBeCloseTo(cashBefore - ROAD_LINK.length * ROAD_COST_PER_CELL, 2);
    expect(sim.fields()[0]!.reachable).toBe(true);
    const events: FarmEvent[] = [];
    await runDays(sim, 10, events);
    expect(events.some((e) => e.message.includes("fertilized"))).toBe(true);
  });

  it("reachability chains through adjacent fields", async () => {
    const sim = await createFarmSim({ seed: "chain" });
    linkRoad(sim);
    for (const plot of SMALL_PLOTS) {
      addField(sim, plot);
    }
    // The east plots touch the corridor; the west ones only touch fields.
    for (const f of sim.fields()) {
      expect(f.reachable).toBe(true);
    }
    // A lone field with no road and no neighbor is cut off.
    const lonely = addField(sim, { x: 24, y: 19, w: 4, h: 5 });
    expect(sim.fields().find((f) => f.id === lonely)!.reachable).toBe(false);
  });

  it("roads only go on free owned ground, and can be removed again", async () => {
    const sim = await createFarmSim({ seed: "roadrules" });
    expect(() => sim.apply({ kind: FARM_BUILD_ROAD, cells: [{ x: 2, y: 2 }] })).toThrow(/not yours/);
    expect(() => sim.apply({ kind: FARM_BUILD_ROAD, cells: [{ x: 30, y: 20 }] })).toThrow(/farmstead/);
    expect(() => sim.apply({ kind: FARM_BUILD_ROAD, cells: [{ x: 10, y: 27 }] })).toThrow(/public road/);
    addField(sim, HOME_SMALL);
    expect(() => sim.apply({ kind: FARM_BUILD_ROAD, cells: [{ x: 31, y: 2 }] })).toThrow(/field is in the way/);

    sim.apply({ kind: FARM_BUILD_ROAD, cells: [{ x: 34, y: 26 }] });
    expect(() => sim.apply({ kind: FARM_BUILD_ROAD, cells: [{ x: 34, y: 26 }] })).toThrow(/already a dirt road/);
    sim.apply({ kind: FARM_REMOVE_ROAD, cells: [{ x: 34, y: 26 }] });
    expect(() => sim.apply({ kind: FARM_REMOVE_ROAD, cells: [{ x: 34, y: 26 }] })).toThrow(/no dirt road/);
    // A field cannot be placed over a road.
    sim.apply({ kind: FARM_BUILD_ROAD, cells: [{ x: 25, y: 2 }] });
    expect(() => addField(sim, { x: 24, y: 0, w: 4, h: 4 })).toThrow(/dirt road in the way/);
  });

  it("the pure road checker names each failure", async () => {
    const owned = new Uint8Array(PARCELS.length);
    owned[HOMESTEAD_PARCEL_ID] = 1;
    const noRoads = new Uint8Array(96 * 56);
    expect(roadPlacementError([{ x: 34, y: 5 }], owned, [], noRoads)).toBeNull();
    expect(roadPlacementError([], owned, [], noRoads)).toMatch(/no cells/);
    expect(roadPlacementError([{ x: 2, y: 2 }], owned, [], noRoads)).toMatch(/not yours/);
    expect(roadPlacementError([{ x: 34, y: 5 }], owned, [{ x: 30, y: 0, w: 6, h: 9 }], noRoads)).toMatch(/field is in the way/);
  });
});

describe("operations and capacity", () => {
  it("a plant op waits for its window, then completes over multiple days", async () => {
    const sim = await createFarmSim({ seed: "ops" });
    linkRoad(sim);
    const field = addField(sim, HOME_A); // 45 ac
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field, crop: CORN });
    await runDays(sim, 99);
    // Window opens day 100; nothing before.
    expect(sim.fields()[0]!.crop).toBeNull();
    const events: FarmEvent[] = [];
    await runDays(sim, 70, events);
    const planted = sim.fields()[0]!;
    expect(planted.crop).toBe("corn");
    expect(planted.plantDay).toBeGreaterThanOrEqual(100);
    const event = events.find((e) => e.message.includes("planted Corn"));
    expect(event).toBeDefined();
    expect(event!.data?.["field"]).toBe(field);
  });

  it("one planter is a bottleneck across many fields; upgrading widens it", async () => {
    const plantAll = async (upgrade: boolean): Promise<number[]> => {
      const sim = await createFarmSim({ seed: "bottleneck" });
      linkRoad(sim);
      if (upgrade) {
        sim.apply({ kind: FARM_BUY_EQUIPMENT, category: EQUIP_PLANTER });
      }
      for (const plot of SMALL_PLOTS) {
        const field = addField(sim, plot);
        sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field, crop: CORN });
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
    const a = addField(sim, HOME_A);
    const b = addField(sim, HOME_B);
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field: a, crop: WHEAT });
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_FERTILIZE, field: b, crop: 0 });
    expect(sim.ops()).toHaveLength(2);
    const seq = sim.ops()[0]!.seq;
    sim.apply({ kind: FARM_CANCEL_OP, opSeq: seq });
    expect(sim.ops()).toHaveLength(1);
    expect(sim.ops()[0]!.kind).toBe("fertilize");
    expect(() => sim.apply({ kind: FARM_CANCEL_OP, opSeq: 999 })).toThrow(/no queued operation/);
  });

  it("rejects duplicate ops, dead fields, and bad kinds", async () => {
    const sim = await createFarmSim({ seed: "validate" });
    const field = addField(sim, HOME_A);
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field, crop: CORN });
    expect(() => sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field, crop: WHEAT })).toThrow(/already has a plant/);
    expect(() => sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field: 7, crop: CORN })).toThrow(/no field/);
    expect(() => sim.apply({ kind: FARM_SCHEDULE_OP, op: 9, field, crop: CORN })).toThrow(/op must be/);
  });

  it("a plant op whose window closes fails with an event", async () => {
    const sim = await createFarmSim({ seed: "window" });
    linkRoad(sim);
    const field = addField(sim, HOME_A);
    const events: FarmEvent[] = [];
    await runDays(sim, 160); // corn window (closes day 152) has passed
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field, crop: CORN });
    await runDays(sim, 5, events);
    expect(sim.ops()).toHaveLength(0);
    expect(events.some((e) => e.message.includes("window closed"))).toBe(true);
    expect(sim.fields()[0]!.crop).toBeNull();
  });
});

describe("growth and yield", () => {
  it("a crop moves through the growth states to harvest", async () => {
    const sim = await createFarmSim({ seed: "stages" });
    linkRoad(sim);
    const field = addField(sim, HOME_A);
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field, crop: CORN });
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
    const { sim, events } = await grow("yield-a", CORN, { fertilize: true });
    const harvest = events.find((e) => e.kind === "harvest");
    expect(harvest).toBeDefined();
    const perAcre = harvest!.data?.["yieldPerAcre"] as number;
    expect(perAcre).toBeGreaterThan(40);
    expect(perAcre).toBeLessThan(230);
    expect(sim.fields()[0]!.lastYield).toBeCloseTo(perAcre, 3);
  });

  it("fertilizing raises the same field's yield in the same weather", async () => {
    const bare = await grow("fert-cmp", CORN);
    const fed = await grow("fert-cmp", CORN, { fertilize: true });
    const yieldOf = (r: { events: FarmEvent[] }): number =>
      (r.events.find((e) => e.kind === "harvest")!.data?.["yieldPerAcre"] as number) ?? 0;
    expect(yieldOf(fed)).toBeGreaterThan(yieldOf(bare));
  });

  it("late planting yields less than in-window planting", async () => {
    const plantOn = async (day: number): Promise<number> => {
      const sim = await createFarmSim({ seed: "late" });
      linkRoad(sim);
      const field = addField(sim, HOME_A);
      await runDays(sim, day);
      sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field, crop: SOYBEANS });
      await runDays(sim, 200 - day);
      sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_HARVEST, field, crop: 0 });
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
      linkRoad(sim);
      const field = addField(sim, HOME_B);
      sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field, crop: firstCrop });
      await runDays(sim, 200);
      sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_HARVEST, field, crop: 0 });
      await runDays(sim, 165); // into year 2
      sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field, crop: CORN });
      await runDays(sim, 200);
      sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_HARVEST, field, crop: 0 });
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
    linkRoad(sim);
    const field = addField(sim, HOME_SMALL); // small: cuttings clear the harvester fast
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field, crop: HAY });
    const events: FarmEvent[] = [];
    for (let d = 0; d < 365; d += 1) {
      sim.step();
      sim.events.drain((e) => events.push(e));
      // Keep a harvest op standing whenever the stand is ready.
      const hasHarvest = sim.ops().some((o) => o.kind === "harvest" && o.field === field);
      if (!hasHarvest && sim.fields()[0]?.crop === "hay") {
        sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_HARVEST, field, crop: 0 });
      }
    }
    const cuttings = events.filter((e) => e.kind === "harvest" && e.data?.["crop"] === "hay");
    expect(cuttings.length).toBeGreaterThanOrEqual(2);
  });

  it("an unharvested crop is lost to winter", async () => {
    const sim = await createFarmSim({ seed: "loss" });
    linkRoad(sim);
    const field = addField(sim, HOME_A);
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field, crop: CORN });
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
    const { sim } = await grow("sell", CORN, { fertilize: true });
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

describe("finances", () => {
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
    // The base: the homestead parcel plus starting machinery.
    const homestead = PARCELS[HOMESTEAD_PARCEL_ID]!;
    expect(limit).toBeGreaterThan(homestead.acres * LAND_PRICE_PER_ACRE * 0.5);
    expect(() => sim.apply({ kind: FARM_BORROW, amount: limit + 1 })).toThrow(/borrowing limit/);
    sim.apply({ kind: FARM_BORROW, amount: 100_000 });
    expect(sim.finance().cash).toBeCloseTo(110_000, 5);
    expect(sim.finance().debt).toBeCloseTo(100_000, 5);
    sim.apply({ kind: FARM_REPAY, amount: 40_000 });
    expect(sim.finance().debt).toBeCloseTo(60_000, 5);
    expect(sim.finance().cash).toBeCloseTo(70_000, 5);
  });

  it("buying land raises the borrowing base", async () => {
    const sim = await createFarmSim({ seed: "base", startCash: 2_000_000 });
    const before = sim.finance().borrowLimit;
    sim.apply({ kind: FARM_BUY_PARCEL, parcel: sim.parcels().find((p) => !p.owned)!.id });
    expect(sim.finance().borrowLimit).toBeGreaterThan(before);
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
    const parcel = sim.parcels().find((p) => !p.owned)!;
    expect(() => sim.apply({ kind: FARM_BUY_PARCEL, parcel: parcel.id })).toThrow(/not enough cash/);
    expect(() => sim.apply({ kind: FARM_CREATE_FIELD, x: 24, y: 0, w: 12, h: 9 })).toThrow(/not enough cash/);
  });

  it("tomatoes demand far more labor than grain", () => {
    expect(cropByCode(TOMATOES).laborPlant).toBeGreaterThan(cropByCode(CORN).laborPlant * 3);
  });
});

describe("year end", () => {
  it("closes the year with a full summary and resets the annual ledgers", async () => {
    const sim = await createFarmSim({ seed: "year" });
    linkRoad(sim);
    const field = addField(sim, HOME_A);
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_PLANT, field, crop: CORN });
    await runDays(sim, 200);
    sim.apply({ kind: FARM_SCHEDULE_OP, op: OP_HARVEST, field, crop: 0 });
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
    expect(summary.byField.some((r) => r.field === "Field 1" && r.units > 0)).toBe(true);
    // The annual ledgers restart with the new year.
    expect(sim.finance().revenueYtd).toBe(0);
  });
});
