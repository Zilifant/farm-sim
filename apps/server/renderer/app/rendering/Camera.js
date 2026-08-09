/**
 * Renderer-local camera: a center point in world coordinates plus a cell
 * size in CSS pixels. Purely presentational — moving or zooming the camera
 * never sends anything to the simulation and never affects simulation
 * fidelity. One world unit is one grid cell.
 */

/**
 * Supported cell sizes in CSS pixels. The floor is 10px: below that a cell
 * stops being a reliable click target, and since every cell is now selectable
 * — bare ground included — an unhittable cell is a broken control rather than
 * a merely small one. The cost is that a large world no longer fits the
 * viewport at minimum zoom, which is what drag-panning is for.
 */
export const ZOOM_LEVELS = Object.freeze([10, 12, 14, 16, 20, 24, 28, 32]);
export const DEFAULT_CELL_SIZE = 16;

export class Camera {
  /**
   * @param {object} [options]
   * @param {number} [options.centerX] world coordinate
   * @param {number} [options.centerY] world coordinate
   * @param {number} [options.cellSize] CSS pixels per world cell
   */
  constructor({ centerX = 0, centerY = 0, cellSize = DEFAULT_CELL_SIZE } = {}) {
    this.centerX = centerX;
    this.centerY = centerY;
    this.cellSize = Camera.snapCellSize(cellSize);
  }

  /** Nearest supported zoom level. @param {number} size */
  static snapCellSize(size) {
    let best = ZOOM_LEVELS[0];
    for (const level of ZOOM_LEVELS) {
      if (Math.abs(level - size) < Math.abs(best - size)) best = level;
    }
    return best;
  }

  /**
   * Pan by whole world cells.
   * @param {number} dxCells
   * @param {number} dyCells
   */
  panByCells(dxCells, dyCells) {
    this.centerX += dxCells;
    this.centerY += dyCells;
  }

  /**
   * Pan by screen pixels (drag-to-pan). Dragging moves the *world* with the
   * pointer, so the camera travels the opposite way — a drag to the right
   * reveals what is to the left. Fractional, unlike `panByCells`: a pointer
   * drag that snapped to whole cells would stutter.
   * @param {number} dxPixels pointer movement, screen pixels
   * @param {number} dyPixels
   */
  panByPixels(dxPixels, dyPixels) {
    this.centerX -= dxPixels / this.cellSize;
    this.centerY -= dyPixels / this.cellSize;
  }

  /** @param {number} x @param {number} y */
  centerOn(x, y) {
    this.centerX = x;
    this.centerY = y;
  }

  /** @returns {boolean} true if the zoom level changed */
  zoomIn() {
    return this.#stepZoom(1);
  }

  /** @returns {boolean} true if the zoom level changed */
  zoomOut() {
    return this.#stepZoom(-1);
  }

  #stepZoom(direction) {
    const index = ZOOM_LEVELS.indexOf(this.cellSize);
    const next = ZOOM_LEVELS[index + direction];
    if (next === undefined) return false;
    this.cellSize = next;
    return true;
  }

  /**
   * Zoom keeping the given world point fixed on screen (mouse-wheel zoom
   * anchored near the cursor).
   * @param {number} worldX
   * @param {number} worldY
   * @param {1 | -1} direction
   * @returns {boolean} true if the zoom level changed
   */
  zoomAt(worldX, worldY, direction) {
    const oldSize = this.cellSize;
    const changed = direction > 0 ? this.zoomIn() : this.zoomOut();
    if (!changed) return false;
    const ratio = oldSize / this.cellSize;
    this.centerX = worldX - (worldX - this.centerX) * ratio;
    this.centerY = worldY - (worldY - this.centerY) * ratio;
    return true;
  }

  /**
   * Keep the camera center inside the world when bounds are known.
   * @param {{width: number, height: number} | null} world
   */
  clampToWorld(world) {
    if (!world) return;
    this.centerX = Math.min(Math.max(this.centerX, 0), world.width);
    this.centerY = Math.min(Math.max(this.centerY, 0), world.height);
  }
}
