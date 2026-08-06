/**
 * Normalized store of authoritative simulation output, in the biome
 * renderer's mold: the renderer portrays what the host reports and never
 * computes ecological outcomes of its own. Full frames replace the grid
 * (this protocol has no deltas — the world is small enough to resend);
 * census events are deduplicated by `seq` and kept in a bounded buffer; a
 * change of `simulationId` (a restart) clears everything the store holds
 * about the old world.
 *
 * The store owns authoritative-output state plus the selection; camera,
 * hover, and panel state live with their owners.
 */

export const SUPPORTED_PROTOCOL_VERSION = 1;

/** Bounded retention: census readings kept for the log and the trends. */
const EVENT_LIMIT = 2000;
/** Population samples kept for the sparklines (one per applied frame). */
const HISTORY_LIMIT = 600;

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
  /** @type {Uint8Array | null} species code per cell, row-major */
  species = null;
  /** @type {{fish: number, sharks: number}} */
  populations = { fish: 0, sharks: 0 };
  /** The host's reported run state; null means "not yet known". */
  runState = { paused: /** @type {boolean | null} */ (null), speed: 1 };
  /** @type {{cellX: number, cellY: number} | null} */
  selection = null;
  /** @type {Array<{seq: number, type: string, tick: number, fish?: number, sharks?: number}>} */
  events = [];
  /** @type {Array<{tick: number, fish: number, sharks: number}>} */
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
  speciesAt(index) {
    return this.species?.[index] ?? 0;
  }

  /** @param {number} cellX @param {number} cellY @returns {number} */
  speciesAtCell(cellX, cellY) {
    if (!this.world) return 0;
    return this.speciesAt(cellY * this.world.width + cellX);
  }

  /**
   * Apply a full frame, replacing the grid. Validates the protocol version
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
    if (!frame.world || typeof frame.species !== 'string') {
      throw new RendererProtocolError('snapshot is missing world or species');
    }
    const species = decodeBase64(frame.species);
    if (species.length !== frame.world.width * frame.world.height) {
      throw new RendererProtocolError(
        `species buffer is ${species.length} cells for a ${frame.world.width}x${frame.world.height} world`,
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
    this.species = species;
    this.populations = frame.populations ?? { fish: 0, sharks: 0 };
    this.runState = { paused: frame.running === undefined ? null : !frame.running, speed: frame.speed ?? 1 };
    const isNewTick = frame.tick !== this.tick;
    this.tick = frame.tick;
    if (isNewTick) {
      this.history.push({ tick: frame.tick, ...this.populations });
      if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    }
    this.#notify();
  }

  /**
   * Append a census batch, deduplicated by seq (reconnects resend recent
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
