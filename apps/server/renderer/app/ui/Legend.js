/**
 * The key to the grid.
 *
 * **Generated from the appearance registry, never written out by hand.**
 * That is the whole design, inherited from the biome renderer:
 * `CellAppearance.js` is the single source of glyphs and colours, so a legend
 * that reads from it cannot drift from what is actually drawn, and reskinning
 * a crop updates the legend for free.
 *
 * `describeLegend` is pure and returns plain data; only `LegendPanel` touches
 * the DOM.
 */
import {
  BUCKETS_PER_CROP,
  BUCKET_GROWING,
  BUCKET_MATURE,
  CROP_APPEARANCE,
  CROP_CODE_BASE,
  TERRAIN_APPEARANCE,
  UNKNOWN_APPEARANCE,
  resolveAppearance,
} from '../rendering/CellAppearance.js';

/**
 * @typedef {object} LegendEntry
 * @property {string} glyph
 * @property {string} colorToken
 * @property {string} label
 */

/**
 * Every glyph the grid can draw, grouped for reading. Crops show their
 * growing and mature forms; the dot/sprout stages are shared shapes and get
 * one generic row rather than six identical ones.
 * @returns {Array<{title: string, entries: LegendEntry[]}>}
 */
export function describeLegend() {
  const crops = Object.keys(CROP_APPEARANCE).flatMap((codeKey) => {
    const cropCode = Number(codeKey);
    const growing = resolveAppearance(CROP_CODE_BASE + (cropCode - 1) * BUCKETS_PER_CROP + BUCKET_GROWING);
    const mature = resolveAppearance(CROP_CODE_BASE + (cropCode - 1) * BUCKETS_PER_CROP + BUCKET_MATURE);
    return [growing, mature].map((a) => ({ glyph: a.glyph, colorToken: a.colorToken, label: a.label }));
  });
  crops.push({ glyph: '. ,', colorToken: 'foreground', label: 'planted / germinating (any crop)' });
  crops.push({
    glyph: UNKNOWN_APPEARANCE.glyph,
    colorToken: UNKNOWN_APPEARANCE.colorToken,
    label: UNKNOWN_APPEARANCE.label,
  });

  const terrain = Object.values(TERRAIN_APPEARANCE).map((a) => ({
    glyph: a.glyph,
    colorToken: a.colorToken,
    label: a.label,
  }));

  return [
    { title: 'Crops', entries: crops },
    { title: 'Land', entries: terrain },
    { title: 'Overlays', entries: OVERLAY_ENTRIES },
  ];
}

/**
 * Marks that are brackets or fills rather than glyphs, so there is no
 * registry to read them from. `[]` stands in for the corner brackets.
 * @type {LegendEntry[]}
 */
const OVERLAY_ENTRIES = Object.freeze([
  { glyph: '[]', colorToken: 'bright-yellow', label: 'selected / hovered cell' },
  { glyph: '▒', colorToken: 'foreground', label: "hovered cell's whole field" },
  { glyph: '▢', colorToken: 'green', label: 'new field being placed (red = blocked)' },
]);

export class LegendPanel {
  /** @param {HTMLElement} container */
  constructor(container) {
    const groups = describeLegend()
      .map(
        (group) => `
        <h3>${group.title}</h3>
        <div class="legend-grid">
          ${group.entries
            .map(
              (entry) => `
            <span class="legend-glyph" style="color: var(--dracula-${entry.colorToken})">${entry.glyph}</span>
            <span class="legend-label">${entry.label}</span>`,
            )
            .join('')}
        </div>`,
      )
      .join('');
    container.innerHTML = `
      <details class="inspector-section legend-root">
        <summary><span class="section-title">Legend</span> <span class="section-badge">what the glyphs mean</span></summary>
        <div class="section-body">${groups}</div>
      </details>`;
  }
}
