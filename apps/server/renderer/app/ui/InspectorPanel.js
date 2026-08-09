/**
 * The cell inspector, docked in the sidebar: what is in the selected cell
 * (fish, shark, or open water) and what the inspection query knows about it
 * (energy, breed age). The bulk frame carries species alone, so the two
 * query-only fields arrive on a slow poll and are marked stale-safe by tick.
 */
import { EMPTY, FISH, SHARK, resolveAppearance } from '../rendering/CellAppearance.js';

export class InspectorPanel {
  #container;

  /** @param {HTMLElement} container */
  constructor(container) {
    this.#container = container;
    this.#renderEmpty();
  }

  #renderEmpty() {
    this.#container.innerHTML = `
      <h2>Inspector</h2>
      <p class="hint">click any cell to inspect it</p>`;
  }

  /**
   * @param {import('../state/RendererStore.js').RendererStore} store
   * @param {object | null} detail last cell.inspect result for this selection
   */
  render(store, detail) {
    const selection = store.selection;
    if (!selection) {
      this.#renderEmpty();
      return;
    }
    const species = store.speciesAtCell(selection.cellX, selection.cellY);
    const appearance = resolveAppearance(species);
    const glyph = `<span class="metrics-glyph" style="color: var(--dracula-${appearance.colorToken})">${appearance.glyph}</span>`;
    const rows = [
      `<div class="field"><span>cell</span><span>${selection.cellX},${selection.cellY}</span></div>`,
      `<div class="field"><span>contents</span><span>${glyph} ${appearance.label}</span></div>`,
    ];
    // Energy and breed age are query-only; show them when the poll has
    // answered for this cell, and only what applies to the occupant (a fish
    // has no energy budget, water has neither).
    const cell = detail?.cell;
    if (cell && cell.x === selection.cellX && cell.y === selection.cellY && species !== EMPTY) {
      if (species === SHARK) {
        rows.push(`<div class="field"><span>energy</span><span>${cell.energy}</span></div>`);
      }
      if (species === FISH || species === SHARK) {
        rows.push(`<div class="field"><span>breed age</span><span>${cell.breedAge}</span></div>`);
      }
      rows.push(`<div class="field"><span>as of tick</span><span class="dim">${detail.tick}</span></div>`);
    }
    this.#container.innerHTML = `<h2>Inspector</h2>${rows.join('')}
      <p class="hint">Esc clears the selection</p>`;
  }
}
