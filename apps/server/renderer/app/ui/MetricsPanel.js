/**
 * Markets panel: one row per crop — its grid glyph, its name, the current
 * price and what is sitting in storage — with the price trend beneath it as
 * a sparkline, and a cash row at the foot in the same idiom.
 *
 * Presentation only: prices arrive on every frame from the host, and the
 * history is the renderer's own bounded record of them. The sparkline
 * conventions are the biome renderer's: drawn from `TREND_LEVELS` (a ramp
 * with no blank rung — every column of a trend has a sample, so a flat series
 * reads as `▁▁▁▁` rather than as no market), and **downsampled by bucket
 * mean, not truncated to the last N** — the point of the row is the shape of
 * the whole history.
 */
import { cropAppearanceByKey } from '../rendering/CellAppearance.js';
import { formatMoney } from './StatusPanel.js';

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
    container.innerHTML = '<h2>Markets</h2><p class="hint">waiting for the host…</p>';
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
    if (store.history.length === 0 || store.markets.length === 0) return;
    const columns = this.#columns();
    const rows = store.markets
      .map((market) => {
        const appearance = cropAppearanceByKey(market.key);
        const series = store.history.map((sample) => sample.prices[market.key] ?? market.price);
        const vsBase = market.price / market.basePrice - 1;
        const tone = vsBase > 0.03 ? 'ok' : vsBase < -0.03 ? 'warn' : 'dim';
        const stored = market.stored > 0.5 ? ` · ${Math.round(market.stored).toLocaleString('en-US')} ${market.unit} stored` : '';
        return `
        <div class="field">
          <span><span class="metrics-glyph" style="color: var(--dracula-${appearance.colorToken})">${appearance.glyph}</span> ${market.name}</span>
          <span>$${market.price.toFixed(2)}/${market.unit} <span class="${tone}">${vsBase >= 0 ? '▲' : '▼'}${Math.abs(vsBase * 100).toFixed(0)}%</span></span>
        </div>
        ${stored ? `<div class="field"><span class="dim">${stored.slice(3)}</span><span></span></div>` : ''}
        <span class="metrics-trend" style="color: var(--dracula-${appearance.colorToken})">${sparkline(series, columns)}</span>`;
      })
      .join('');
    const cashSeries = store.history.map((sample) => sample.cash);
    const cashRow = `
      <div class="field">
        <span><span class="metrics-glyph" style="color: var(--dracula-green)">$</span> cash</span>
        <span>${store.finance ? formatMoney(store.finance.cash) : '–'}</span>
      </div>
      <span class="metrics-trend" style="color: var(--dracula-green)">${sparkline(cashSeries, columns)}</span>`;
    this.#container.innerHTML = `<h2>Markets</h2>${rows}${cashRow}
      <p class="hint">price change is vs. the long-term average · trend spans the last ${store.history.length} days</p>`;
  }
}
