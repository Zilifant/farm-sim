/**
 * The key to the grid.
 *
 * **Generated from the appearance registry, never written out by hand.**
 * That is the whole design, inherited from the biome renderer:
 * `CellAppearance.js` is the single source of glyphs and colours, so a legend
 * that reads from it cannot drift from what is actually drawn, and reskinning
 * a species updates the legend for free.
 *
 * `describeLegend` is pure and returns plain data; only `LegendPanel` touches
 * the DOM.
 */
import { SPECIES_APPEARANCE, WATER_APPEARANCE, UNKNOWN_APPEARANCE } from '../rendering/CellAppearance.js';

/**
 * @typedef {object} LegendEntry
 * @property {string} glyph
 * @property {string} colorToken
 * @property {string} label
 */

/**
 * Every glyph the grid can draw, grouped for reading.
 * @returns {Array<{title: string, entries: LegendEntry[]}>}
 */
export function describeLegend() {
  const creatures = Object.values(SPECIES_APPEARANCE).map((appearance) => ({
    glyph: appearance.glyph,
    colorToken: appearance.colorToken,
    label: appearance.label,
  }));
  creatures.push({
    glyph: UNKNOWN_APPEARANCE.glyph,
    colorToken: UNKNOWN_APPEARANCE.colorToken,
    label: UNKNOWN_APPEARANCE.label,
  });

  const ocean = [
    { glyph: WATER_APPEARANCE.glyph, colorToken: WATER_APPEARANCE.colorToken, label: WATER_APPEARANCE.label },
  ];

  return [
    { title: 'Creatures', entries: creatures },
    { title: 'Ocean', entries: ocean },
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
      <details class="inspector-section legend-root" open>
        <summary><span class="section-title">Legend</span> <span class="section-badge">what the glyphs mean</span></summary>
        <div class="section-body">${groups}</div>
      </details>`;
  }
}
