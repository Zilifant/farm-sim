/**
 * Top status bar: connection state, mode, simulation identity, run state,
 * tick, populations, camera position, zoom, and the result of the last
 * command. Plain DOM, text-first (connection state and command results are
 * announced via aria-live).
 *
 * The command line reports the command that is current, and nothing else:
 * `RendererApp` clears it the moment another command goes out, and whatever
 * that command reports takes its place.
 */
export class StatusPanel {
  #els;

  /** @param {HTMLElement} container */
  constructor(container) {
    container.innerHTML = `
      <span class="status-item"><span class="status-label">link</span> <span id="status-connection" aria-live="polite">disconnected</span></span>
      <span class="status-item"><span id="status-mode" class="mode-badge">LIVE</span></span>
      <span class="status-item"><span class="status-label">sim</span> <span id="status-sim">–</span></span>
      <span class="status-item"><span id="status-run">–</span></span>
      <span class="status-item"><span class="status-label">tick</span> <span id="status-tick">–</span></span>
      <span class="status-item"><span class="status-label">fish</span> <span id="status-fish">–</span></span>
      <span class="status-item"><span class="status-label">sharks</span> <span id="status-sharks">–</span></span>
      <span class="status-item"><span class="status-label">cam</span> <span id="status-camera">–</span></span>
      <span class="status-item"><span class="status-label">cell</span> <span id="status-zoom">–</span></span>
      <span class="status-item" id="command-status" aria-live="polite"></span>
    `;
    this.#els = {
      connection: container.querySelector('#status-connection'),
      sim: container.querySelector('#status-sim'),
      run: container.querySelector('#status-run'),
      tick: container.querySelector('#status-tick'),
      fish: container.querySelector('#status-fish'),
      sharks: container.querySelector('#status-sharks'),
      camera: container.querySelector('#status-camera'),
      zoom: container.querySelector('#status-zoom'),
      command: container.querySelector('#command-status'),
    };
  }

  /**
   * Report what the last command did. Every caller comes through here, so
   * there is exactly one line saying what just happened.
   * @param {string} text
   * @param {'ok' | 'warn' | 'bad'} [kind]
   */
  setCommandStatus(text, kind = 'ok') {
    this.#els.command.textContent = text;
    this.#els.command.className = `status-item ${kind}`;
  }

  /** Drop the last report — another command has been sent. */
  clearCommandStatus() {
    this.#els.command.textContent = '';
    this.#els.command.className = 'status-item';
  }

  /**
   * @param {import('../state/RendererStore.js').RendererStore} store
   * @param {import('../rendering/Camera.js').Camera} camera
   */
  update(store, camera) {
    const { state, detail } = store.connection;
    this.#els.connection.textContent = detail ? `${state} (${detail})` : state;
    this.#els.connection.className =
      state === 'connected' ? 'ok' : state === 'connecting' || state === 'reconnecting' ? 'warn' : 'bad';
    this.#els.sim.textContent = store.simulationId ?? '–';
    // Whether the world is moving is the one thing a viewer cannot infer from
    // the grid — a paused simulation and a quiet one look identical. Reported
    // by the host on every frame, so another client pausing shows up here too.
    if (store.runState.paused === null) {
      this.#els.run.textContent = '…';
      this.#els.run.className = 'dim';
    } else {
      this.#els.run.textContent = store.runState.paused ? 'PAUSED' : `RUNNING ${store.runState.speed}x`;
      this.#els.run.className = store.runState.paused ? 'run-badge paused' : 'run-badge';
    }
    this.#els.tick.textContent = store.tick >= 0 ? String(store.tick) : '–';
    this.#els.fish.textContent = String(store.populations.fish);
    this.#els.sharks.textContent = String(store.populations.sharks);
    this.#els.camera.textContent = `${Math.floor(camera.centerX)},${Math.floor(camera.centerY)}`;
    this.#els.zoom.textContent = `${camera.cellSize}px`;
  }
}
