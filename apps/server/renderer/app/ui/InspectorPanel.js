/**
 * The cell inspector, docked in the sidebar: what is under the selected cell.
 * For a field cell the frame already carries the whole field's state, so the
 * panel renders live from the store; the `cell.inspect` query confirms the
 * cell → field mapping and covers non-field terrain.
 */
import { resolveAppearance } from '../rendering/CellAppearance.js';
import { formatMoney } from './StatusPanel.js';

/** A 0..1 gauge as a fixed-width bar: ▰▰▰▱▱ 0.62 */
function gauge(value) {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * 5);
  return `${'▰'.repeat(filled)}${'▱'.repeat(5 - filled)} ${value.toFixed(2)}`;
}

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
      <p class="hint">click any cell to inspect its field</p>`;
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
    const code = store.cellAtXY(selection.cellX, selection.cellY);
    const appearance = resolveAppearance(code);
    const glyph = `<span class="metrics-glyph" style="color: var(--dracula-${appearance.colorToken})">${appearance.glyph}</span>`;
    const rows = [
      `<div class="field"><span>cell</span><span>${selection.cellX},${selection.cellY}</span></div>`,
      `<div class="field"><span>terrain</span><span>${glyph} ${appearance.label}</span></div>`,
    ];

    // The authoritative field state rides every frame; the store's field-id
    // map says which field the selection sits in.
    const fieldId = store.fieldIdAtXY(selection.cellX, selection.cellY);
    const field = fieldId !== null ? store.fields[fieldId] : null;
    if (field) {
      rows.push(`<div class="field"><span>field</span><span>${field.name} · ${Math.round(field.acres)} ac</span></div>`);
      if (!field.owned) {
        rows.push(`<div class="field"><span>status</span><span class="warn">for sale — ${formatMoney(field.price)}</span></div>`);
      } else {
        rows.push(`<div class="field"><span>crop</span><span>${field.crop ?? '<span class="dim">none</span>'}${field.crop ? ` (${field.stage})` : ''}</span></div>`);
        if (field.crop) {
          rows.push(`<div class="field"><span>progress</span><span>${gauge(Math.min(1, field.progress))}</span></div>`);
          rows.push(`<div class="field"><span>expected</span><span>${field.expectedYield > 0 ? `${field.expectedYield.toFixed(1)}/ac` : '<span class="dim">–</span>'}</span></div>`);
        }
        rows.push(`<div class="field"><span>soil quality</span><span>${gauge(Math.min(1, field.soilQuality))}</span></div>`);
        rows.push(`<div class="field"><span>moisture</span><span>${gauge(field.moisture)}</span></div>`);
        rows.push(`<div class="field"><span>fertility</span><span>${gauge(field.fertility)}</span></div>`);
        rows.push(`<div class="field"><span>prev crop</span><span>${field.prevCrop ?? '<span class="dim">–</span>'}</span></div>`);
        if (field.lastYield > 0) {
          rows.push(`<div class="field"><span>last yield</span><span>${field.lastYield.toFixed(1)}/ac</span></div>`);
        }
      }
    } else if (detail?.cell && detail.cell.x === selection.cellX && detail.cell.y === selection.cellY) {
      rows.push(`<div class="field"><span>as of day</span><span class="dim">${detail.tick}</span></div>`);
    }
    this.#container.innerHTML = `<h2>Inspector</h2>${rows.join('')}
      <p class="hint">Esc clears the selection</p>`;
  }
}
