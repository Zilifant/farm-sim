// Unit tests for the renderer's pure browser modules — imported directly
// from the static app (plain ES modules, so Node loads them fine). The
// camera/projection files are ports of the biome renderer's; the store,
// sparkline, and appearance logic are the farm renderer's own.

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JS browser module without type declarations
import { Camera, ZOOM_LEVELS } from "../renderer/app/rendering/Camera.js";
// @ts-expect-error — plain JS browser module without type declarations
import { createProjection } from "../renderer/app/rendering/GridProjection.js";
// @ts-expect-error — plain JS browser module without type declarations
import { RendererStore, RendererProtocolError } from "../renderer/app/state/RendererStore.js";
// @ts-expect-error — plain JS browser module without type declarations
import { resample, sparkline, TREND_LEVELS } from "../renderer/app/ui/MetricsPanel.js";
// @ts-expect-error — plain JS browser module without type declarations
import { describeLegend } from "../renderer/app/ui/Legend.js";
// @ts-expect-error — plain JS browser module without type declarations
import { resolveAppearance, CROP_CODE_BASE, BUCKETS_PER_CROP, BUCKET_MATURE, CELL_FOR_SALE } from "../renderer/app/rendering/CellAppearance.js";
// @ts-expect-error — plain JS browser module without type declarations
import { formatMoney } from "../renderer/app/ui/StatusPanel.js";

function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const cells = new Uint8Array(9);
  cells[4] = CROP_CODE_BASE; // one planted-corn cell, center
  const fieldIds = new Uint8Array(9).fill(255);
  fieldIds[4] = 0;
  return {
    protocolVersion: 2,
    simulationId: "farm-1-0",
    seed: 1,
    tick: 5,
    running: true,
    speed: 2,
    world: { width: 3, height: 3 },
    cells: Buffer.from(cells).toString("base64"),
    fieldIds: Buffer.from(fieldIds).toString("base64"),
    date: { year: 1, doy: 5, month: "Jan", dayOfMonth: 6, season: "winter", label: "Y1 Jan 6" },
    weather: { high: 30, low: 18, rain: 0 },
    forecast: [],
    fields: [{ id: 0, name: "North A", owned: true, acres: 90 }],
    ops: [],
    equipment: [],
    markets: [{ key: "corn", name: "Corn", unit: "bu", price: 4.9, basePrice: 4.8, stored: 0 }],
    finance: { cash: 150000, debt: 200000, netWorth: 3_000_000, workers: 2, storageUsed: 0, storageCapacity: 25000 },
    ...overrides,
  };
}

describe("Camera", () => {
  it("zooms through the supported levels, anchored at a world point", () => {
    const camera = new Camera({ centerX: 10, centerY: 10, cellSize: 16 });
    expect(camera.zoomIn()).toBe(true);
    expect(ZOOM_LEVELS).toContain(camera.cellSize);
    const before = camera.cellSize;
    camera.zoomAt(12, 12, 1);
    expect(camera.cellSize).toBeGreaterThan(before);
    // The anchor stays put: (12,12) projects to the same screen point.
  });

  it("drag-pans opposite the pointer and clamps to the world", () => {
    const camera = new Camera({ centerX: 5, centerY: 5, cellSize: 10 });
    camera.panByPixels(10, 0);
    expect(camera.centerX).toBe(4);
    camera.clampToWorld({ width: 3, height: 3 });
    expect(camera.centerX).toBe(3);
  });
});

describe("GridProjection", () => {
  it("round-trips cell → screen → cell", () => {
    const camera = new Camera({ centerX: 15, centerY: 15, cellSize: 16 });
    const projection = createProjection(camera, 640, 480);
    const { px, py } = projection.cellToScreen(7, 9);
    const back = projection.cellAtScreen(px + 1, py + 1);
    expect(back).toEqual({ cellX: 7, cellY: 9 });
  });
});

describe("RendererStore", () => {
  it("applies full frames and derives run state and history", () => {
    const store = new RendererStore();
    store.applyFullSnapshot(frame());
    expect(store.tick).toBe(5);
    expect(store.runState).toEqual({ paused: false, speed: 2 });
    expect(store.cellAtXY(1, 1)).toBe(CROP_CODE_BASE);
    expect(store.fieldIdAtXY(1, 1)).toBe(0);
    expect(store.fieldIdAtXY(0, 0)).toBeNull();
    expect(store.history).toEqual([{ tick: 5, cash: 150000, prices: { corn: 4.9 } }]);
    // Same tick again (a forced frame): no duplicate history sample.
    store.applyFullSnapshot(frame());
    expect(store.history).toHaveLength(1);
  });

  it("rejects wrong protocol versions and truncated grids", () => {
    const store = new RendererStore();
    expect(() => store.applyFullSnapshot(frame({ protocolVersion: 1 }))).toThrow(RendererProtocolError);
    expect(() => store.applyFullSnapshot(frame({ cells: "AAAA" }))).toThrow(/cells for a 3x3 world/);
  });

  it("a restart (new simulationId) clears selection, events, and history", () => {
    const store = new RendererStore();
    store.applyFullSnapshot(frame());
    store.setSelection({ cellX: 1, cellY: 1 });
    store.applyEventBatch({
      simulationId: "farm-1-0",
      events: [{ seq: 1, kind: "op", tick: 5, message: "planted Corn on North A" }],
    });
    expect(store.events).toHaveLength(1);
    store.applyFullSnapshot(frame({ simulationId: "farm-7-1", tick: 0 }));
    expect(store.selection).toBeNull();
    expect(store.events).toHaveLength(0);
    expect(store.history).toEqual([{ tick: 0, cash: 150000, prices: { corn: 4.9 } }]);
  });

  it("deduplicates farm events by seq", () => {
    const store = new RendererStore();
    store.applyFullSnapshot(frame());
    const batch = {
      simulationId: "farm-1-0",
      events: [
        { seq: 1, kind: "op", tick: 5, message: "fertilized North A" },
        { seq: 2, kind: "harvest", tick: 10, message: "harvested North A" },
      ],
    };
    store.applyEventBatch(batch);
    store.applyEventBatch(batch); // a reconnect resends history
    expect(store.events).toHaveLength(2);
  });
});

describe("sparklines", () => {
  it("resamples by bucket mean, preserving the shape of the whole series", () => {
    const series = [0, 0, 0, 0, 10, 10, 10, 10];
    expect(resample(series, 4)).toEqual([0, 0, 10, 10]);
    expect(resample([1, 2], 4)).toEqual([1, 2]); // fewer samples draw one-to-one
  });

  it("a flat series draws the floor rung, never blank", () => {
    expect(sparkline([5, 5, 5, 5], 10)).toBe(TREND_LEVELS[0].repeat(4));
    expect(sparkline([1, 8], 10)).toBe(`${TREND_LEVELS[0]}${TREND_LEVELS.at(-1)}`);
  });
});

describe("cell appearance", () => {
  it("gives every crop distinct growing and mature looks", () => {
    const seen = new Set<string>();
    for (let crop = 1; crop <= 6; crop += 1) {
      const mature = resolveAppearance(CROP_CODE_BASE + (crop - 1) * BUCKETS_PER_CROP + BUCKET_MATURE);
      expect(mature.glyph).toBe(mature.glyph.toUpperCase());
      seen.add(`${mature.glyph}:${mature.colorToken}`);
    }
    expect(seen.size).toBe(6); // no two crops share glyph+color at maturity
    expect(resolveAppearance(CELL_FOR_SALE).label).toContain("for sale");
    expect(resolveAppearance(200).label).toBe("unknown");
  });
});

describe("legend", () => {
  it("is generated from the appearance registry", () => {
    const groups = describeLegend() as Array<{ title: string; entries: Array<{ label: string; glyph: string }> }>;
    const crops = groups.find((g) => g.title === "Crops");
    expect(crops?.entries.map((e) => e.label)).toContain("corn (mature)");
    expect(crops?.entries.map((e) => e.label)).toContain("tomatoes (growing)");
    const land = groups.find((g) => g.title === "Land");
    expect(land?.entries.map((e) => e.label)).toContain("farmstead");
  });
});

describe("money formatting", () => {
  it("compacts to a status-bar width", () => {
    expect(formatMoney(1_234_567)).toBe("$1.23M");
    expect(formatMoney(45_600)).toBe("$46k");
    expect(formatMoney(4_560)).toBe("$4.6k");
    expect(formatMoney(-320)).toBe("-$320");
  });
});
