// Unit tests for the renderer's pure browser modules — imported directly
// from the static app (plain ES modules, so Node loads them fine). The
// camera/projection files are ports of the biome renderer's; the store and
// sparkline logic are Wa-Tor's own.

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

function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const species = new Uint8Array(9);
  species[4] = 1; // one fish, center cell
  return {
    protocolVersion: 1,
    simulationId: "wator-1-0",
    seed: 1,
    tick: 5,
    running: true,
    speed: 2,
    world: { width: 3, height: 3 },
    species: Buffer.from(species).toString("base64"),
    populations: { fish: 1, sharks: 0 },
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
    expect(store.speciesAtCell(1, 1)).toBe(1);
    expect(store.history).toEqual([{ tick: 5, fish: 1, sharks: 0 }]);
    // Same tick again (a forced frame): no duplicate history sample.
    store.applyFullSnapshot(frame());
    expect(store.history).toHaveLength(1);
  });

  it("rejects wrong protocol versions and truncated grids", () => {
    const store = new RendererStore();
    expect(() => store.applyFullSnapshot(frame({ protocolVersion: 2 }))).toThrow(RendererProtocolError);
    expect(() => store.applyFullSnapshot(frame({ species: "AAAA" }))).toThrow(/cells for a 3x3 world/);
  });

  it("a restart (new simulationId) clears selection, events, and history", () => {
    const store = new RendererStore();
    store.applyFullSnapshot(frame());
    store.setSelection({ cellX: 1, cellY: 1 });
    store.applyEventBatch({
      simulationId: "wator-1-0",
      events: [{ seq: 1, type: "census", tick: 5, fish: 1, sharks: 0 }],
    });
    expect(store.events).toHaveLength(1);
    store.applyFullSnapshot(frame({ simulationId: "wator-7-1", tick: 0 }));
    expect(store.selection).toBeNull();
    expect(store.events).toHaveLength(0);
    expect(store.history).toEqual([{ tick: 0, fish: 1, sharks: 0 }]);
  });

  it("deduplicates census events by seq", () => {
    const store = new RendererStore();
    store.applyFullSnapshot(frame());
    const batch = {
      simulationId: "wator-1-0",
      events: [
        { seq: 1, type: "census", tick: 5, fish: 1, sharks: 0 },
        { seq: 2, type: "census", tick: 10, fish: 2, sharks: 0 },
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

describe("legend", () => {
  it("is generated from the appearance registry", () => {
    const groups = describeLegend() as Array<{ title: string; entries: Array<{ label: string; glyph: string }> }>;
    const creatures = groups.find((g) => g.title === "Creatures");
    expect(creatures?.entries.map((e) => e.label)).toContain("fish");
    expect(creatures?.entries.map((e) => e.label)).toContain("shark");
    expect(groups.find((g) => g.title === "Ocean")?.entries[0]?.glyph).toBe("~");
  });
});
