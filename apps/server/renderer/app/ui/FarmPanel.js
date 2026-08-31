/**
 * The farm office: the *farm-wide* concerns — the work queue's overview,
 * selling from storage, the bank and the crew, and machinery upgrades.
 * Everything per-field (planting, irrigating, harvesting, buying parcels)
 * lives in the floating field window, opened by clicking a field on the map.
 *
 * This panel never mutates anything directly; every action goes out as a
 * `farm.command` envelope on the transport, and everything it displays is
 * authoritative host output. The command vocabulary restates `@sim/farm`'s
 * protocol constants — the renderer imports nothing from any package.
 */
import { formatMoney } from './StatusPanel.js';

export class FarmPanel {
  #els;
  #onCommand;
  /** Signature of the last-rendered sell options, to keep focus stable. */
  #sellSignature = '';
  /** @type {import('../state/RendererStore.js').RendererStore | null} */
  #store = null;

  /**
   * @param {HTMLElement} container
   * @param {object} callbacks
   * @param {(command: object) => Promise<object>} callbacks.onCommand
   * @param {(text: string, kind: 'ok' | 'warn' | 'bad') => void} callbacks.onStatus
   * @param {() => void} callbacks.onPlaceField enter field-placement mode
   * @param {() => void} callbacks.onBuildRoad enter road-building mode
   */
  constructor(container, callbacks) {
    this.#onCommand = callbacks;
    container.innerHTML = `
      <h2>Farm Office</h2>
      <details class="inspector-section" open>
        <summary><span class="section-title">Work queue</span> <span class="section-badge" id="farm-queue-badge"></span></summary>
        <div class="section-body">
          <div class="control-row">
            <button type="button" id="farm-place-field">＋ Field (F)</button>
            <button type="button" id="farm-build-road">＋ Dirt road (R)</button>
          </div>
          <ul id="farm-ops-list" class="farm-list"></ul>
          <p class="hint">click a field on the map to work it; ops wait for their window, weather, and machine capacity, in queue order</p>
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
        <summary><span class="section-title">Machinery</span> <span class="section-badge">upgrades</span></summary>
        <div class="section-body">
          <ul id="farm-expand-list" class="farm-list"></ul>
          <p class="hint">land is bought on the map — click ground marked $ for sale</p>
        </div>
      </details>`;

    this.#els = {
      opsList: container.querySelector('#farm-ops-list'),
      queueBadge: container.querySelector('#farm-queue-badge'),
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

    container.querySelector('#farm-place-field').addEventListener('click', () => callbacks.onPlaceField());
    container.querySelector('#farm-build-road').addEventListener('click', () => callbacks.onBuildRoad());
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
      const cat = event.target.getAttribute('data-buy-equip');
      if (cat !== null) this.#send({ kind: 'farm.equip.buy', category: Number(cat) });
    });
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
   * Refresh from the store. The sell select is rebuilt only when the set of
   * stocked crops actually changes, so an open dropdown or focused input
   * survives the once-a-day frames.
   * @param {import('../state/RendererStore.js').RendererStore} store
   */
  render(store) {
    this.#store = store;
    if (!store.finance) return;

    // --- sell select (guarded by signature)
    const stocked = store.markets.filter((m) => m.stored > 0.5);
    const signature = stocked.map((m) => m.key).join(',');
    if (signature !== this.#sellSignature) {
      this.#sellSignature = signature;
      const keepSell = this.#els.sellCrop.value;
      this.#els.sellCrop.innerHTML =
        stocked.length === 0
          ? '<option value="">— storage is empty —</option>'
          : stocked
              .map((m) => `<option value="${store.markets.indexOf(m) + 1}">${m.name}</option>`)
              .join('');
      if (stocked.some((m) => String(store.markets.indexOf(m) + 1) === keepSell)) this.#els.sellCrop.value = keepSell;
    }

    // --- work queue overview
    this.#els.queueBadge.textContent = store.ops.length === 0 ? 'idle' : `${store.ops.length} scheduled`;
    this.#els.opsList.innerHTML = store.ops
      .map((op) => {
        const progress = op.acresTotal > 0 ? `${Math.round(op.acresDone)}/${Math.round(op.acresTotal)} ac` : '';
        const unreachable = store.fieldById(op.field)?.reachable === false;
        const badge = unreachable
          ? '<span class="bad" title="No road to this field">⚠</span>'
          : op.status === 'active' ? '<span class="ok">▶</span>' : '<span class="dim">…</span>';
        return `<li>${badge} ${op.kind} ${op.fieldName}${op.crop ? ` · ${op.crop}` : ''} <span class="dim">${progress}</span> <button type="button" data-cancel="${op.seq}" title="Cancel">×</button></li>`;
      })
      .join('') || '<li class="dim">queue is empty</li>';

    // --- storage + bank badges
    const used = Math.round(store.finance.storageUsed);
    this.#els.storageBadge.textContent = `${used.toLocaleString('en-US')} / ${store.finance.storageCapacity.toLocaleString('en-US')} units stored`;
    this.#els.bankBadge.textContent = `debt ${formatMoney(store.finance.debt)} · limit ${formatMoney(store.finance.borrowLimit)}`;
    this.#els.crew.textContent = `${store.finance.workers} worker${store.finance.workers === 1 ? '' : 's'}`;
    this.#els.netWorth.textContent = `net worth ${formatMoney(store.finance.netWorth)}`;

    // --- machinery upgrades
    this.#els.expandList.innerHTML =
      store.equipment
        .filter((e) => e.nextCost !== null)
        .map(
          (e) =>
            `<li>⚙ ${e.name} L${e.level} <span class="dim">${e.capacity}→${e.nextCapacity} ac/day · ${formatMoney(e.nextCost)}</span> <button type="button" data-buy-equip="${e.cat}">Upgrade</button></li>`,
        )
        .join('') || '<li class="dim">everything is top of the line</li>';
  }
}
