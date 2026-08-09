/**
 * Population metrics panel: one line per species — its grid glyph, its name,
 * how many are alive — with the population trend beneath it as a sparkline.
 *
 * Presentation only: counts arrive on every frame from the host, and the
 * history is the renderer's own bounded record of them. The sparkline
 * conventions are the biome renderer's: drawn from `TREND_LEVELS` (a ramp
 * with no blank rung — every column of a trend has a sample, so a flat series
 * reads as `▁▁▁▁` rather than as no population), and **downsampled by bucket
 * mean, not truncated to the last N** — the point of the row is the shape of
 * the whole history.
 */
import { SPECIES_APPEARANCE, FISH, SHARK } from '../rendering/CellAppearance.js';

/** The rungs a sparkline may use, lightest to fullest — no blank (see above). */
export const TREND_LEVELS = Object.freeze(['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']);

/**
 * Resample a series to at most `width` samples by bucket mean.
 * @param {number[]} series @param {number} width
 * @returns {number[]}
 */
export function resample(series, width) {
  if (series.length <= width) return series;
  const buckets = [];
  for (let i = 0; i < width; i += 1) {
    const start = Math.floor((i * series.length) / width);
    const end = Math.max(start + 1, Math.floor(((i + 1) * series.length) / width));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += series[j];
    buckets.push(sum / (end - start));
  }
  return buckets;
}

/**
 * A sparkline scaled min→max onto the trend ramp. A flat series (min === max)
 * draws its floor, which reads as "no change".
 * @param {number[]} series @param {number} width
 * @returns {string}
 */
export function sparkline(series, width) {
  const samples = resample(series, width);
  if (samples.length === 0) return '';
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const range = max - min;
  return samples
    .map((value) => {
      const level = range === 0 ? 0 : Math.round(((value - min) / range) * (TREND_LEVELS.length - 1));
      return TREND_LEVELS[level];
    })
    .join('');
}

/** Horizontal space a sparkline cannot use: the panel's own padding. */
const PANEL_PADDING_PX = 20;

export class MetricsPanel {
  #container;
  #charWidth = 0;

  /** @param {HTMLElement} container */
  constructor(container) {
    this.#container = container;
    container.innerHTML = '<h2>Population</h2><p class="hint">waiting for the host…</p>';
  }

  /** How many sparkline characters fit across this panel right now. */
  #columns() {
    if (this.#charWidth === 0) {
      // Measure the block glyph, not a digit: a sparkline is drawn in `▁▂▃`,
      // and a font may give blocks a different advance than latin glyphs.
      const probe = document.createElement('span');
      probe.textContent = TREND_LEVELS[0].repeat(20);
      probe.style.visibility = 'hidden';
      probe.style.whiteSpace = 'pre';
      this.#container.appendChild(probe);
      this.#charWidth = probe.getBoundingClientRect().width / 20 || 7;
      probe.remove();
    }
    const available = this.#container.clientWidth - PANEL_PADDING_PX;
    return Math.max(10, Math.floor(available / this.#charWidth));
  }

  /** @param {import('../state/RendererStore.js').RendererStore} store */
  render(store) {
    if (store.history.length === 0) return;
    const columns = this.#columns();
    const rows = [
      { code: FISH, series: store.history.map((sample) => sample.fish), count: store.populations.fish },
      { code: SHARK, series: store.history.map((sample) => sample.sharks), count: store.populations.sharks },
    ]
      .map(({ code, series, count }) => {
        const appearance = SPECIES_APPEARANCE[code];
        return `
        <div class="field">
          <span><span class="metrics-glyph" style="color: var(--dracula-${appearance.colorToken})">${appearance.glyph}</span> ${appearance.label}</span>
          <span>${count} alive</span>
        </div>
        <span class="metrics-trend" style="color: var(--dracula-${appearance.colorToken})">${sparkline(series, columns)}</span>`;
      })
      .join('');
    this.#container.innerHTML = `<h2>Population</h2>${rows}
      <p class="hint">trend spans the last ${store.history.length} frames</p>`;
  }
}
