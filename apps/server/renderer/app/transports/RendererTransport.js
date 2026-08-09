/**
 * Transport contract between the renderer and the simulation host.
 *
 * A transport delivers protocol messages and accepts protocol commands; the
 * renderer never talks to the simulation any other way. Implementations
 * emit normalized transport events to subscribers:
 *
 *   { type: 'connection',    state, detail? }   state: connecting|connected|
 *                                               reconnecting|disconnected|fixture
 *   { type: 'snapshot',      snapshot }          protocol snapshot.full
 *   { type: 'delta',         delta }             protocol snapshot.delta
 *   { type: 'events',        batch }             protocol events.batch
 *   { type: 'commandResult', requestId, result } structured command result
 *   { type: 'notice',        level, message }    transport-level information
 */

export const TransportEvents = Object.freeze({
  CONNECTION: 'connection',
  SNAPSHOT: 'snapshot',
  DELTA: 'delta',
  EVENTS: 'events',
  COMMAND_RESULT: 'commandResult',
  NOTICE: 'notice',
});

export class RendererTransport {
  #listeners = new Set();

  /**
   * @param {(event: object) => void} listener
   * @returns {() => void} unsubscribe
   */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** @protected @param {object} event */
  emit(event) {
    for (const listener of this.#listeners) listener(event);
  }

  /** Begin delivering messages. */
  connect() {
    throw new Error(`${this.constructor.name} must implement connect()`);
  }

  /** Stop delivering messages. */
  disconnect() {}

  /**
   * Submit a protocol command.
   * @param {object} _command
   * @returns {Promise<object>} structured command result
   */
  async sendCommand(_command) {
    throw new Error(`${this.constructor.name} does not support commands`);
  }

  /**
   * Fetch a full snapshot (optionally bounded), used for resynchronization.
   * @param {{minX: number, minY: number, maxX: number, maxY: number} | null} [_bounds]
   * @returns {Promise<object | null>}
   */
  async requestSnapshot(_bounds = null) {
    return null;
  }

  /**
   * Fetch a protocol entity inspection, or null when unsupported.
   * @param {number} _entityId
   * @returns {Promise<object | null>}
   */
  async requestEntity(_entityId) {
    return null;
  }
}
