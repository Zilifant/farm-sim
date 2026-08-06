/**
 * Pure coordinate projection between the layers:
 *
 *   simulation position (authoritative floats — never mutated here)
 *     → world grid cell (floor; one world unit = one cell)
 *     → camera-relative screen cell
 *     → canvas pixel position (integer-aligned to avoid half-pixel blur)
 *
 * Everything in this module is side-effect free and browser-independent.
 */

/**
 * The world grid cell an entity occupies. Positions are clamped by the
 * simulation to [0, width]; an entity sitting exactly on the far border
 * displays in the last cell.
 * @param {{x: number, y: number}} position
 * @param {{width: number, height: number} | null} world
 * @returns {{cellX: number, cellY: number}}
 */
export function worldCellOf(position, world) {
  let cellX = Math.floor(position.x);
  let cellY = Math.floor(position.y);
  if (world) {
    cellX = Math.min(Math.max(cellX, 0), world.width - 1);
    cellY = Math.min(Math.max(cellY, 0), world.height - 1);
  }
  return { cellX, cellY };
}

/**
 * Build a projection for one frame.
 * @param {{centerX: number, centerY: number, cellSize: number}} camera
 * @param {number} viewportWidth CSS pixels
 * @param {number} viewportHeight CSS pixels
 */
export function createProjection(camera, viewportWidth, viewportHeight) {
  const { cellSize } = camera;
  // World coordinate of the viewport's top-left pixel.
  const originX = camera.centerX - viewportWidth / (2 * cellSize);
  const originY = camera.centerY - viewportHeight / (2 * cellSize);
  // Pixel position of world x=0 / y=0, rounded ONCE so every cell lands on
  // the same integer lattice (per-cell rounding would drift).
  const offsetPxX = Math.round(-originX * cellSize);
  const offsetPxY = Math.round(-originY * cellSize);

  return {
    cellSize,
    originX,
    originY,

    /**
     * Top-left canvas pixel of a world grid cell.
     * @param {number} cellX @param {number} cellY
     */
    cellToScreen(cellX, cellY) {
      return { px: cellX * cellSize + offsetPxX, py: cellY * cellSize + offsetPxY };
    },

    /**
     * World grid cell under a canvas pixel (click / cursor).
     * @param {number} px @param {number} py
     */
    cellAtScreen(px, py) {
      return {
        cellX: Math.floor((px - offsetPxX) / cellSize),
        cellY: Math.floor((py - offsetPxY) / cellSize),
      };
    },

    /**
     * Continuous world point under a canvas pixel (wheel-zoom anchor).
     * @param {number} px @param {number} py
     */
    worldPointAtScreen(px, py) {
      return { x: originX + px / cellSize, y: originY + py / cellSize };
    },

    /** Inclusive world-cell range currently visible. */
    visibleCellBounds() {
      return {
        minCellX: Math.floor(originX),
        minCellY: Math.floor(originY),
        maxCellX: Math.floor(originX + viewportWidth / cellSize),
        maxCellY: Math.floor(originY + viewportHeight / cellSize),
      };
    },

    /**
     * Visible world-space bounds with a margin (for entity queries).
     * @param {number} [marginCells]
     */
    visibleWorldBounds(marginCells = 1) {
      const cells = this.visibleCellBounds();
      return {
        minX: cells.minCellX - marginCells,
        minY: cells.minCellY - marginCells,
        maxX: cells.maxCellX + 1 + marginCells,
        maxY: cells.maxCellY + 1 + marginCells,
      };
    },
  };
}

/**
 * Entities from `entities` whose grid cell is exactly (cellX, cellY).
 * @param {Iterable<object>} entities
 * @param {number} cellX
 * @param {number} cellY
 * @param {{width: number, height: number} | null} world
 * @returns {object[]}
 */
export function occupantsInCell(entities, cellX, cellY, world) {
  const occupants = [];
  for (const entity of entities) {
    const cell = worldCellOf(entity, world);
    if (cell.cellX === cellX && cell.cellY === cellY) occupants.push(entity);
  }
  return occupants;
}
