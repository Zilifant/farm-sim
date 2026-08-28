/**
 * Top status bar: connection state, mode, simulation identity, run state,
 * calendar date and season, today's weather, cash, debt, camera position,
 * zoom, and the result of the last command. Plain DOM, text-first
 * (connection state and command results are announced via aria-live).
 *
 * The command line reports the command that is current, and nothing else:
 * `RendererApp` clears it the moment another command goes out, and whatever
 * that command reports takes its place.
 */

/** Compact money: $1.23M / $456k / -$78. @param {number} value */
export function formatMoney(value) {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${sign}$${Math.round(abs / 1000)}k`;
  if (abs >= 1_000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  return `${sign}$${Math.round(abs)}`;
}

export class StatusPanel {
  #els;

  /** @param {HTMLElement} container */
  constructor(container) {
    container.innerHTML = `
      <span class="status-item"><span class="status-label">link</span> <span id="status-connection" aria-live="polite">disconnected</span></span>
      <span class="status-item"><span id="status-mode" class="mode-badge">LIVE</span></span>
      <span class="status-item"><span class="status-label">sim</span> <span id="status-sim">–</span></span>
      <span class="status-item"><span id="status-run">–</span></span>
      <span class="status-item"><span class="status-label">date</span> <span id="status-date">–</span></span>
      <span class="status-item"><span id="status-season">–</span></span>
      <span class="status-item"><span class="status-label">wx</span> <span id="status-weather">–</span></span>
      <span class="status-item"><span class="status-label">cash</span> <span id="status-cash">–</span></span>
      <span class="status-item"><span class="status-label">debt</span> <span id="status-debt">–</span></span>
      <span class="status-item"><span class="status-label">cam</span> <span id="status-camera">–</span></span>
      <span class="status-item"><span class="status-label">cell</span> <span id="status-zoom">–</span></span>
      <span class="status-item" id="command-status" aria-live="polite"></span>
    `;
    this.#els = {
      connection: container.querySelector('#status-connection'),
      sim: container.querySelector('#status-sim'),
      run: container.querySelector('#status-run'),
      date: container.querySelector('#status-date'),
      season: container.querySelector('#status-season'),
      weather: container.querySelector('#status-weather'),
      cash: container.querySelector('#status-cash'),
      debt: container.querySelector('#status-debt'),
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
    this.#els.date.textContent = store.date?.label ?? (store.tick >= 0 ? `d${store.tick}` : '–');
    this.#els.season.textContent = store.date?.season ?? '–';
    this.#els.weather.textContent = store.weather
      ? `${Math.round(store.weather.high)}°/${Math.round(store.weather.low)}°${store.weather.rain > 0 ? ` ☔${store.weather.rain}"` : ''}`
      : '–';
    this.#els.cash.textContent = store.finance ? formatMoney(store.finance.cash) : '–';
    this.#els.cash.className = store.finance && store.finance.cash < 0 ? 'warn' : '';
    this.#els.debt.textContent = store.finance ? formatMoney(store.finance.debt) : '–';
    this.#els.camera.textContent = `${Math.floor(camera.centerX)},${Math.floor(camera.centerY)}`;
    this.#els.zoom.textContent = `${camera.cellSize}px`;
  }
}
