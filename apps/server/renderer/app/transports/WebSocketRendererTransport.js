/**
 * Live WebSocket transport.
 *
 * Speaks the host's WS envelope: server frames are
 * { type: 'snapshot.full' | 'snapshot.delta' | 'command.result' | 'error',
 *   payload, requestId? } and the client sends
 * { type: 'command', requestId, command }.
 *
 * Reconnects with exponential backoff up to a maximum. The server sends a
 * fresh full snapshot on every (re)connection, which resynchronizes the
 * store. A connection epoch guards against frames from a superseded socket
 * being applied after a reconnect.
 */
import { RendererTransport, TransportEvents } from './RendererTransport.js';

const COMMAND_TIMEOUT_MS = 5000;

export class WebSocketRendererTransport extends RendererTransport {
  #url;
  #WebSocketImpl;
  #socket = null;
  #epoch = 0;
  #manuallyClosed = false;
  #reconnectDelayMs;
  #minReconnectDelayMs;
  #maxReconnectDelayMs;
  #reconnectTimer = null;
  #nextRequestId = 0;
  /** @type {Map<string, {resolve: Function, timer: ReturnType<typeof setTimeout>}>} */
  #pendingCommands = new Map();

  /**
   * @param {object} options
   * @param {string} options.url e.g. ws://host/ws
   * @param {typeof WebSocket} [options.WebSocketImpl] injectable for tests/node
   * @param {number} [options.minReconnectDelayMs]
   * @param {number} [options.maxReconnectDelayMs]
   */
  constructor({ url, WebSocketImpl = globalThis.WebSocket, minReconnectDelayMs = 500, maxReconnectDelayMs = 10000 }) {
    super();
    this.#url = url;
    this.#WebSocketImpl = WebSocketImpl;
    this.#minReconnectDelayMs = minReconnectDelayMs;
    this.#maxReconnectDelayMs = maxReconnectDelayMs;
    this.#reconnectDelayMs = minReconnectDelayMs;
  }

  get isOpen() {
    return this.#socket !== null && this.#socket.readyState === 1;
  }

  connect() {
    this.#manuallyClosed = false;
    this.#clearReconnectTimer();
    this.#epoch += 1;
    const epoch = this.#epoch;
    this.emit({ type: TransportEvents.CONNECTION, state: 'connecting' });
    const socket = new this.#WebSocketImpl(this.#url);
    this.#socket = socket;

    socket.onopen = () => {
      if (epoch !== this.#epoch) return;
      this.#reconnectDelayMs = this.#minReconnectDelayMs;
      this.emit({ type: TransportEvents.CONNECTION, state: 'connected' });
    };
    socket.onmessage = (messageEvent) => {
      if (epoch !== this.#epoch) return; // stale socket — never apply
      this.#routeFrame(messageEvent.data);
    };
    socket.onclose = () => {
      if (epoch !== this.#epoch) return;
      this.#socket = null;
      this.#failPendingCommands('connection-closed');
      if (this.#manuallyClosed) {
        this.emit({ type: TransportEvents.CONNECTION, state: 'disconnected' });
        return;
      }
      this.emit({
        type: TransportEvents.CONNECTION,
        state: 'reconnecting',
        detail: `retrying in ${Math.round(this.#reconnectDelayMs / 1000)}s`,
      });
      this.#scheduleReconnect();
    };
    socket.onerror = () => {
      // onclose follows and owns the state transition.
    };
  }

  disconnect() {
    this.#manuallyClosed = true;
    this.#clearReconnectTimer();
    if (this.#socket) {
      this.#socket.close();
    } else {
      this.emit({ type: TransportEvents.CONNECTION, state: 'disconnected' });
    }
  }

  /**
   * @param {object} command protocol command
   * @returns {Promise<object>} structured command result
   */
  async sendCommand(command) {
    if (!this.isOpen) {
      return { ok: false, error: { code: 'not-connected', message: 'WebSocket is not connected' } };
    }
    this.#nextRequestId += 1;
    const requestId = `ws-${this.#nextRequestId}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pendingCommands.delete(requestId);
        resolve({ ok: false, error: { code: 'timeout', message: 'command result did not arrive in time' } });
      }, COMMAND_TIMEOUT_MS);
      this.#pendingCommands.set(requestId, { resolve, timer });
      this.#socket.send(JSON.stringify({ type: 'command', requestId, command }));
    });
  }

  #routeFrame(raw) {
    let frame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      this.emit({ type: TransportEvents.NOTICE, level: 'warn', message: 'ignored a non-JSON frame' });
      return;
    }
    switch (frame?.type) {
      case 'snapshot.full':
        this.emit({ type: TransportEvents.SNAPSHOT, snapshot: frame.payload });
        break;
      case 'snapshot.delta':
        this.emit({ type: TransportEvents.DELTA, delta: frame.payload });
        break;
      case 'events.batch':
        this.emit({ type: TransportEvents.EVENTS, batch: frame.payload });
        break;
      case 'command.result': {
        const pending = frame.requestId != null ? this.#pendingCommands.get(frame.requestId) : null;
        if (pending) {
          clearTimeout(pending.timer);
          this.#pendingCommands.delete(frame.requestId);
          pending.resolve(frame.payload);
        }
        this.emit({ type: TransportEvents.COMMAND_RESULT, requestId: frame.requestId ?? null, result: frame.payload });
        break;
      }
      case 'error':
        this.emit({
          type: TransportEvents.NOTICE,
          level: 'warn',
          message: `server error: ${frame.payload?.message ?? frame.payload?.code ?? 'unknown'}`,
        });
        break;
      default:
        this.emit({ type: TransportEvents.NOTICE, level: 'warn', message: `unknown frame type "${frame?.type}"` });
    }
  }

  #scheduleReconnect() {
    this.#clearReconnectTimer();
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectDelayMs = Math.min(this.#reconnectDelayMs * 2, this.#maxReconnectDelayMs);
      this.connect();
    }, this.#reconnectDelayMs);
  }

  #clearReconnectTimer() {
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  #failPendingCommands(code) {
    for (const { resolve, timer } of this.#pendingCommands.values()) {
      clearTimeout(timer);
      resolve({ ok: false, error: { code, message: 'connection closed before the result arrived' } });
    }
    this.#pendingCommands.clear();
  }
}
