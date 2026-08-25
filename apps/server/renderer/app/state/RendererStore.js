/**
 * Normalized store of authoritative simulation output, in the biome
 * renderer's mold: the renderer portrays what the host reports and never
 * computes farm outcomes of its own. Full frames replace the world (this
 * protocol has no deltas — a frame carries the whole map plus the farm's
 * structured state); farm events are deduplicated by `seq` and kept in a
 * bounded buffer; a change of `simulationId` (a restart) clears everything
 * the store holds about the old world.
 *
 * The store owns authoritative-output state plus the selection; camera,
 * hover, and panel state live with their owners.
 */

export const SUPPORTED_PROTOCOL_VERSION = 2;

/** Bounded retention: farm events kept for the log. */
const EVENT_LIMIT = 2000;
/** Price/cash samples kept for the sparklines (one per new-tick frame). */
const HISTORY_LIMIT = 730;

export class RendererProtocolError extends Error {}

/** @param {string} base64 @returns {Uint8Array} */
function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class RendererStore {
  /** @type {{state: string, detail: string}} */
  connection = { state: 'disconnected', detail: '' };
  /** @type {string | null} */
  simulationId = null;
  /** @type {number | string | null} */
  seed = null;
  tick = -1;
  /** @type {{width: number, height: number} | null} */
  world = null;
  /** @type {Uint8Array | null} appearance code per cell, row-major */
  cells = null;
  /** @type {Uint8Array | null} field id per cell (255 = none), row-major */
  fieldIds = null;
  /** @type {object | null} calendar date {year, doy, month, dayOfMonth, season, label} */
  date = null;
  /** @type {object | null} today's weather {high, low, rain} */
  weather = null;
  /** @type {Array<object>} short-term forecast, nearest first */
  forecast = [];
  /** @type {Array<object>} per-field state, by field id */
  fields = [];
  /** @type {Array<object>} the operation queue, oldest first */
  ops = [];
  /** @type {Array<object>} equipment levels and capacities */
  equipment = [];
  /** @type {Array<object>} per-crop market + storage rows */
  markets = [];
  /** @type {object | null} cash/debt/net worth/storage summary */
  finance = null;
  /** The host's reported run state; null means "not yet known". */
  runState = { paused: /** @type {boolean | null} */ (null), speed: 1 };
  /** @type {{cellX: number, cellY: number} | null} */
  selection = null;
  /** @type {Array<{seq: number, kind: string, tick: number, message: string}>} */
  events = [];
  /** @type {Array<{tick: number, cash: number, prices: Record<string, number>}>} */
  history = [];
  #lastEventSeq = 0;
  #listeners = new Set();

  /** @param {() => void} listener @returns {() => void} unsubscribe */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify() {
    for (const listener of this.#listeners) listener();
  }

  /** @param {string} state @param {string} [detail] */
  setConnection(state, detail = '') {
    this.connection = { state, detail };
    this.#notify();
  }

  /** @param {{cellX: number, cellY: number} | null} selection */
  setSelection(selection) {
    this.selection = selection;
    this.#notify();
  }

  /** @param {number} index row-major cell index @returns {number} */
  cellAt(index) {
    return this.cells?.[index] ?? 0;
  }

  /** @param {number} cellX @param {number} cellY @returns {number} */
  cellAtXY(cellX, cellY) {
    if (!this.world) return 0;
    return this.cellAt(cellY * this.world.width + cellX);
  }

  /** The field id under a cell, or null. @param {number} cellX @param {number} cellY */
  fieldIdAtXY(cellX, cellY) {
    if (!this.world || !this.fieldIds) return null;
    const id = this.fieldIds[cellY * this.world.width + cellX];
    return id === 255 ? null : id;
  }

  /**
   * Apply a full frame, replacing the world. Validates the protocol version
   * and shape; a frame from another simulation (a restart) drops the old
   * world's selection, events, and history.
   * @param {object} frame
   */
  applyFullSnapshot(frame) {
    if (frame?.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
      throw new RendererProtocolError(
        `unsupported protocol v${frame?.protocolVersion} (this renderer speaks v${SUPPORTED_PROTOCOL_VERSION})`,
      );
    }
    if (!frame.world || typeof frame.cells !== 'string') {
      throw new RendererProtocolError('snapshot is missing world or cells');
    }
    const cells = decodeBase64(frame.cells);
    if (cells.length !== frame.world.width * frame.world.height) {
      throw new RendererProtocolError(
        `cell buffer is ${cells.length} cells for a ${frame.world.width}x${frame.world.height} world`,
      );
    }
    if (this.simulationId !== null && frame.simulationId !== this.simulationId) {
      // A restart shares no tick and no history with what came before.
      this.selection = null;
      this.events = [];
      this.history = [];
      this.#lastEventSeq = 0;
    }
    this.simulationId = frame.simulationId ?? null;
    this.seed = frame.seed ?? null;
    this.world = frame.world;
    this.cells = cells;
    this.fieldIds = typeof frame.fieldIds === 'string' ? decodeBase64(frame.fieldIds) : this.fieldIds;
    this.date = frame.date ?? null;
    this.weather = frame.weather ?? null;
    this.forecast = Array.isArray(frame.forecast) ? frame.forecast : [];
    this.fields = Array.isArray(frame.fields) ? frame.fields : [];
    this.ops = Array.isArray(frame.ops) ? frame.ops : [];
    this.equipment = Array.isArray(frame.equipment) ? frame.equipment : [];
    this.markets = Array.isArray(frame.markets) ? frame.markets : [];
    this.finance = frame.finance ?? null;
    this.runState = { paused: frame.running === undefined ? null : !frame.running, speed: frame.speed ?? 1 };
    const isNewTick = frame.tick !== this.tick;
    this.tick = frame.tick;
    if (isNewTick && this.finance) {
      const prices = {};
      for (const market of this.markets) prices[market.key] = market.price;
      this.history.push({ tick: frame.tick, cash: this.finance.cash, prices });
      if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    }
    this.#notify();
  }

  /**
   * Append a farm-event batch, deduplicated by seq (reconnects resend recent
   * history). A batch from another simulation is ignored — its frame will
   * arrive and reset the store first.
   * @param {object} batch
   */
  applyEventBatch(batch) {
    if (!Array.isArray(batch?.events)) {
      throw new RendererProtocolError('event batch has no events array');
    }
    if (batch.simulationId && this.simulationId && batch.simulationId !== this.simulationId) return;
    let appended = false;
    for (const event of batch.events) {
      if (typeof event?.seq !== 'number' || event.seq <= this.#lastEventSeq) continue;
      this.events.push(event);
      this.#lastEventSeq = event.seq;
      appended = true;
    }
    if (appended) {
      if (this.events.length > EVENT_LIMIT) this.events.splice(0, this.events.length - EVENT_LIMIT);
      this.#notify();
    }
  }
}
