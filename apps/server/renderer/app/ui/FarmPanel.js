/**
 * The farm office: everything the player does to the farm, as protocol
 * commands — schedule and cancel operations, sell from storage, borrow and
 * repay, buy parcels and equipment, size the crew. This panel never mutates
 * anything directly; every action goes out as a `farm.command` envelope on
 * the transport, and everything it displays is authoritative host output.
 *
 * The command vocabulary restates `@sim/farm`'s protocol constants — the
 * renderer imports nothing from any package.
 */
import { CROP_APPEARANCE } from '../rendering/CellAppearance.js';
import { formatMoney } from './StatusPanel.js';

/** Operation kind codes, matching the sim's catalog. */
const OPS = Object.freeze([
  { code: 1, key: 'plant', label: 'Plant' },
  { code: 2, key: 'fertilize', label: 'Fertilize' },
  { code: 3, key: 'irrigate', label: 'Irrigate' },
  { code: 4, key: 'harvest', label: 'Harvest' },
]);

export class FarmPanel {
  #els;
  #onCommand;
  /** Signature of the last-rendered select options, to keep focus stable. */
  #fieldSignature = '';
  /** @type {import('../state/RendererStore.js').RendererStore | null} */
  #store = null;

  /**
   * @param {HTMLElement} container
   * @param {object} callbacks
   * @param {(command: object) => Promise<object>} callbacks.onCommand
   * @param {(text: string, kind: 'ok' | 'warn' | 'bad') => void} callbacks.onStatus
   */
  constructor(container, callbacks) {
    this.#onCommand = callbacks;
    container.innerHTML = `
      <h2>Farm Office</h2>
      <details class="inspector-section" open>
        <summary><span class="section-title">Operations</span> <span class="section-badge">work queue</span></summary>
        <div class="section-body">
          <div class="control-row">
            <select id="farm-op" aria-label="Operation">${OPS.map((op) => `<option value="${op.code}">${op.label}</option>`).join('')}</select>
            <select id="farm-field" aria-label="Field"></select>
            <select id="farm-crop" aria-label="Crop">${Object.entries(CROP_APPEARANCE)
              .map(([code, crop]) => `<option value="${code}">${crop.label}</option>`)
              .join('')}</select>
            <button type="button" id="farm-queue">Queue</button>
          </div>
          <ul id="farm-ops-list" class="farm-list"></ul>
          <p class="hint">ops wait for their window, weather, and machine capacity, in queue order</p>
        </div>
      </details>
      <details class="inspector-section" open>
        <summary><span class="section-title">Sell</span> <span class="section-badge" id="farm-storage-badge">storage</span></summary>
        <div class="section-body">
          <div class="control-row">
            <select id="farm-sell-crop" aria-label="Crop to sell"></select>
            <input type="number" id="farm-sell-units" min="1" step="1" value="1000" aria-label="Units to sell" />
            <button type="button" id="farm-sell">Sell</button>
            <button type="button" id="farm-sell-all">All</button>
          </div>
        </div>
      </details>
      <details class="inspector-section">
        <summary><span class="section-title">Bank</span> <span class="section-badge" id="farm-bank-badge"></span></summary>
        <div class="section-body">
          <div class="control-row">
            <input type="number" id="farm-loan-amount" min="1" step="1000" value="50000" aria-label="Loan amount" />
            <button type="button" id="farm-borrow">Borrow</button>
            <button type="button" id="farm-repay">Repay</button>
          </div>
          <div class="control-row">
            <span class="dim">crew</span>
            <button type="button" id="farm-crew-down">−</button>
            <span id="farm-crew" aria-live="polite">–</span>
            <button type="button" id="farm-crew-up">+</button>
            <span class="dim" id="farm-net-worth"></span>
          </div>
          <p class="hint">interest accrues daily; wages are paid per worker per day, all year</p>
        </div>
      </details>
      <details class="inspector-section">
        <summary><span class="section-title">Expand</span> <span class="section-badge">land &amp; machines</span></summary>
        <div class="section-body">
          <ul id="farm-expand-list" class="farm-list"></ul>
        </div>
      </details>`;

    this.#els = {
      op: container.querySelector('#farm-op'),
      field: container.querySelector('#farm-field'),
      crop: container.querySelector('#farm-crop'),
      queue: container.querySelector('#farm-queue'),
      opsList: container.querySelector('#farm-ops-list'),
      sellCrop: container.querySelector('#farm-sell-crop'),
      sellUnits: container.querySelector('#farm-sell-units'),
      sell: container.querySelector('#farm-sell'),
      sellAll: container.querySelector('#farm-sell-all'),
      storageBadge: container.querySelector('#farm-storage-badge'),
      loanAmount: container.querySelector('#farm-loan-amount'),
      borrow: container.querySelector('#farm-borrow'),
      repay: container.querySelector('#farm-repay'),
      bankBadge: container.querySelector('#farm-bank-badge'),
      crewDown: container.querySelector('#farm-crew-down'),
      crewUp: container.querySelector('#farm-crew-up'),
      crew: container.querySelector('#farm-crew'),
      netWorth: container.querySelector('#farm-net-worth'),
      expandList: container.querySelector('#farm-expand-list'),
    };

    this.#els.op.addEventListener('change', () => this.#syncCropVisibility());
    this.#els.queue.addEventListener('click', () => this.#queueOp());
    this.#els.opsList.addEventListener('click', (event) => {
      const seq = event.target instanceof Element ? event.target.getAttribute('data-cancel') : null;
      if (seq !== null) this.#send({ kind: 'farm.op.cancel', opSeq: Number(seq) });
    });
    this.#els.sell.addEventListener('click', () => this.#sell(false));
    this.#els.sellAll.addEventListener('click', () => this.#sell(true));
    this.#els.borrow.addEventListener('click', () => this.#loan('farm.borrow'));
    this.#els.repay.addEventListener('click', () => this.#loan('farm.repay'));
    this.#els.crewDown.addEventListener('click', () => this.#crew(-1));
    this.#els.crewUp.addEventListener('click', () => this.#crew(1));
    this.#els.expandList.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) return;
      const field = event.target.getAttribute('data-buy-field');
      if (field !== null) this.#send({ kind: 'farm.field.buy', field: Number(field) });
      const cat = event.target.getAttribute('data-buy-equip');
      if (cat !== null) this.#send({ kind: 'farm.equip.buy', category: Number(cat) });
    });
    this.#syncCropVisibility();
  }

  async #send(command) {
    const result = await this.#onCommand.onCommand({ type: 'farm.command', command });
    if (result?.ok) {
      this.#onCommand.onStatus(`${command.kind} ok`, 'ok');
    } else {
      this.#onCommand.onStatus(`${command.kind} failed: ${result?.error?.message ?? 'unknown error'}`, 'bad');
    }
    return result;
  }

  #syncCropVisibility() {
    // The crop picker only means something for planting.
    this.#els.crop.style.display = Number(this.#els.op.value) === 1 ? '' : 'none';
  }

  #queueOp() {
    const op = Number(this.#els.op.value);
    const field = Number(this.#els.field.value);
    if (!Number.isInteger(field)) {
      this.#onCommand.onStatus('pick a field first', 'bad');
      return;
    }
    const crop = op === 1 ? Number(this.#els.crop.value) : 0;
    this.#send({ kind: 'farm.op.schedule', op, field, crop });
  }

  #sell(all) {
    const crop = Number(this.#els.sellCrop.value);
    if (!Number.isInteger(crop) || crop < 1) {
      this.#onCommand.onStatus('nothing in storage to sell', 'bad');
      return;
    }
    let units = Math.floor(Number(this.#els.sellUnits.value));
    if (all) {
      const market = this.#store?.markets[crop - 1];
      units = Math.floor(market?.stored ?? 0);
    }
    if (!Number.isFinite(units) || units < 1) {
      this.#onCommand.onStatus('units must be a positive whole number', 'bad');
      return;
    }
    this.#send({ kind: 'farm.sell', crop, units });
  }

  #loan(kind) {
    const amount = Math.floor(Number(this.#els.loanAmount.value));
    if (!Number.isFinite(amount) || amount < 1) {
      this.#onCommand.onStatus('amount must be a positive whole number', 'bad');
      return;
    }
    this.#send({ kind, amount });
  }

  #crew(delta) {
    const current = this.#store?.finance?.workers;
    if (typeof current !== 'number') return;
    this.#send({ kind: 'farm.labor.set', workers: current + delta });
  }

  /**
   * Refresh from the store. Select options are rebuilt only when the set of
   * choices actually changes, so an open dropdown or focused input survives
   * the once-a-day frames.
   * @param {import('../state/RendererStore.js').RendererStore} store
   */
  render(store) {
    this.#store = store;
    if (!store.finance) return;

    // --- selects (guarded by signature)
    const owned = store.fields.filter((f) => f.owned);
    const stocked = store.markets.filter((m) => m.stored > 0.5);
    const signature = `${owned.map((f) => f.id).join(',')}|${stocked.map((m) => m.key).join(',')}`;
    if (signature !== this.#fieldSignature) {
      this.#fieldSignature = signature;
      const keepField = this.#els.field.value;
      this.#els.field.innerHTML = owned
        .map((f) => `<option value="${f.id}">${f.name} (${Math.round(f.acres)} ac)</option>`)
        .join('');
      if (owned.some((f) => String(f.id) === keepField)) this.#els.field.value = keepField;
      const keepSell = this.#els.sellCrop.value;
      this.#els.sellCrop.innerHTML =
        stocked.length === 0
          ? '<option value="">— storage is empty —</option>'
          : stocked
              .map((m) => `<option value="${store.markets.indexOf(m) + 1}">${m.name}</option>`)
              .join('');
      if (stocked.some((m) => String(store.markets.indexOf(m) + 1) === keepSell)) this.#els.sellCrop.value = keepSell;
    }

    // --- ops queue
    this.#els.opsList.innerHTML = store.ops
      .map((op) => {
        const progress = op.acresTotal > 0 ? `${Math.round(op.acresDone)}/${Math.round(op.acresTotal)} ac` : '';
        const badge = op.status === 'active' ? '<span class="ok">▶</span>' : '<span class="dim">…</span>';
        return `<li>${badge} ${op.kind} ${op.fieldName}${op.crop ? ` · ${op.crop}` : ''} <span class="dim">${progress}</span> <button type="button" data-cancel="${op.seq}" title="Cancel">×</button></li>`;
      })
      .join('') || '<li class="dim">queue is empty</li>';

    // --- storage + bank badges
    const used = Math.round(store.finance.storageUsed);
    this.#els.storageBadge.textContent = `${used.toLocaleString('en-US')} / ${store.finance.storageCapacity.toLocaleString('en-US')} units stored`;
    this.#els.bankBadge.textContent = `debt ${formatMoney(store.finance.debt)} · limit ${formatMoney(store.finance.borrowLimit)}`;
    this.#els.crew.textContent = `${store.finance.workers} worker${store.finance.workers === 1 ? '' : 's'}`;
    this.#els.netWorth.textContent = `net worth ${formatMoney(store.finance.netWorth)}`;

    // --- expansion list: parcels for sale, then equipment upgrades
    const parcels = store.fields
      .filter((f) => !f.owned)
      .map(
        (f) =>
          `<li>$ ${f.name} · ${Math.round(f.acres)} ac <span class="dim">${formatMoney(f.price)}</span> <button type="button" data-buy-field="${f.id}">Buy</button></li>`,
      );
    const upgrades = store.equipment
      .filter((e) => e.nextCost !== null)
      .map(
        (e) =>
          `<li>⚙ ${e.name} L${e.level} <span class="dim">${e.capacity}→${e.nextCapacity} ac/day · ${formatMoney(e.nextCost)}</span> <button type="button" data-buy-equip="${e.cat}">Upgrade</button></li>`,
      );
    this.#els.expandList.innerHTML =
      [...parcels, ...upgrades].join('') || '<li class="dim">nothing left to buy</li>';
  }
}
