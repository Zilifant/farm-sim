/**
 * Bounded census-event log: one line per census reading the host emits, with
 * the change since the previous reading. Newest first, clipped at the column
 * edge, rendered from the store's bounded buffer.
 */

/**
 * How much of the buffer is drawn. A per-render DOM budget, not a retention
 * setting — the store keeps more; this decides how far back you can scroll.
 */
const MAX_RENDERED_EVENTS = 200;

/** A signed population change with a tone. @param {number} delta */
function change(delta) {
  if (delta === 0) return '<span class="dim">·</span>';
  const tone = delta > 0 ? 'ok' : 'warn';
  return `<span class="${tone}">${delta > 0 ? '▲' : '▼'}${Math.abs(delta)}</span>`;
}

export class EventLog {
  #container;

  /** @param {HTMLElement} container */
  constructor(container) {
    this.#container = container;
    container.innerHTML = `
      <h2>Events</h2>
      <p class="hint">census readings, every few ticks</p>
      <ul id="event-log-list"></ul>`;
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
      if (event.type !== 'census') continue;
      const previous = i > 0 && events[i - 1].type === 'census' ? events[i - 1] : null;
      const fishDelta = previous ? event.fish - previous.fish : 0;
      const sharkDelta = previous ? event.sharks - previous.sharks : 0;
      lines.push(
        `<li><span class="dim">t${event.tick}</span> fish ${event.fish} ${change(fishDelta)} · sharks ${event.sharks} ${change(sharkDelta)}</li>`,
      );
    }
    list.innerHTML = lines.join('');
  }
}
