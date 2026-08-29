/**
 * Canvas 2D ASCII grid renderer, in the biome renderer's visual tradition.
 *
 * Draw order per frame: background → field tint (the hovered/selected cell's
 * whole field, so a *field* reads as the unit it is) → cell glyphs →
 * selection overlay → hover brackets. One monospace glyph per cell,
 * integer-aligned, device-pixel-ratio aware. No sprites, gradients, shadows,
 * or decorative animation — discrete cell changes only.
 *
 * Colors come from the Dracula CSS custom properties on the document root,
 * with the exact hex fallbacks from CellAppearance for safety.
 */
import { createProjection } from './GridProjection.js';
import { DRACULA_COLORS, EQUIPMENT_APPEARANCE, resolveAppearance } from './CellAppearance.js';

const MONO_STACK =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

export class AsciiGridRenderer {
  #canvas;
  #context;
  #cssWidth = 0;
  #cssHeight = 0;
  /** @type {Map<string, string>} theme token → resolved color */
  #colors = new Map();

  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.#canvas = canvas;
    this.#context = canvas.getContext('2d');
  }

  get cssWidth() {
    return this.#cssWidth;
  }

  get cssHeight() {
    return this.#cssHeight;
  }

  /**
   * Fit the drawing surface to its element size at the device pixel ratio.
   * @param {number} cssWidth
   * @param {number} cssHeight
   * @param {number} devicePixelRatio
   */
  resize(cssWidth, cssHeight, devicePixelRatio = 1) {
    this.#cssWidth = Math.max(1, Math.floor(cssWidth));
    this.#cssHeight = Math.max(1, Math.floor(cssHeight));
    this.#canvas.width = Math.floor(this.#cssWidth * devicePixelRatio);
    this.#canvas.height = Math.floor(this.#cssHeight * devicePixelRatio);
    this.#canvas.style.width = `${this.#cssWidth}px`;
    this.#canvas.style.height = `${this.#cssHeight}px`;
    this.#context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }

  #color(token) {
    let resolved = this.#colors.get(token);
    if (!resolved) {
      const fromTheme =
        typeof getComputedStyle === 'function'
          ? getComputedStyle(document.documentElement).getPropertyValue(`--dracula-${token}`).trim()
          : '';
      resolved = fromTheme || DRACULA_COLORS[token] || DRACULA_COLORS.foreground;
      this.#colors.set(token, resolved);
    }
    return resolved;
  }

  /**
   * Draw one frame. Pure read of the store — nothing here mutates
   * authoritative state.
   * @param {object} options
   * @param {import('../state/RendererStore.js').RendererStore} options.store
   * @param {import('./Camera.js').Camera} options.camera
   * @param {{cellX: number, cellY: number} | null} [options.hoverCell]
   *        the cell under the pointer, framed in yellow corner brackets (the
   *        crosshair cursor aims at it) — grey fill stays selection-only
   * @param {{x: number, y: number, w: number, h: number, valid: boolean} | null}
   *        [options.placement] the field rectangle being drawn in placement
   *        mode, washed green (placeable) or red (blocked)
   * @param {{cells: Array<{x: number, y: number}>, erase: boolean} | null}
   *        [options.roadPaint] the dirt-road path being painted in road mode
   * @param {Array<{cellX: number, cellY: number, kind: string}>} [options.machines]
   *        equipment at work, one marker per active operation
   */
  draw({ store, camera, hoverCell = null, placement = null, roadPaint = null, machines = [] }) {
    const ctx = this.#context;
    const projection = createProjection(camera, this.#cssWidth, this.#cssHeight);
    const { cellSize } = projection;
    const world = store.world;

    ctx.fillStyle = this.#color('background');
    ctx.fillRect(0, 0, this.#cssWidth, this.#cssHeight);

    const fontSize = Math.max(cellSize - 2, 5);
    ctx.font = `${fontSize}px ${MONO_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const half = cellSize / 2;

    if (world) {
      const cells = projection.visibleCellBounds();
      const minCellX = Math.max(cells.minCellX, 0);
      const maxCellX = Math.min(cells.maxCellX, world.width - 1);
      const minCellY = Math.max(cells.minCellY, 0);
      const maxCellY = Math.min(cells.maxCellY, world.height - 1);

      // --- Field tint: the field under the pointer (or the selection) is
      // washed with a faint fill so the whole management unit reads at once.
      const activeCell = hoverCell ?? store.selection;
      const activeField = activeCell ? store.fieldIdAtXY(activeCell.cellX, activeCell.cellY) : null;
      if (activeField !== null) {
        ctx.fillStyle = this.#color('background-light');
        for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
          const rowOffset = cellY * world.width;
          for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
            if (store.fieldIds?.[rowOffset + cellX] === activeField) {
              const { px, py } = projection.cellToScreen(cellX, cellY);
              ctx.fillRect(px, py, cellSize, cellSize);
            }
          }
        }
      }

      // --- Glyph pass, one per visible in-world cell.
      for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
        const rowOffset = cellY * world.width;
        for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
          const appearance = resolveAppearance(store.cellAt(rowOffset + cellX));
          const { px, py } = projection.cellToScreen(cellX, cellY);
          ctx.fillStyle = this.#color(appearance.colorToken);
          ctx.fillText(appearance.glyph, px + half, py + half);
        }
      }
    }

    // --- Selection overlay. Selection is a *cell*: the mark is drawn whether
    // or not anything grows in it, and the occupant's glyph is redrawn in the
    // selection colour on top — a selected lane must not read as a hole.
    const selection = store.selection;
    if (selection) {
      const { px, py } = projection.cellToScreen(selection.cellX, selection.cellY);
      ctx.fillStyle = this.#color('selection');
      ctx.fillRect(px, py, cellSize, cellSize);
      this.#drawBrackets(px, py, cellSize, this.#color('bright-yellow'));
      const appearance = resolveAppearance(store.cellAtXY(selection.cellX, selection.cellY));
      ctx.fillStyle = this.#color('bright-yellow');
      ctx.fillText(appearance.glyph, px + half, py + half);
    }

    // --- Equipment: an inverse cell (filled square, dark glyph) per active
    // operation, driven along its field's sweep by the app's animation.
    for (const machine of machines) {
      const appearance = EQUIPMENT_APPEARANCE[machine.kind];
      if (!appearance) continue;
      const { px, py } = projection.cellToScreen(machine.cellX, machine.cellY);
      ctx.fillStyle = this.#color(appearance.colorToken);
      ctx.fillRect(px, py, cellSize, cellSize);
      ctx.fillStyle = this.#color('background');
      ctx.fillText(appearance.glyph, px + half, py + half);
    }

    // --- Road paint: the dirt-road path under construction (or erasure).
    if (roadPaint && roadPaint.cells.length > 0) {
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = this.#color(roadPaint.erase ? 'red' : 'orange');
      for (const cell of roadPaint.cells) {
        const { px, py } = projection.cellToScreen(cell.x, cell.y);
        ctx.fillRect(px, py, cellSize, cellSize);
      }
      ctx.restore();
    }

    // --- Placement preview: the field being drawn, washed green or red with
    // a solid outline. Drawn over the glyphs — while placing, the rectangle
    // is what the player is looking at.
    if (placement && placement.w > 0 && placement.h > 0) {
      const { px, py } = projection.cellToScreen(placement.x, placement.y);
      const wPx = placement.w * cellSize;
      const hPx = placement.h * cellSize;
      const color = this.#color(placement.valid ? 'green' : 'red');
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = color;
      ctx.fillRect(px, py, wPx, hPx);
      ctx.restore();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(px + 1, py + 1, wPx - 2, hPx - 2);
    }

    // --- Hover mark, drawn last so it sits above everything: yellow corner
    // brackets on the cell under the pointer. Skipped when it coincides with
    // the selected cell, which already carries brackets.
    if (
      hoverCell &&
      !(selection && hoverCell.cellX === selection.cellX && hoverCell.cellY === selection.cellY)
    ) {
      const { px, py } = projection.cellToScreen(hoverCell.cellX, hoverCell.cellY);
      this.#drawBrackets(px, py, cellSize, this.#color('bright-yellow'));
    }
  }

  /** Corner brackets so selection is visible without relying on color alone. */
  #drawBrackets(px, py, cellSize, color) {
    const ctx = this.#context;
    const arm = Math.max(2, Math.floor(cellSize / 4));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const x0 = px + 0.5;
    const y0 = py + 0.5;
    const x1 = px + cellSize - 0.5;
    const y1 = py + cellSize - 0.5;
    ctx.moveTo(x0, y0 + arm); ctx.lineTo(x0, y0); ctx.lineTo(x0 + arm, y0);
    ctx.moveTo(x1 - arm, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + arm);
    ctx.moveTo(x1, y1 - arm); ctx.lineTo(x1, y1); ctx.lineTo(x1 - arm, y1);
    ctx.moveTo(x0 + arm, y1); ctx.lineTo(x0, y1); ctx.lineTo(x0, y1 - arm);
    ctx.stroke();
  }
}
