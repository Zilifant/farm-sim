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

/** How often the selected cell's inspection detail is refreshed (live query). */
const INSPECTION_INTERVAL_MS = 500;

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
  /** @type {object | null} last cell.inspect payload for the selection */
  #inspectionDetail = null;
  #inspectionTimer = null;

  /**
   * @param {object} options
   * @param {import('./state/RendererStore.js').RendererStore} options.store
   * @param {import('./transports/RendererTransport.js').RendererTransport} options.transport
   * @param {HTMLCanvasElement} options.canvas
   * @param {{statusPanel: object, inspector: object, metricsPanel: object,
   *          eventLog: object, controls: object}} options.ui
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
        this.#inspectionDetail = null;
        this.#stopInspectionPolling();
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
   * Select a world cell. The cell is the unit of selection: open water is
   * still worth inspecting, so clicking it reports the cell rather than
   * clearing. Local only — nothing is sent anywhere except the inspection
   * query that keeps the detail fresh.
   * @param {number} cellX
   * @param {number} cellY
   */
  selectCell(cellX, cellY) {
    this.#store.setSelection({ cellX, cellY });
    this.#inspectionDetail = null;
    this.#refreshInspection(cellX, cellY);
  }

  clearSelection() {
    this.#store.setSelection(null);
    this.#inspectionDetail = null;
    this.#stopInspectionPolling();
  }

  /**
   * Fetch inspection detail for the selected cell (energy and breed age are
   * query-only — the bulk frame carries species alone), and keep it fresh
   * while the cell stays selected. One cell at a time, on a slow cadence,
   * cancelled the moment the selection changes.
   */
  async #refreshInspection(cellX, cellY) {
    this.#stopInspectionPolling();
    await this.#fetchInspection(cellX, cellY);
    this.#inspectionTimer = setInterval(() => {
      const selection = this.#store.selection;
      if (!selection) {
        this.#stopInspectionPolling();
        return;
      }
      this.#fetchInspection(selection.cellX, selection.cellY);
    }, INSPECTION_INTERVAL_MS);
  }

  async #fetchInspection(cellX, cellY) {
    try {
      const result = await this.#transport.sendCommand({ type: 'cell.inspect', x: cellX, y: cellY });
      const selection = this.#store.selection;
      // The selection can change while the request is in flight; a late reply
      // for a cell nobody is looking at any more must not overwrite the one
      // they are.
      if (result?.ok && selection && selection.cellX === cellX && selection.cellY === cellY) {
        this.#inspectionDetail = result;
        this.#updatePanels();
      }
    } catch {
      // Inspection detail is optional enrichment; the store view stands alone.
    }
  }

  #stopInspectionPolling() {
    if (this.#inspectionTimer !== null) {
      clearInterval(this.#inspectionTimer);
      this.#inspectionTimer = null;
    }
  }

  recenter() {
    if (this.#store.world) {
      this.#camera.centerOn(this.#store.world.width / 2, this.#store.world.height / 2);
      this.#dirty = true;
    }
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
      dragging = { startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false };
      this.#canvas.setPointerCapture(event.pointerId);
    });
    this.#canvas.addEventListener('pointermove', (event) => {
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
      if (!dragging) return;
      const wasDrag = dragging.moved;
      dragging = null;
      this.#canvas.classList.remove('dragging');
      if (this.#canvas.hasPointerCapture?.(event.pointerId)) this.#canvas.releasePointerCapture(event.pointerId);
      if (wasDrag) return;
      const cell = this.#cellUnderPointer(event);
      if (cell) this.selectCell(cell.cellX, cell.cellY);
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
        case 'Escape': this.clearSelection(); break;
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
    this.#ui.inspector.render(this.#store, this.#inspectionDetail);
    this.#ui.metricsPanel.render(this.#store);
    this.#ui.eventLog.render(this.#store);
  }
}
