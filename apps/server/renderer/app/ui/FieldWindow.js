/**
 * The floating field window — the game's primary interaction surface.
 * Clicking a field on the map opens this card next to it: the field's
 * condition, what is growing, and every action that applies *to this field*
 * (plant a crop, fertilize, irrigate, harvest, cancel its queued work, or
 * buy the parcel). Farm-wide concerns (selling, the bank, machinery) stay
 * in the sidebar.
 *
 * Same contract as every panel: the window portrays authoritative host
 * output and sends protocol commands — it never mutates state itself. It
 * floats over the viewport, drags by its header, clamps to the viewport,
 * and re-renders in place from each frame while open.
 */
import { CROP_APPEARANCE, resolveAppearance } from '../rendering/CellAppearance.js';
import { formatMoney } from './StatusPanel.js';

/** Operation kind codes, matching the sim's catalog. */
const OP_PLANT = 1;
const OP_FERTILIZE = 2;
const OP_IRRIGATE = 3;
const OP_HARVEST = 4;

/**
 * Clamp a desired window position so the whole box stays inside the bounds
 * (with a small margin). Pure — exported for the unit tests.
 * @param {{x: number, y: number}} anchor desired top-left
 * @param {{width: number, height: number}} size window size
 * @param {{width: number, height: number}} bounds viewport size
 * @returns {{x: number, y: number}}
 */
export function clampToBounds(anchor, size, bounds, margin = 8) {
  const x = Math.max(margin, Math.min(anchor.x, bounds.width - size.width - margin));
  const y = Math.max(margin, Math.min(anchor.y, bounds.height - size.height - margin));
  return { x, y };
}

/**
 * Which action groups a field offers, from its authoritative state. Pure —
 * exported for the unit tests.
 * @param {object | null} field a store field row
 * @returns {Array<'buy' | 'plant' | 'fertilize' | 'irrigate' | 'harvest'>}
 */
export function fieldActions(field) {
  if (!field) return [];
  if (!field.owned) return ['buy'];
  const actions = [];
  if (!field.crop) actions.push('plant');
  actions.push('fertilize', 'irrigate');
  if (field.crop) actions.push('harvest');
  return actions;
}

/** A 0..1 gauge as a fixed-width bar: ▰▰▰▱▱ 0.62 */
function gauge(value) {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * 5);
  return `${'▰'.repeat(filled)}${'▱'.repeat(5 - filled)} ${value.toFixed(2)}`;
}

export class FieldWindow {
  #el;
  #callbacks;
  /** @type {import('../state/RendererStore.js').RendererStore | null} */
  #store = null;
  /** @type {number | null} the field this window is showing */
  #fieldId = null;
  /** Set while the user drags the window by its header. */
  #drag = null;

  /**
   * @param {HTMLElement} container the absolutely-positioned window element,
   *        living inside the viewport wrapper
   * @param {object} callbacks
   * @param {(command: object) => Promise<object>} callbacks.onCommand
   * @param {(text: string, kind: 'ok' | 'warn' | 'bad') => void} callbacks.onStatus
   * @param {() => void} callbacks.onClose selection cleanup lives with the app
   */
  constructor(container, callbacks) {
    this.#el = container;
    this.#callbacks = callbacks;
    this.#el.hidden = true;

    this.#el.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('[data-close]')) {
        this.#callbacks.onClose();
        return;
      }
      const action = event.target.closest('[data-action]');
      if (action) this.#runAction(action.getAttribute('data-action'), action.getAttribute('data-arg'));
    });

    // Drag by the header. The window is position:absolute inside the
    // viewport wrapper, so pointer deltas map 1:1 onto left/top.
    this.#el.addEventListener('pointerdown', (event) => {
      if (!(event.target instanceof Element) || !event.target.closest('.field-window-header')) return;
      if (event.target.closest('button')) return;
      this.#drag = { startX: event.clientX, startY: event.clientY, left: this.#el.offsetLeft, top: this.#el.offsetTop };
      this.#el.setPointerCapture(event.pointerId);
    });
    this.#el.addEventListener('pointermove', (event) => {
      if (!this.#drag) return;
      const pos = clampToBounds(
        { x: this.#drag.left + event.clientX - this.#drag.startX, y: this.#drag.top + event.clientY - this.#drag.startY },
        { width: this.#el.offsetWidth, height: this.#el.offsetHeight },
        { width: this.#el.parentElement.clientWidth, height: this.#el.parentElement.clientHeight },
      );
      this.#el.style.left = `${pos.x}px`;
      this.#el.style.top = `${pos.y}px`;
    });
    const endDrag = (event) => {
      this.#drag = null;
      if (this.#el.hasPointerCapture?.(event.pointerId)) this.#el.releasePointerCapture(event.pointerId);
    };
    this.#el.addEventListener('pointerup', endDrag);
    this.#el.addEventListener('pointercancel', endDrag);
  }

  get isOpen() {
    return !this.#el.hidden;
  }

  get fieldId() {
    return this.#fieldId;
  }

  /**
   * Open (or re-target) the window for a field, near a viewport point.
   * @param {number} fieldId
   * @param {{x: number, y: number}} anchor viewport-relative pixels (the click)
   */
  openFor(fieldId, anchor) {
    this.#fieldId = fieldId;
    this.#el.hidden = false;
    if (this.#store) this.render(this.#store);
    // Place after rendering so the measured size is the real one; offset a
    // little so the clicked cell stays visible beside the window.
    const pos = clampToBounds(
      { x: anchor.x + 14, y: anchor.y + 14 },
      { width: this.#el.offsetWidth, height: this.#el.offsetHeight },
      { width: this.#el.parentElement.clientWidth, height: this.#el.parentElement.clientHeight },
    );
    this.#el.style.left = `${pos.x}px`;
    this.#el.style.top = `${pos.y}px`;
  }

  close() {
    this.#el.hidden = true;
    this.#fieldId = null;
  }

  async #runAction(action, arg) {
    const field = this.#fieldId;
    if (field === null) return;
    let command = null;
    switch (action) {
      case 'plant':
        command = { kind: 'farm.op.schedule', op: OP_PLANT, field, crop: Number(arg) };
        break;
      case 'fertilize':
        command = { kind: 'farm.op.schedule', op: OP_FERTILIZE, field, crop: 0 };
        break;
      case 'irrigate':
        command = { kind: 'farm.op.schedule', op: OP_IRRIGATE, field, crop: 0 };
        break;
      case 'harvest':
        command = { kind: 'farm.op.schedule', op: OP_HARVEST, field, crop: 0 };
        break;
      case 'buy':
        command = { kind: 'farm.field.buy', field };
        break;
      case 'cancel':
        command = { kind: 'farm.op.cancel', opSeq: Number(arg) };
        break;
      default:
        return;
    }
    const result = await this.#callbacks.onCommand({ type: 'farm.command', command });
    if (result?.ok) {
      this.#callbacks.onStatus(`${command.kind} ok`, 'ok');
    } else {
      this.#callbacks.onStatus(`${command.kind} failed: ${result?.error?.message ?? 'unknown error'}`, 'bad');
    }
  }

  /**
   * Refresh from the store; called on every store change like any panel.
   * @param {import('../state/RendererStore.js').RendererStore} store
   */
  render(store) {
    this.#store = store;
    if (this.#el.hidden || this.#fieldId === null) return;
    const field = store.fields[this.#fieldId];
    if (!field) {
      // A restart replaced the world under the window.
      this.#callbacks.onClose();
      return;
    }

    const rows = [];
    if (!field.owned) {
      rows.push(`<div class="field"><span>status</span><span class="warn">for sale</span></div>`);
      rows.push(`<div class="field"><span>price</span><span>${formatMoney(field.price)}</span></div>`);
      rows.push(`<div class="field"><span>soil quality</span><span>${gauge(Math.min(1, field.soilQuality))}</span></div>`);
    } else {
      if (field.crop) {
        const crop = Object.values(CROP_APPEARANCE).find((c) => c.key === field.crop);
        const glyph = crop
          ? `<span class="metrics-glyph" style="color: var(--dracula-${crop.colorToken})">${crop.letter.toUpperCase()}</span> `
          : '';
        rows.push(`<div class="field"><span>crop</span><span>${glyph}${field.crop} (${field.stage})</span></div>`);
        rows.push(`<div class="field"><span>progress</span><span>${gauge(Math.min(1, field.progress))}</span></div>`);
        rows.push(`<div class="field"><span>expected</span><span>${field.expectedYield > 0 ? `${field.expectedYield.toFixed(1)}/ac` : '<span class="dim">–</span>'}</span></div>`);
      } else {
        rows.push(`<div class="field"><span>crop</span><span class="dim">none — ready to plant</span></div>`);
      }
      rows.push(`<div class="field"><span>soil quality</span><span>${gauge(Math.min(1, field.soilQuality))}</span></div>`);
      rows.push(`<div class="field"><span>moisture</span><span>${gauge(field.moisture)}</span></div>`);
      rows.push(`<div class="field"><span>fertility</span><span>${gauge(field.fertility)}</span></div>`);
      rows.push(`<div class="field"><span>prev crop</span><span>${field.prevCrop ?? '<span class="dim">–</span>'}</span></div>`);
      if (field.lastYield > 0) {
        rows.push(`<div class="field"><span>last yield</span><span>${field.lastYield.toFixed(1)}/ac</span></div>`);
      }
    }

    // This field's place in the work queue, cancellable from here.
    const fieldOps = store.ops.filter((op) => op.field === this.#fieldId);
    const opsRows = fieldOps
      .map((op) => {
        const badge = op.status === 'active' ? '<span class="ok">▶</span>' : '<span class="dim">…</span>';
        const progress = `${Math.round(op.acresDone)}/${Math.round(op.acresTotal)} ac`;
        return `<li>${badge} ${op.kind}${op.crop ? ` ${op.crop}` : ''} <span class="dim">${progress}</span> <button type="button" data-action="cancel" data-arg="${op.seq}" title="Cancel">×</button></li>`;
      })
      .join('');

    const actions = fieldActions(field);
    const buttons = [];
    if (actions.includes('buy')) {
      buttons.push(`<button type="button" data-action="buy" class="field-window-wide">Buy for ${formatMoney(field.price)}</button>`);
    }
    if (actions.includes('plant')) {
      const marketPrice = (key) => {
        const market = store.markets.find((m) => m.key === key);
        return market ? `$${market.price.toFixed(2)}/${market.unit}` : '';
      };
      const cropButtons = Object.entries(CROP_APPEARANCE)
        .map(
          ([code, crop]) => `
          <button type="button" data-action="plant" data-arg="${code}" title="${crop.label} · ${marketPrice(crop.key)}">
            <span style="color: var(--dracula-${crop.colorToken})">${crop.letter.toUpperCase()}</span> ${crop.key}
          </button>`,
        )
        .join('');
      buttons.push(`<div class="field-window-plant"><span class="dim">plant</span>${cropButtons}</div>`);
    }
    const simple = [];
    if (actions.includes('fertilize')) simple.push(`<button type="button" data-action="fertilize">Fertilize</button>`);
    if (actions.includes('irrigate')) simple.push(`<button type="button" data-action="irrigate">Irrigate</button>`);
    if (actions.includes('harvest')) simple.push(`<button type="button" data-action="harvest">Harvest</button>`);
    if (simple.length > 0) {
      buttons.push(`<div class="control-row">${simple.join('')}</div>`);
    }

    const cell = store.selection;
    const terrainGlyph = cell ? resolveAppearance(store.cellAtXY(cell.cellX, cell.cellY)) : null;
    const headGlyph = terrainGlyph
      ? `<span class="metrics-glyph" style="color: var(--dracula-${terrainGlyph.colorToken})">${terrainGlyph.glyph}</span> `
      : '';
    this.#el.innerHTML = `
      <div class="field-window-header">
        <span>${headGlyph}${field.name} · ${Math.round(field.acres)} ac</span>
        <button type="button" data-close title="Close (Esc)">×</button>
      </div>
      <div class="field-window-body">
        ${rows.join('')}
        ${fieldOps.length > 0 ? `<ul class="farm-list">${opsRows}</ul>` : ''}
        ${buttons.join('')}
      </div>`;
  }
}
