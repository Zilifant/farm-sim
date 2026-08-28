/**
 * Bounded farm-event log: one line per event the host emits — operations
 * completing or failing, harvests, frost, losses, year-end closes. Newest
 * first, clipped at the column edge, rendered from the store's bounded
 * buffer.
 */

/**
 * How much of the buffer is drawn. A per-render DOM budget, not a retention
 * setting — the store keeps more; this decides how far back you can scroll.
 */
const MAX_RENDERED_EVENTS = 200;

/** Tone per event kind; anything unlisted renders neutral. */
const KIND_TONE = Object.freeze({
  harvest: 'ok',
  frost: 'warn',
  loss: 'warn',
  year: 'ok',
});

/** Lead glyph per event kind, so the log scans by shape as well as color. */
const KIND_GLYPH = Object.freeze({
  op: '·',
  harvest: '✓',
  frost: '❄',
  loss: '✗',
  year: '§',
});

export class EventLog {
  #container;

  /** @param {HTMLElement} container */
  constructor(container) {
    container.innerHTML = `
      <h2>Events</h2>
      <p class="hint">operations, harvests, weather damage, year ends</p>
      <ul id="event-log-list"></ul>`;
    this.#container = container;
  }

  /** @param {import('../state/RendererStore.js').RendererStore} store */
  render(store) {
    const list = this.#container.querySelector('#event-log-list');
    if (!list) return;
    const events = store.events;
    const lines = [];
    const start = Math.max(0, events.length - MAX_RENDERED_EVENTS);
    for (let i = events.length - 1; i >= start; i -= 1) {
      const event = events[i];
      const tone = KIND_TONE[event.kind] ?? 'dim';
      const glyph = KIND_GLYPH[event.kind] ?? '·';
      const failed = event.data?.failed === true;
      lines.push(
        `<li><span class="dim">d${event.tick}</span> <span class="${failed ? 'bad' : tone}">${glyph}</span> ${event.message}</li>`,
      );
    }
    list.innerHTML = lines.join('');
  }
}
