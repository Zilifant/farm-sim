/**
 * Renderer orchestration: wires the transport → store → canvas + panels,
 * owns the requestAnimationFrame loop, and handles all input.
 *
 * Clock separation, exactly as in the biome renderer: the simulation tick
 * arrives in messages, message arrival happens on transport callbacks, and
 * drawing happens on browser frames. Nothing here ever advances simulation
 * time — the grid redraws only when marked dirty (state change, camera move,
 * selection change, resize), showing discrete cell changes between
 * authoritative ticks.
 */
import { RendererProtocolError } from './state/RendererStore.js';
import { CELL_OWNED_GRASS, CELL_UNOWNED } from './rendering/CellAppearance.js';
import { Camera } from './rendering/Camera.js';
import { createProjection } from './rendering/GridProjection.js';
import { AsciiGridRenderer } from './rendering/AsciiGridRenderer.js';
import { TransportEvents } from './transports/RendererTransport.js';

/**
 * Pointer movement, in CSS pixels, past which a press is a pan rather than a
 * click. Small enough that a deliberate click never pans, large enough that a
 * shaky click still selects.
 */
const DRAG_THRESHOLD_PX = 4;

/** Field-size limits, restated from @sim/farm (the sim validates regardless). */
const MIN_FIELD_SIDE = 3;
const MAX_FIELD_SIDE = 24;

export class RendererApp {
  #store;
  #transport;
  #canvas;
  #grid;
  #camera;
  #ui;
  #dirty = true;
  #hasCentered = false;
  /**
   * The cell under the pointer, or null when the pointer is off the grid or a
   * drag is in progress. Drawn as yellow corner brackets, distinct from the
   * selected cell's grey fill.
   * @type {{cellX: number, cellY: number} | null}
   */
  #hoverCell = null;
  /** Field-placement mode: drag a rectangle on owned ground to create a field. */
  #placeMode = false;
  /** @type {{x0: number, y0: number, x1: number, y1: number} | null} */
  #placeDrag = null;

  /**
   * @param {object} options
   * @param {import('./state/RendererStore.js').RendererStore} options.store
   * @param {import('./transports/RendererTransport.js').RendererTransport} options.transport
   * @param {HTMLCanvasElement} options.canvas
   * @param {{statusPanel: object, fieldWindow: object, metricsPanel: object,
   *          eventLog: object, controls: object, farmPanel: object}} options.ui
   */
  constructor({ store, transport, canvas, ui }) {
    this.#store = store;
    this.#transport = transport;
    this.#canvas = canvas;
    this.#grid = new AsciiGridRenderer(canvas);
    this.#camera = new Camera();
    this.#ui = ui;
  }

  get camera() {
    return this.#camera;
  }

  start() {
    this.#store.subscribe(() => {
      this.#dirty = true;
      this.#updatePanels();
    });
    this.#transport.subscribe((event) => this.#onTransportEvent(event));

    this.#resize();
    window.addEventListener('resize', () => this.#resize());
    // The grid's size is not only the window's: dragging a column edge or
    // folding a panel changes the viewport without any window event, so the
    // wrapper is observed directly.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => this.#resize()).observe(this.#canvas.parentElement);
    }
    this.#bindPointer();
    this.#bindKeyboard();

    this.#transport.connect();
    const frame = () => {
      if (this.#dirty) {
        this.#dirty = false;
        this.#grid.draw({
          store: this.#store,
          camera: this.#camera,
          hoverCell: this.#hoverCell,
          placement: this.#placementPreview(),
        });
        this.#ui.statusPanel.update(this.#store, this.#camera);
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- transport

  #onTransportEvent(event) {
    switch (event.type) {
      case TransportEvents.CONNECTION:
        this.#store.setConnection(event.state, event.detail ?? '');
        break;
      case TransportEvents.SNAPSHOT:
        this.#applySnapshot(event.snapshot);
        break;
      case TransportEvents.EVENTS:
        try {
          this.#store.applyEventBatch(event.batch);
        } catch (error) {
          this.#reportProtocolProblem(error);
        }
        break;
      case TransportEvents.COMMAND_RESULT:
        // Promise-based senders surface results; nothing extra to do here.
        break;
      case TransportEvents.NOTICE:
        this.#ui.statusPanel.setCommandStatus(event.message, event.level === 'warn' ? 'warn' : 'ok');
        break;
      default:
        break;
    }
  }

  #applySnapshot(snapshot) {
    try {
      const previousSimulation = this.#store.simulationId;
      this.#store.applyFullSnapshot(snapshot);
      if (previousSimulation !== null && this.#store.simulationId !== previousSimulation) {
        // A restart dropped the store's selection; drop what hangs off it too.
        this.#ui.fieldWindow.close();
        this.#hasCentered = false;
      }
      if (!this.#hasCentered && this.#store.world) {
        this.#camera.centerOn(this.#store.world.width / 2, this.#store.world.height / 2);
        this.#hasCentered = true;
      }
      this.#ui.controls.setRunState(this.#store.runState);
      if (this.#store.seed !== null) this.#ui.controls.setSeed(this.#store.seed);
    } catch (error) {
      this.#reportProtocolProblem(error);
    }
  }

  #reportProtocolProblem(error) {
    const label = error instanceof RendererProtocolError ? `protocol: ${error.message}` : String(error);
    this.#ui.statusPanel.setCommandStatus(label, 'bad');
  }

  // ----------------------------------------------------------------- commands

  /**
   * All external change flows through protocol commands on the transport.
   * Sending clears the last report: the status line says what the current
   * command did, and this is the single chokepoint every command passes
   * through.
   * @param {object} command
   */
  async sendCommand(command) {
    this.#ui.statusPanel.clearCommandStatus();
    return this.#transport.sendCommand(command);
  }

  /**
   * Advance the simulation by whole ticks, pausing first if it is running —
   * a Step button on a running simulation should do the obvious thing rather
   * than print a red error.
   * @param {number} ticks
   */
  async stepTicks(ticks) {
    if (this.#store.runState.paused !== true) {
      const paused = await this.sendCommand({ type: 'simulation.pause' });
      if (!paused?.ok) {
        this.#ui.controls.showResult({ type: 'simulation.pause' }, paused);
        return paused;
      }
    }
    const result = await this.sendCommand({ type: 'simulation.step', ticks });
    this.#ui.controls.showResult({ type: 'simulation.step', ticks }, result);
    return result;
  }

  /** Pause or resume, whichever the host is not currently doing. */
  async toggleRun() {
    const command = { type: this.#store.runState.paused ? 'simulation.resume' : 'simulation.pause' };
    const result = await this.sendCommand(command);
    this.#ui.controls.showResult(command, result);
    return result;
  }

  /**
   * Rebuild the world. A restart shares no tick and not even a simulationId
   * with what came before; the store drops the old world's state when the new
   * frame arrives.
   * @param {object} command
   */
  async restart(command) {
    const result = await this.sendCommand(command);
    this.#ui.controls.showResult(command, result);
    if (!result?.ok) return result;
    this.clearSelection();
    this.#ui.controls.setSeed(result.seed);
    this.#ui.statusPanel.setCommandStatus(`restarted — seed ${result.seed}`, 'ok');
    return result;
  }

  reconnect() {
    this.#transport.disconnect();
    this.#transport.connect();
  }

  // ---------------------------------------------------------------- selection

  /**
   * Select a world cell. A cell inside a field opens the floating field
   * window beside the click — the map is the way in to every per-field
   * action; a lane or the farmstead just carries the selection mark.
   * @param {number} cellX
   * @param {number} cellY
   * @param {{x: number, y: number}} [anchor] viewport-relative click point
   */
  selectCell(cellX, cellY, anchor) {
    this.#store.setSelection({ cellX, cellY });
    const at = anchor ?? { x: 0, y: 0 };
    const fieldId = this.#store.fieldIdAtXY(cellX, cellY);
    if (fieldId !== null) {
      this.#ui.fieldWindow.openFor(fieldId, at);
      return;
    }
    // Open ground: the parcel is the unit — buy it, or place a field on it.
    // The farmstead, driveway, and road carry only the selection mark.
    const code = this.#store.cellAtXY(cellX, cellY);
    const parcelId = this.#store.parcelIdAtXY(cellX, cellY);
    if (parcelId !== null && (code === CELL_OWNED_GRASS || code === CELL_UNOWNED)) {
      this.#ui.fieldWindow.openForParcel(parcelId, at);
    } else {
      this.#ui.fieldWindow.close();
    }
  }

  clearSelection() {
    this.#store.setSelection(null);
    this.#ui.fieldWindow.close();
  }

  recenter() {
    if (this.#store.world) {
      this.#camera.centerOn(this.#store.world.width / 2, this.#store.world.height / 2);
      this.#dirty = true;
    }
  }

  // ---------------------------------------------------------- field placement

  get placing() {
    return this.#placeMode;
  }

  /** Enter/leave placement mode: in it, dragging draws a new field's
   * rectangle instead of panning, previewed green (placeable) or red. */
  togglePlaceMode(on = !this.#placeMode) {
    if (this.#placeMode === on) return;
    this.#placeMode = on;
    this.#placeDrag = null;
    this.#canvas.classList.toggle('placing', on);
    this.#ui.statusPanel.setCommandStatus(
      on ? 'placing a field — drag a rectangle on your ground (Esc cancels)' : 'placement cancelled',
      'ok',
    );
    if (on) {
      this.clearSelection();
      this.#canvas.focus();
    }
    this.#dirty = true;
  }

  /** The normalized in-progress rectangle with validity, or null. */
  #placementPreview() {
    if (!this.#placeMode || !this.#placeDrag) return null;
    const rect = normalizeRect(this.#placeDrag);
    return { ...rect, valid: this.#placementValid(rect) };
  }

  /** Client-side check so the preview can say no before the sim does: every
   * covered cell must be the player's open ground, sides within limits. */
  #placementValid(rect) {
    const world = this.#store.world;
    if (!world) return false;
    if (rect.w < MIN_FIELD_SIDE || rect.h < MIN_FIELD_SIDE) return false;
    if (rect.w > MAX_FIELD_SIDE || rect.h > MAX_FIELD_SIDE) return false;
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > world.width || rect.y + rect.h > world.height) return false;
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        if (this.#store.cellAtXY(x, y) !== CELL_OWNED_GRASS) return false;
      }
    }
    return true;
  }

  async #finishPlacement() {
    const preview = this.#placementPreview();
    this.#placeDrag = null;
    if (!preview) {
      this.togglePlaceMode(false);
      return;
    }
    if (!preview.valid) {
      this.#ui.statusPanel.setCommandStatus(
        'that rectangle will not work — it must sit on your open ground, at least 3×3 cells',
        'bad',
      );
      this.#dirty = true;
      return; // stay in placement mode for another try
    }
    this.togglePlaceMode(false);
    const command = {
      type: 'farm.command',
      command: { kind: 'farm.field.create', x: preview.x, y: preview.y, w: preview.w, h: preview.h },
    };
    const result = await this.sendCommand(command);
    this.#ui.statusPanel.setCommandStatus(
      result?.ok
        ? `field created (${preview.w * preview.h / 2} ac)`
        : `field.create failed: ${result?.error?.message ?? 'unknown error'}`,
      result?.ok ? 'ok' : 'bad',
    );
  }

  // -------------------------------------------------------------------- input

  /**
   * Set the hovered cell (or clear it with null), redrawing only when it
   * actually changes so pointer moves within one cell cost nothing.
   * @param {{cellX: number, cellY: number} | null} cell
   */
  #setHoverCell(cell) {
    const same =
      cell === null
        ? this.#hoverCell === null
        : this.#hoverCell !== null && this.#hoverCell.cellX === cell.cellX && this.#hoverCell.cellY === cell.cellY;
    if (same) return;
    this.#hoverCell = cell;
    this.#dirty = true;
  }

  /** The in-world cell under a pointer event, or null if it is off the map. */
  #cellUnderPointer(event) {
    const rect = this.#canvas.getBoundingClientRect();
    const projection = createProjection(this.#camera, this.#grid.cssWidth, this.#grid.cssHeight);
    const cell = projection.cellAtScreen(event.clientX - rect.left, event.clientY - rect.top);
    const world = this.#store.world;
    const inWorld =
      world && cell.cellX >= 0 && cell.cellY >= 0 && cell.cellX < world.width && cell.cellY < world.height;
    return inWorld ? cell : null;
  }

  #bindPointer() {
    // Drag-to-pan. A drag past the threshold suppresses the click that
    // follows, because otherwise every pan ends by selecting whatever the
    // pointer happened to stop over.
    let dragging = null;
    this.#canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this.#setHoverCell(null);
      if (this.#placeMode) {
        const cell = this.#cellUnderPointer(event);
        if (cell) {
          this.#placeDrag = { x0: cell.cellX, y0: cell.cellY, x1: cell.cellX, y1: cell.cellY };
          this.#canvas.setPointerCapture(event.pointerId);
          this.#dirty = true;
        }
        return;
      }
      dragging = { startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false };
      this.#canvas.setPointerCapture(event.pointerId);
    });
    this.#canvas.addEventListener('pointermove', (event) => {
      if (this.#placeMode) {
        if (this.#placeDrag) {
          const cell = this.#cellUnderPointer(event);
          if (cell && (cell.cellX !== this.#placeDrag.x1 || cell.cellY !== this.#placeDrag.y1)) {
            this.#placeDrag.x1 = cell.cellX;
            this.#placeDrag.y1 = cell.cellY;
            this.#dirty = true;
          }
        }
        return;
      }
      if (!dragging) {
        this.#setHoverCell(this.#cellUnderPointer(event));
        return;
      }
      const dx = event.clientX - dragging.lastX;
      const dy = event.clientY - dragging.lastY;
      if (
        !dragging.moved &&
        Math.abs(event.clientX - dragging.startX) < DRAG_THRESHOLD_PX &&
        Math.abs(event.clientY - dragging.startY) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      dragging.moved = true;
      dragging.lastX = event.clientX;
      dragging.lastY = event.clientY;
      this.#camera.panByPixels(dx, dy);
      this.#camera.clampToWorld(this.#store.world);
      this.#canvas.classList.add('dragging');
      this.#dirty = true;
    });
    this.#canvas.addEventListener('pointerleave', () => this.#setHoverCell(null));
    const endDrag = (event) => {
      if (this.#placeMode) {
        if (this.#canvas.hasPointerCapture?.(event.pointerId)) this.#canvas.releasePointerCapture(event.pointerId);
        if (this.#placeDrag) void this.#finishPlacement();
        return;
      }
      if (!dragging) return;
      const wasDrag = dragging.moved;
      dragging = null;
      this.#canvas.classList.remove('dragging');
      if (this.#canvas.hasPointerCapture?.(event.pointerId)) this.#canvas.releasePointerCapture(event.pointerId);
      if (wasDrag) return;
      const cell = this.#cellUnderPointer(event);
      if (cell) {
        const rect = this.#canvas.getBoundingClientRect();
        this.selectCell(cell.cellX, cell.cellY, {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
      }
      this.#canvas.focus();
    };
    this.#canvas.addEventListener('pointerup', endDrag);
    this.#canvas.addEventListener('pointercancel', endDrag);
    this.#canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const rect = this.#canvas.getBoundingClientRect();
        const projection = createProjection(this.#camera, this.#grid.cssWidth, this.#grid.cssHeight);
        const anchor = projection.worldPointAtScreen(event.clientX - rect.left, event.clientY - rect.top);
        if (this.#camera.zoomAt(anchor.x, anchor.y, event.deltaY < 0 ? 1 : -1)) {
          this.#camera.clampToWorld(this.#store.world);
          this.#dirty = true;
        }
      },
      { passive: false },
    );
  }

  #bindKeyboard() {
    window.addEventListener('keydown', (event) => {
      if (event.target instanceof Element && event.target.closest('input, select, textarea, button')) return;
      const step = event.shiftKey ? 10 : 1;
      let handled = true;
      switch (event.key) {
        case 'ArrowUp': case 'w': case 'W': this.#pan(0, -step); break;
        case 'ArrowDown': case 's': case 'S': this.#pan(0, step); break;
        case 'ArrowLeft': case 'a': case 'A': this.#pan(-step, 0); break;
        case 'ArrowRight': case 'd': case 'D': this.#pan(step, 0); break;
        case '+': case '=': this.#zoom(1); break;
        case '-': case '_': this.#zoom(-1); break;
        case 'c': case 'C': this.recenter(); break;
        case 'f': case 'F': this.togglePlaceMode(); break;
        case 'Escape':
          if (this.#placeMode) {
            this.togglePlaceMode(false);
          } else {
            this.clearSelection();
          }
          break;
        case ' ': this.toggleRun(); break;
        case '[': this.#ui.controls.stepSpeed(-1); break;
        case ']': this.#ui.controls.stepSpeed(1); break;
        default:
          handled = false;
      }
      if (handled) event.preventDefault();
    });
  }

  #pan(dx, dy) {
    this.#camera.panByCells(dx, dy);
    this.#camera.clampToWorld(this.#store.world);
    this.#dirty = true;
  }

  #zoom(direction) {
    if (direction > 0 ? this.#camera.zoomIn() : this.#camera.zoomOut()) {
      this.#dirty = true;
    }
  }

  #resize() {
    const wrap = this.#canvas.parentElement;
    this.#grid.resize(wrap.clientWidth, wrap.clientHeight, window.devicePixelRatio || 1);
    this.#dirty = true;
  }

  // ----------------------------------------------------------------- panels

  #updatePanels() {
    this.#ui.statusPanel.update(this.#store, this.#camera);
    this.#ui.fieldWindow.render(this.#store);
    this.#ui.metricsPanel.render(this.#store);
    this.#ui.eventLog.render(this.#store);
    this.#ui.farmPanel.render(this.#store);
  }
}

/** Two drag corners → a normalized world rect. */
function normalizeRect({ x0, y0, x1, y1 }) {
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  return { x, y, w: Math.abs(x1 - x0) + 1, h: Math.abs(y1 - y0) + 1 };
}
