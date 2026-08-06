/**
 * Transport controls. Everything that changes the simulation goes out as a
 * protocol command on the transport — this panel never mutates anything
 * directly. Camera buttons are renderer-local.
 *
 * The run controls reflect the **host's** state rather than this client's
 * last intention: the play/pause button, the speed readout, and the status
 * bar are all driven by `setRunState`, fed by the run state every frame and
 * command result carries. A control that shows what you last asked for
 * rather than what is true is worse than no control.
 */

/**
 * Selectable tick rates, slowest first. Stepped through with the `«` / `»`
 * buttons rather than picked from a list: speed is something you nudge while
 * watching, and a dropdown makes you look away from the grid to change it.
 */
const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4, 8];

/** Fixed step sizes; the number field covers everything else. */
const STEP_SIZES = [1, 10, 100];

/** Matches the host's step bound, restated because the renderer imports
 * nothing from the server. The host validates regardless. */
const MAX_STEP_TICKS = 10000;

/** Matches the host's seed bound (unsigned 32-bit), restated the same way. */
const MAX_SEED = 0xffffffff;

export class Controls {
  #els;
  #callbacks;
  #runState = { paused: null, speed: 1 };

  /**
   * @param {HTMLElement} container
   * @param {object} callbacks
   * @param {(command: object) => Promise<object>} callbacks.onCommand
   * @param {(ticks: number) => Promise<object>} callbacks.onStep pause-then-step
   * @param {() => Promise<object>} callbacks.onToggleRun
   * @param {(command: object) => Promise<object>} callbacks.onRestart rebuild the world
   * @param {() => void} callbacks.onRecenter
   * @param {() => void} callbacks.onReconnect
   * @param {(text: string, kind: 'ok' | 'warn' | 'bad') => void} callbacks.onStatus
   *        report the result of a command (drawn in the status bar, not here)
   */
  constructor(container, callbacks) {
    this.#callbacks = callbacks;
    container.innerHTML = `
      <h2>Controls</h2>
      <div class="control-row">
        <button type="button" id="ctl-run" class="run-toggle">…</button>
        <button type="button" id="ctl-slower" title="Slower ([)">&laquo;</button>
        <span id="ctl-speed-value" class="speed-value" aria-live="polite">1x</span>
        <button type="button" id="ctl-faster" title="Faster (])">&raquo;</button>
      </div>
      <div class="control-row">
        <span class="dim">step</span>
        ${STEP_SIZES.map((ticks) => `<button type="button" data-step="${ticks}">+${ticks}</button>`).join('')}
        <input type="number" id="ctl-step-n" min="1" max="${MAX_STEP_TICKS}" step="1" value="500" aria-label="Ticks to advance" />
        <button type="button" id="ctl-advance">go</button>
      </div>
      <div class="control-row">
        <button type="button" id="ctl-recenter">Recenter (C)</button>
        <button type="button" id="ctl-reconnect">Reconnect</button>
      </div>
      <details class="inspector-section">
        <summary><span class="section-title">New World</span> <span class="section-badge"> from seed</span></summary>
        <div class="section-body">
          <div class="control-row">
            <label for="ctl-seed" class="dim">Seed</label>
            <input type="number" id="ctl-seed" min="0" max="${MAX_SEED}" step="1" aria-label="Simulation seed" />
            <button type="button" id="ctl-restart">Restart</button>
          </div>
          <div class="control-row">
            <button type="button" id="ctl-restart-random">Random</button>
            <button type="button" id="ctl-restart-same">Replay Current</button>
          </div>
          <p class="hint">Same seed, same ocean — every world is reproducible from its number.</p>
        </div>
      </details>`;
    this.#els = {
      run: container.querySelector('#ctl-run'),
      slower: container.querySelector('#ctl-slower'),
      faster: container.querySelector('#ctl-faster'),
      speedValue: container.querySelector('#ctl-speed-value'),
      stepN: container.querySelector('#ctl-step-n'),
      advance: container.querySelector('#ctl-advance'),
      steps: [...container.querySelectorAll('[data-step]')],
      recenter: container.querySelector('#ctl-recenter'),
      reconnect: container.querySelector('#ctl-reconnect'),
      seed: container.querySelector('#ctl-seed'),
      restart: container.querySelector('#ctl-restart'),
      restartRandom: container.querySelector('#ctl-restart-random'),
      restartSame: container.querySelector('#ctl-restart-same'),
    };

    this.#els.run.addEventListener('click', () => callbacks.onToggleRun());
    this.#els.slower.addEventListener('click', () => this.stepSpeed(-1));
    this.#els.faster.addEventListener('click', () => this.stepSpeed(1));
    for (const button of this.#els.steps) {
      button.addEventListener('click', () => callbacks.onStep(Number(button.dataset.step)));
    }
    this.#els.advance.addEventListener('click', () => this.#advance());
    this.#els.stepN.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.#advance();
    });
    this.#els.recenter.addEventListener('click', () => callbacks.onRecenter());
    this.#els.reconnect.addEventListener('click', () => callbacks.onReconnect());

    this.#els.restart.addEventListener('click', () => this.#restart(Math.round(Number(this.#els.seed.value))));
    this.#els.seed.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.#restart(Math.round(Number(this.#els.seed.value)));
    });
    // The *host* picks a random seed, not the renderer: presentation has to be
    // reproducible from its inputs. Omitting the seed asks for any world; the
    // result says which one, and that number lands in the field — so "replay
    // this one" is just naming the seed you were already given.
    this.#els.restartRandom.addEventListener('click', () => this.#restart(undefined));
    this.#els.restartSame.addEventListener('click', () => {
      const current = Math.round(Number(this.#els.seed.value));
      this.#restart(Number.isFinite(current) ? current : undefined);
    });

    this.setRunState(this.#runState);
  }

  /**
   * Move one notch along the speed ladder. Clamped rather than wrapped — a
   * "faster" button that silently becomes "slowest" would be a trap.
   * @param {-1 | 1} direction
   */
  stepSpeed(direction) {
    const current = SPEED_OPTIONS.indexOf(this.#runState.speed);
    // An unrecognized speed (set by another client) lands on the nearest notch
    // rather than refusing to move.
    const from =
      current >= 0
        ? current
        : SPEED_OPTIONS.reduce(
            (best, speed, index) =>
              Math.abs(speed - this.#runState.speed) < Math.abs(SPEED_OPTIONS[best] - this.#runState.speed)
                ? index
                : best,
            0,
          );
    const next = SPEED_OPTIONS[Math.min(SPEED_OPTIONS.length - 1, Math.max(0, from + direction))];
    if (next === this.#runState.speed) return;
    this.#send({ type: 'simulation.setSpeed', multiplier: next });
  }

  /** @param {number | undefined} seed undefined lets the host pick one at random */
  #restart(seed) {
    if (seed !== undefined && (!Number.isFinite(seed) || seed < 0 || seed > MAX_SEED)) {
      this.setStatus(`seed must be a whole number in [0, ${MAX_SEED}]`, 'bad');
      return;
    }
    const command = { type: 'simulation.restart' };
    if (seed !== undefined) command.seed = seed;
    this.#callbacks.onRestart(command);
  }

  #advance() {
    const ticks = Math.round(Number(this.#els.stepN.value));
    if (!Number.isFinite(ticks) || ticks < 1 || ticks > MAX_STEP_TICKS) {
      this.setStatus(`ticks must be a whole number in [1, ${MAX_STEP_TICKS}]`, 'bad');
      return;
    }
    this.#callbacks.onStep(ticks);
  }

  async #send(command) {
    const result = await this.#callbacks.onCommand(command);
    this.showResult(command, result);
  }

  /**
   * Reflect the host's run state — including when something other than this
   * client changed it.
   * @param {{paused: boolean | null, speed: number}} runState
   */
  setRunState(runState) {
    this.#runState = runState;
    const unknown = runState.paused === null;
    this.#els.run.textContent = unknown ? '…' : runState.paused ? '▶ Resume' : '⏸ Pause';
    this.#els.run.title = unknown ? 'waiting for the host' : 'Pause/resume (Space)';
    this.#els.run.classList.toggle('paused', runState.paused === true);
    this.#els.speedValue.textContent = `${runState.speed}x`;
    this.#els.slower.disabled = runState.speed <= SPEED_OPTIONS[0];
    this.#els.faster.disabled = runState.speed >= SPEED_OPTIONS.at(-1);
  }

  /** Show the seed of the world currently being watched. @param {number | string} seed */
  setSeed(seed) {
    if (document.activeElement !== this.#els.seed && typeof seed === 'number') {
      this.#els.seed.value = String(seed);
    }
  }

  /**
   * @param {object | null} command
   * @param {object} result structured protocol command result
   */
  showResult(command, result) {
    if (result?.ok) {
      const label = command?.type ?? 'command';
      const ticks = command?.ticks !== undefined ? ` ${command.ticks}` : '';
      this.setStatus(`${label}${ticks} ok${result.tick !== undefined ? ` (tick ${result.tick})` : ''}`, 'ok');
    } else {
      this.setStatus(`${command?.type ?? 'command'} failed: ${result?.error?.message ?? 'unknown error'}`, 'bad');
    }
  }

  /**
   * Say what the last command did. The line itself lives in the **status
   * bar**: a result belongs beside the run state it explains, and one at the
   * foot of a collapsible panel is invisible exactly when the panel is folded.
   * @param {string} text @param {'ok' | 'warn' | 'bad'} [kind]
   */
  setStatus(text, kind = 'ok') {
    this.#callbacks.onStatus?.(text, kind);
  }
}
