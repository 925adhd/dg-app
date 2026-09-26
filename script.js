(() => {
  'use strict';

  // ---------- Theme toggle ----------
  const THEME_KEY = 'therealtotal:theme';
  const SUN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><line x1="12" y1="2" x2="12" y2="4"></line><line x1="12" y1="20" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"></line><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="4" y2="12"></line><line x1="20" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"></line><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"></line></svg>';
  const MOON_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';

  // Purely decorative — does not encode anything.
  const BARCODE_SVG = (() => {
    const widths = [3, 1, 2, 1, 4, 1, 2];
    let x = 0;
    const bars = [];
    let i = 0;
    while (x < 200) {
      const w = widths[i % widths.length];
      if (x + w > 200) break;
      bars.push(`<rect class="bar" x="${x}" y="0" width="${w}" height="36"></rect>`);
      x += w + 2 + (i % 3 === 1 ? 1 : 0);
      i += 1;
    }
    return `<svg class="rt-barcode" viewBox="0 0 200 36" preserveAspectRatio="none" aria-hidden="true">${bars.join('')}</svg>`;
  })();

  const themeToggle = document.getElementById('theme-toggle');

  function getStoredTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }

  // Light by default, regardless of the device's dark mode setting — dark
  // only when the shopper has picked it with the toggle.
  function effectiveTheme() {
    return getStoredTheme() === 'dark' ? 'dark' : 'light';
  }

  function applyTheme() {
    const current = effectiveTheme();
    document.documentElement.setAttribute('data-theme', current);
    themeToggle.innerHTML = current === 'dark' ? SUN_ICON : MOON_ICON;
    themeToggle.setAttribute('aria-label', current === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  }

  themeToggle.addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* storage unavailable */ }
    applyTheme();
  });

  applyTheme();

  // ---------- Reference data ----------
  // Approximate average combined state + local sales tax rates.
  // These are starting points only — the field is editable so a shopper
  // can match their exact store's rate.
  const STATES = [
    ['AL','Alabama',9.29], ['AK','Alaska',1.82], ['AZ','Arizona',8.40], ['AR','Arkansas',9.46],
    ['CA','California',8.82], ['CO','Colorado',7.81], ['CT','Connecticut',6.35], ['DE','Delaware',0.00],
    ['DC','District of Columbia',6.00], ['FL','Florida',7.02], ['GA','Georgia',7.38], ['HI','Hawaii',4.50],
    ['ID','Idaho',6.02], ['IL','Illinois',8.86], ['IN','Indiana',7.00], ['IA','Iowa',6.94],
    ['KS','Kansas',8.70], ['KY','Kentucky',6.00], ['LA','Louisiana',9.56], ['ME','Maine',5.50],
    ['MD','Maryland',6.00], ['MA','Massachusetts',6.25], ['MI','Michigan',6.00], ['MN','Minnesota',8.02],
    ['MS','Mississippi',7.07], ['MO','Missouri',8.39], ['MT','Montana',0.00], ['NE','Nebraska',6.94],
    ['NV','Nevada',8.23], ['NH','New Hampshire',0.00], ['NJ','New Jersey',6.60], ['NM','New Mexico',7.72],
    ['NY','New York',8.53], ['NC','North Carolina',6.98], ['ND','North Dakota',6.96], ['OH','Ohio',7.24],
    ['OK','Oklahoma',8.98], ['OR','Oregon',0.00], ['PA','Pennsylvania',6.34], ['RI','Rhode Island',7.00],
    ['SC','South Carolina',7.46], ['SD','South Dakota',6.11], ['TN','Tennessee',9.55], ['TX','Texas',8.20],
    ['UT','Utah',7.19], ['VT','Vermont',6.24], ['VA','Virginia',5.77], ['WA','Washington',8.92],
    ['WV','West Virginia',6.41], ['WI','Wisconsin',5.70], ['WY','Wyoming',5.44],
  ];

  const BASKET_PRESETS = {
    'none':   { enabled: false, amount: 0,  threshold: 0 },
    '5-25':   { enabled: true,  amount: 5,  threshold: 25 },
    '10-30':  { enabled: true,  amount: 10, threshold: 30 },
    '10-40':  { enabled: true,  amount: 10, threshold: 40 },
  };

  const STORAGE_KEY = 'therealtotal:v1';

  // ---------- Helpers ----------
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const money = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(round2(n)).toFixed(2);
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ---------- Elements ----------
  const stateSelect = $('#state-select');
  const taxRateInput = $('#tax-rate');
  const rateStateName = $('#rate-state-name');
  const customFields = $('#custom-basket-fields');
  const customAmount = $('#custom-amount');
  const customThreshold = $('#custom-threshold');
  const thresholdStatus = $('#threshold-status');
  const itemsList = $('#items-list');
  const addItemBtn = $('#add-item');
  const clearAllBtn = $('#clear-all');
  const receipt = $('#receipt');
  const stickyTotal = $('#sticky-total');
  const stickyTotalAmount = $('#sticky-total-amount');
  const spendList = $('#spend-list');
  const addSpendBtn = $('#add-spend');

  let itemCounter = 0;
  let spendCounter = 0;
  const newUid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // ---------- Populate state dropdown ----------
  STATES.forEach(([code, name, rate]) => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = `${name} — ${rate.toFixed(2)}%`;
    opt.dataset.rate = rate;
    opt.dataset.name = name;
    stateSelect.appendChild(opt);
  });

  // ---------- Multi-buy deal sentence builder ----------
  // Every item can carry up to three independent multi-buy deals at once —
  // one Store offer, one DG coupon, and one manufacturer coupon — mirroring
  // the real-world rule of one DG coupon + one manufacturer coupon per item
  // (plus whatever store-level promo is on the shelf tag). A deal in the DG
  // or manufacturer slot locks the matching plain coupon field, since that
  // slot already uses up the one-per-item allowance; the two slots never
  // lock each other.
  const DEAL_SLOTS = [
    { key: 'sale', label: 'Store offer deal', tag: 'Store', lockField: null },
    { key: 'dg', label: 'DG coupon deal', tag: 'DG', lockField: 'f-dg' },
    { key: 'mfr', label: 'Manufacturer coupon deal', tag: 'Mfr', lockField: 'f-mfr' },
  ];

  const DEAL_LABELS = {
    none: 'No multi-buy deal',
    free: 'Buy X Get Y Free',
    pct: 'Buy X Get Y at % off',
    dollar: 'Buy X Get Y at $ off',
    bundle: 'X for $ (bundle price)',
    flat: 'Buy X, Save $ flat',
  };

  const emptyDeal = () => ({ type: 'none', x: 1, y: 1, amt: 0 });

  function migrateDeals(data) {
    if (data.deals) return data.deals;
    const deals = { sale: emptyDeal(), dg: emptyDeal(), mfr: emptyDeal() };
    // Older saved data had a single deal with a "source" field instead of
    // three independent slots — fold it into the matching slot on upgrade.
    if (data.deal && data.deal.type && data.deal.type !== 'none') {
      const slot = data.deal.source || 'sale';
      deals[slot] = { type: data.deal.type, x: data.deal.x ?? 1, y: data.deal.y ?? 1, amt: data.deal.amt ?? 0 };
    }
    return deals;
  }

  function dealTypeOptionsHTML(selected) {
    return Object.entries(DEAL_LABELS).map(([val, label]) => `<option value="${val}" ${selected === val ? 'selected' : ''}>${label}</option>`).join('');
  }

  function dealFieldsHTML(type, v, slot) {
    const x = v.x ?? 1, y = v.y ?? 1, amt = v.amt ?? '';
    const cx = `f-deal-x-${slot}`, cy = `f-deal-y-${slot}`, ca = `f-deal-amt-${slot}`;
    switch (type) {
      case 'free':
        return `
          <label class="mini-field"><span>Buy</span><input type="number" class="${cx}" min="1" step="1" value="${x}"></label>
          <label class="mini-field"><span>Get</span><input type="number" class="${cy}" min="1" step="1" value="${y}"></label>
          <span class="deal-word">free</span>
        `;
      case 'pct':
        return `
          <label class="mini-field"><span>Buy</span><input type="number" class="${cx}" min="1" step="1" value="${x}"></label>
          <label class="mini-field"><span>Get</span><input type="number" class="${cy}" min="1" step="1" value="${y}"></label>
          <label class="mini-field"><span>at</span><input type="number" class="${ca}" min="0" max="100" step="1" placeholder="50" value="${amt}"><span class="deal-word">% off</span></label>
        `;
      case 'dollar':
        return `
          <label class="mini-field"><span>Buy</span><input type="number" class="${cx}" min="1" step="1" value="${x}"></label>
          <label class="mini-field"><span>Get</span><input type="number" class="${cy}" min="1" step="1" value="${y}"></label>
          <label class="mini-field"><span>at $</span><input type="number" class="${ca}" min="0" step="0.01" placeholder="2.00" value="${amt}"><span class="deal-word">off each</span></label>
        `;
      case 'bundle':
        return `
          <label class="mini-field"><span>Qty</span><input type="number" class="${cx}" min="1" step="1" value="${x}"></label>
          <label class="mini-field"><span>for $</span><input type="number" class="${ca}" min="0" step="0.01" placeholder="15.00" value="${amt}"></label>
        `;
      case 'flat':
        return `
          <label class="mini-field"><span>Buy</span><input type="number" class="${cx}" min="1" step="1" value="${x}"></label>
          <label class="mini-field"><span>Save $</span><input type="number" class="${ca}" min="0" step="0.01" placeholder="5.00" value="${amt}"></label>
        `;
      default:
        return '';
    }
  }

  function dealSlotBlockHTML(slot, deal) {
    const active = deal.type !== 'none';
    return `
      <div class="deal-fields-row" data-slot="${slot.key}" ${active ? '' : 'hidden'}>
        <span class="deal-slot-tag">${slot.tag}:</span>
        <div class="deal-fields-${slot.key}">${dealFieldsHTML(deal.type, deal, slot.key)}</div>
      </div>
    `;
  }

  function syncCouponFieldStates(row) {
    DEAL_SLOTS.forEach((slot) => {
      if (!slot.lockField) return;
      const typeEl = row.querySelector(`.f-deal-type-${slot.key}`);
      const input = row.querySelector(`.${slot.lockField}`);
      const active = typeEl.value !== 'none';
      input.disabled = active;
      input.title = active
        ? `Already using a ${slot.key === 'dg' ? 'DG' : 'manufacturer'} coupon via the multi-buy deal above — only one ${slot.key === 'dg' ? 'DG' : 'manufacturer'} coupon per item.`
        : '';
    });
  }

  // ---------- Item row template ----------
  function addItemRow(data = {}) {
    itemCounter += 1;
    const deals = migrateDeals(data);
    const row = document.createElement('div');
    row.className = 'item-row';
    row.dataset.id = itemCounter;
    // Stable id so spend & save deals can remember which items they cover.
    row.dataset.uid = data.uid || newUid();
    row.innerHTML = `
      <div class="item-row-top">
        <input type="text" class="item-name" placeholder="Item name (e.g. Tide Simply)" value="${escapeAttr(data.name || '')}">
        <button type="button" class="remove-item" aria-label="Remove item">&times;</button>
      </div>
      <div class="item-grid">
        <label>
          <span class="field-label">Qty</span>
          <input type="number" class="f-qty" min="1" step="1" value="${data.qty ?? 1}">
        </label>
        <label>
          <span class="field-label">Retail price</span>
          <input type="number" class="f-retail" min="0" step="0.01" placeholder="0.00" value="${data.retail ?? ''}">
        </label>
        <label>
          <span class="field-label">Sale price</span>
          <input type="number" class="f-sale" min="0" step="0.01" placeholder="same as retail" value="${data.sale ?? ''}"
            title="The price you'll actually be charged before any coupons — fold in Instant Savings here too.">
        </label>
        <label>
          <span class="field-label">DG coupon</span>
          <input type="number" class="f-dg" min="0" step="0.01" placeholder="0.00" value="${data.dg ?? ''}"
            ${deals.dg.type !== 'none' ? 'disabled title="Already using a DG coupon via the multi-buy deal above — only one DG coupon per item."' : ''}>
        </label>
        <label>
          <span class="field-label">Manufacturer coupon</span>
          <input type="number" class="f-mfr" min="0" step="0.01" placeholder="0.00" value="${data.mfr ?? ''}"
            ${deals.mfr.type !== 'none' ? 'disabled title="Already using a manufacturer coupon via the multi-buy deal above — only one manufacturer coupon per item."' : ''}>
        </label>
      </div>
      <div class="deal-block">
        <div class="deal-row-top">
          ${DEAL_SLOTS.map((slot) => `
            <label class="field field-narrow">
              <span class="field-label">${slot.label}</span>
              <select class="f-deal-type-${slot.key}">${dealTypeOptionsHTML(deals[slot.key].type)}</select>
            </label>
          `).join('')}
        </div>
        ${DEAL_SLOTS.map((slot) => dealSlotBlockHTML(slot, deals[slot.key])).join('')}
      </div>
      <div class="item-footer">
        <label class="taxable-toggle">
          <input type="checkbox" class="f-taxable" ${data.taxable === false ? '' : 'checked'}>
          Taxable item
        </label>
      </div>
    `;
    row.querySelector('.remove-item').addEventListener('click', () => {
      row.remove();
      persistAndRender();
    });
    itemsList.appendChild(row);
    return row;
  }

  // ---------- Spend & save deals ----------
  // Cart-level offers like "Save $5 when you spend $25 on select items".
  // Each deal covers a chosen set of items and splits its savings across them.
  const SPEND_KINDS = {
    sale: 'Instant Savings / store offer',
    dg: 'DG coupon',
    mfr: 'Manufacturer coupon',
  };

  function addSpendRow(data = {}) {
    spendCounter += 1;
    const row = document.createElement('div');
    row.className = 'spend-row';
    row.dataset.id = spendCounter;
    row.dataset.selected = JSON.stringify(Array.isArray(data.items) ? data.items : []);
    const kind = SPEND_KINDS[data.kind] ? data.kind : 'dg';
    const split = data.split === 'even' ? 'even' : 'price';
    row.innerHTML = `
      <div class="item-row-top">
        <input type="text" class="spend-name" placeholder="Deal name (e.g. P&G digital coupon)" value="${escapeAttr(data.name || '')}">
        <button type="button" class="remove-item remove-spend" aria-label="Remove deal">&times;</button>
      </div>
      <div class="field-row spend-fields">
        <label class="field field-narrow">
          <span class="field-label">Save</span>
          <div class="unit-input"><span class="unit">$</span><input type="number" class="s-amount" min="0" step="0.01" placeholder="5.00" value="${data.amount ?? ''}"></div>
        </label>
        <label class="field field-narrow">
          <span class="field-label">When you spend</span>
          <div class="unit-input"><span class="unit">$</span><input type="number" class="s-threshold" min="0" step="0.01" placeholder="25.00" value="${data.threshold ?? ''}"></div>
        </label>
        <label class="field field-narrow">
          <span class="field-label">Counts as</span>
          <select class="s-kind">${Object.entries(SPEND_KINDS).map(([v, l]) => `<option value="${v}" ${v === kind ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </label>
        <label class="field field-narrow">
          <span class="field-label">Split savings</span>
          <select class="s-split">
            <option value="price" ${split === 'price' ? 'selected' : ''}>By price</option>
            <option value="even" ${split === 'even' ? 'selected' : ''}>Evenly</option>
          </select>
        </label>
      </div>
      <span class="field-label spend-items-label">Items that count toward it</span>
      <div class="chip-grid s-items"></div>
      <p class="threshold-status spend-status" hidden></p>
    `;
    row.querySelector('.remove-spend').addEventListener('click', () => {
      row.remove();
      persistAndRender();
    });
    spendList.appendChild(row);
    return row;
  }

  // Keep each deal's item checklist in step with the item rows, preserving
  // which items were ticked. Only rebuilds when the item list actually changed.
  function syncSpendChips() {
    const itemRows = $$('.item-row');
    const signature = itemRows.map((r, i) => r.dataset.uid + ':' + ($('.item-name', r).value.trim() || `Item ${i + 1}`)).join('|');
    $$('.spend-row', spendList).forEach((row) => {
      const container = $('.s-items', row);
      if (container.dataset.sig === signature) return;
      const selected = new Set(container.dataset.sig === undefined
        ? JSON.parse(row.dataset.selected || '[]')
        : $$('input:checked', container).map((c) => c.value));
      container.dataset.sig = signature;
      container.innerHTML = itemRows.length
        ? itemRows.map((r, i) => {
            const uid = r.dataset.uid;
            const name = $('.item-name', r).value.trim() || `Item ${i + 1}`;
            return `<label class="check-chip"><input type="checkbox" value="${uid}" ${selected.has(uid) ? 'checked' : ''}><span>${escapeHtml(name)}</span></label>`;
          }).join('')
        : '<span class="hint">Add items below first.</span>';
    });
  }

  function readSpendDeals() {
    return $$('.spend-row', spendList).map((row) => ({
      el: row,
      name: $('.spend-name', row).value.trim(),
      amount: num($('.s-amount', row).value),
      threshold: num($('.s-threshold', row).value),
      kind: $('.s-kind', row).value,
      split: $('.s-split', row).value,
      itemUids: $$('.s-items input:checked', row).map((c) => c.value),
    }));
  }

  function spendLabel(d) {
    const offer = `Save $${d.amount.toFixed(2)} on $${d.threshold.toFixed(2)}`;
    return (d.name ? `${d.name}: ${offer}` : offer) + (SLOT_SUFFIX[d.kind] ?? '');
  }

  // Splits each qualifying deal of this kind across its items, either in
  // proportion to what each item still costs (how registers do it) or evenly,
  // never pushing an item below $0. `field` is the running price to reduce.
  function applySpendDeals(deals, kind, items, field) {
    deals.filter((d) => d.kind === kind && d.qualifies).forEach((d) => {
      const members = items.filter((i) => d.itemUids.includes(i.uid) && i[field] > 0);
      const pool = members.reduce((s, i) => s + i[field], 0);
      if (pool <= 0) return;
      const total = round2(Math.min(d.amount, pool));
      d.capped = d.amount > pool;

      const allocs = new Map();
      if (d.split === 'even') {
        // Hand out equal shares; anything an item can't absorb rolls to the rest.
        let left = total;
        let open = members.slice();
        while (left > 0.004 && open.length) {
          const share = Math.floor((left / open.length) * 100) / 100 || 0.01;
          const next = [];
          open.forEach((i) => {
            const have = allocs.get(i) || 0;
            const give = round2(Math.min(share, i[field] - have, left));
            if (give <= 0) return;
            allocs.set(i, round2(have + give));
            left = round2(left - give);
            if (i[field] - allocs.get(i) > 0.004) next.push(i);
          });
          open = next;
        }
      } else {
        let allocated = 0;
        members.forEach((i) => {
          const a = Math.min(i[field], round2(total * (i[field] / pool)));
          allocs.set(i, a);
          allocated = round2(allocated + a);
        });
        const remainder = round2(total - allocated);
        if (remainder !== 0) {
          const largest = members.reduce((a, b) => (b[field] > a[field] ? b : a), members[0]);
          allocs.set(largest, round2(allocs.get(largest) + remainder));
        }
      }

      const label = spendLabel(d) + (members.length > 1 ? ' (share)' : '');
      allocs.forEach((amount, i) => {
        if (amount <= 0) return;
        i[field] = Math.max(0, round2(i[field] - amount));
        i.spendLines.push({ kind, label, amount });
      });
    });
  }

  addSpendBtn.addEventListener('click', () => {
    addSpendRow();
    persistAndRender();
  });
  spendList.addEventListener('input', persistAndRender);
  spendList.addEventListener('change', persistAndRender);

  function escapeAttr(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  // ---------- Basket coupon selection ----------
  function getBasketConfig() {
    const selected = $('input[name="basket"]:checked').value;
    if (selected === 'custom') {
      return {
        enabled: true,
        amount: num(customAmount.value),
        threshold: num(customThreshold.value),
        label: `$${num(customAmount.value).toFixed(0)} off $${num(customThreshold.value).toFixed(0)}`,
      };
    }
    const preset = BASKET_PRESETS[selected] || BASKET_PRESETS['none'];
    return { ...preset, label: selected === 'none' ? null : `$${preset.amount} off $${preset.threshold}` };
  }

  $$('input[name="basket"]').forEach((r) => r.addEventListener('change', () => {
    customFields.hidden = r.value !== 'custom' ? true : false;
    if ($('input[name="basket"]:checked').value === 'custom') customFields.hidden = false;
    persistAndRender();
  }));
  customAmount.addEventListener('input', persistAndRender);
  customThreshold.addEventListener('input', persistAndRender);

  stateSelect.addEventListener('change', () => {
    const opt = stateSelect.selectedOptions[0];
    taxRateInput.value = opt.dataset.rate;
    rateStateName.textContent = opt.dataset.name;
    persistAndRender();
  });
  taxRateInput.addEventListener('input', persistAndRender);

  addItemBtn.addEventListener('click', () => {
    addItemRow();
    persistAndRender();
  });

  clearAllBtn.addEventListener('click', () => {
    if (!confirm('Clear every item and reset the calculator?')) return;
    localStorage.removeItem(STORAGE_KEY);
    itemsList.innerHTML = '';
    spendList.innerHTML = '';
    addItemRow();
    addItemRow();
    stateSelect.value = 'KY';
    stateSelect.dispatchEvent(new Event('change'));
    $('input[name="basket"][value="none"]').checked = true;
    customFields.hidden = true;
    persistAndRender();
  });

  itemsList.addEventListener('change', (e) => {
    const slot = DEAL_SLOTS.find((s) => e.target.classList.contains(`f-deal-type-${s.key}`));
    if (!slot) return;
    const row = e.target.closest('.item-row');
    const fieldsContainer = row.querySelector(`.deal-fields-${slot.key}`);
    fieldsContainer.innerHTML = dealFieldsHTML(e.target.value, {}, slot.key);
    row.querySelector(`.deal-fields-row[data-slot="${slot.key}"]`).hidden = e.target.value === 'none';
    syncCouponFieldStates(row);
  });

  itemsList.addEventListener('input', persistAndRender);
  itemsList.addEventListener('change', persistAndRender);

  stickyTotal.addEventListener('click', () => {
    receipt.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ---------- Core calculation ----------
  function readDealSlot(row, key) {
    const typeEl = row.querySelector(`.f-deal-type-${key}`);
    const xEl = row.querySelector(`.f-deal-x-${key}`);
    const yEl = row.querySelector(`.f-deal-y-${key}`);
    const amtEl = row.querySelector(`.f-deal-amt-${key}`);
    return {
      type: typeEl ? typeEl.value : 'none',
      x: xEl ? Math.max(1, Math.round(num(xEl.value) || 1)) : 1,
      y: yEl ? Math.max(1, Math.round(num(yEl.value) || 1)) : 1,
      amt: amtEl ? num(amtEl.value) : 0,
    };
  }

  function readItems() {
    return $$('.item-row').map((row) => {
      const deals = { sale: readDealSlot(row, 'sale'), dg: readDealSlot(row, 'dg'), mfr: readDealSlot(row, 'mfr') };
      return {
        el: row,
        uid: row.dataset.uid,
        name: $('.item-name', row).value.trim(),
        qty: Math.max(1, Math.round(num($('.f-qty', row).value) || 1)),
        retail: num($('.f-retail', row).value),
        sale: $('.f-sale', row).value === '' ? null : num($('.f-sale', row).value),
        // A deal in the DG or manufacturer slot already uses that item's one
        // DG-coupon / one-manufacturer-coupon allowance, so the matching
        // plain field is ignored rather than stacking two of the same type.
        dg: deals.dg.type !== 'none' ? 0 : num($('.f-dg', row).value),
        mfr: deals.mfr.type !== 'none' ? 0 : num($('.f-mfr', row).value),
        taxable: $('.f-taxable', row).checked,
        deals,
      };
    });
  }

  // Discount from a "Buy X Get Y ..." or "Buy X, Save $" deal, in dollars for the whole line.
  function computeDealDiscount(deal, unitPrice, qty, lineSale) {
    if (!deal || deal.type === 'none' || unitPrice <= 0) return 0;

    if (deal.type === 'flat') {
      const groupSize = Math.max(1, deal.x);
      const cycles = Math.floor(qty / groupSize);
      return Math.min(cycles * Math.max(0, deal.amt), lineSale);
    }

    if (deal.type === 'bundle') {
      const groupSize = Math.max(1, deal.x);
      const cycles = Math.floor(qty / groupSize);
      const bundleRetail = groupSize * unitPrice;
      const perCycleDiscount = Math.max(0, bundleRetail - Math.max(0, deal.amt));
      return Math.min(cycles * perCycleDiscount, lineSale);
    }

    const groupSize = Math.max(2, deal.x + deal.y);
    const cycles = Math.floor(qty / groupSize);
    const discountedUnits = cycles * deal.y;
    let perUnit = 0;
    if (deal.type === 'free') perUnit = unitPrice;
    else if (deal.type === 'pct') perUnit = unitPrice * (Math.min(100, Math.max(0, deal.amt)) / 100);
    else if (deal.type === 'dollar') perUnit = Math.min(Math.max(0, deal.amt), unitPrice);
    return Math.min(discountedUnits * perUnit, lineSale);
  }

  function dealCycles(deal, qty) {
    if (!deal || deal.type === 'none') return 0;
    const groupSize = (deal.type === 'flat' || deal.type === 'bundle') ? Math.max(1, deal.x) : Math.max(2, deal.x + deal.y);
    return Math.floor(qty / groupSize);
  }

  const SLOT_SUFFIX = { sale: '', dg: ' — DG coupon', mfr: ' — manufacturer coupon' };

  function describeDeal(deal, cycles, slotKey) {
    if (!deal || deal.type === 'none' || cycles <= 0) return null;
    const times = cycles > 1 ? ` (×${cycles})` : '';
    const suffix = SLOT_SUFFIX[slotKey] ?? '';
    let base;
    switch (deal.type) {
      case 'free': base = `Buy ${deal.x} Get ${deal.y} Free`; break;
      case 'pct': base = `Buy ${deal.x} Get ${deal.y} at ${deal.amt}% off`; break;
      case 'dollar': base = `Buy ${deal.x} Get ${deal.y} at $${deal.amt.toFixed(2)} off`; break;
      case 'bundle': base = `${deal.x} for $${deal.amt.toFixed(2)}`; break;
      case 'flat': base = `Buy ${deal.x}, Save $${deal.amt.toFixed(2)}`; break;
      default: return null;
    }
    return base + times + suffix;
  }

  function calculate() {
    const basket = getBasketConfig();
    const rawItems = readItems();
    const spendDeals = readSpendDeals();

    const shelfItems = rawItems.map((it) => {
      const unitPrice = it.sale !== null ? it.sale : it.retail;
      const lineRetail = it.retail * it.qty;
      const lineSale = unitPrice * it.qty;

      let base = lineSale;

      // Store offer deal — always applies if set, never locks anything, and
      // always counts toward the basket-coupon threshold.
      const saleDeal = it.deals.sale;
      const saleDealRaw = round2(computeDealDiscount(saleDeal, unitPrice, it.qty, lineSale));
      const saleDealLabel = describeDeal(saleDeal, dealCycles(saleDeal, it.qty), 'sale');
      const saleDealApplied = saleDeal.type !== 'none' ? Math.min(saleDealRaw, base) : 0;
      const saleDealCapped = saleDeal.type !== 'none' && saleDealRaw > base;
      base = Math.max(0, base - saleDealApplied);

      return {
        ...it, unitPrice, lineRetail, lineSale,
        saleDealApplied: round2(saleDealApplied), saleDealCapped, saleDealLabel,
        shelf: base, base, spendLines: [],
      };
    });

    // Spend & save thresholds are checked against the chosen items' price
    // after sale prices and store offer deals — before any coupons.
    spendDeals.forEach((d) => {
      const members = shelfItems.filter((i) => d.itemUids.includes(i.uid));
      d.memberCount = members.length;
      d.spend = round2(members.reduce((s, i) => s + i.shelf, 0));
      d.qualifies = d.amount > 0 && d.threshold > 0 && members.length > 0 && d.spend >= d.threshold;
      d.capped = false;
    });

    // Instant Savings / store-offer spend deals come off right away.
    applySpendDeals(spendDeals, 'sale', shelfItems, 'base');

    const items = shelfItems.map((it) => {
      const { unitPrice, lineSale } = it;
      let base = it.base;

      // DG slot — either a DG-sourced deal or the plain DG coupon field,
      // never both (readItems already zeroed the field when the deal is set).
      // Both count toward the basket-coupon threshold.
      const dgDeal = it.deals.dg;
      const dgDealRaw = round2(computeDealDiscount(dgDeal, unitPrice, it.qty, lineSale));
      const dgDealLabel = describeDeal(dgDeal, dealCycles(dgDeal, it.qty), 'dg');
      const dgDealApplied = dgDeal.type !== 'none' ? Math.min(dgDealRaw, base) : 0;
      const dgDealCapped = dgDeal.type !== 'none' && dgDealRaw > base;
      base = Math.max(0, base - dgDealApplied);

      const dgFieldApplied = Math.min(it.dg, base);
      const dgFieldCapped = it.dg > base;
      base = Math.max(0, base - it.dg);

      // Manufacturer slot — deferred until after the basket coupon and never
      // counts toward its threshold (same as the plain manufacturer field).
      const mfrDeal = it.deals.mfr;
      const mfrDealRaw = round2(computeDealDiscount(mfrDeal, unitPrice, it.qty, lineSale));
      const mfrDealLabel = describeDeal(mfrDeal, dealCycles(mfrDeal, it.qty), 'mfr');
      const mfrDealPending = mfrDeal.type !== 'none' ? mfrDealRaw : 0;

      return {
        ...it,
        dgDealApplied: round2(dgDealApplied), dgDealCapped, dgDealLabel,
        dgFieldApplied: round2(dgFieldApplied), dgFieldCapped,
        mfrDealPending, mfrDealLabel,
        base,
      };
    });

    // DG-coupon spend deals come off alongside the other DG coupons, so they
    // count toward the basket coupon threshold and lower the taxed price.
    applySpendDeals(spendDeals, 'dg', items, 'base');
    items.forEach((it) => { it.storeSubtotal = it.base; });

    const hasAnyInput = items.some((it) => it.retail > 0 || it.lineSale > 0);
    const thresholdSubtotal = items.reduce((s, it) => s + it.storeSubtotal, 0);
    const qualifies = basket.enabled && basket.threshold > 0 && thresholdSubtotal >= basket.threshold;
    const basketDiscountTotal = qualifies ? Math.min(basket.amount, thresholdSubtotal) : 0;

    // Proportionally distribute the basket discount across qualifying (non-zero) lines.
    let allocated = 0;
    const withAlloc = items.map((it) => {
      if (!qualifies || thresholdSubtotal <= 0 || it.storeSubtotal <= 0) {
        return { ...it, basketAlloc: 0 };
      }
      const share = it.storeSubtotal / thresholdSubtotal;
      const alloc = round2(basketDiscountTotal * share);
      allocated = round2(allocated + alloc);
      return { ...it, basketAlloc: alloc };
    });
    const remainder = round2(basketDiscountTotal - allocated);
    if (remainder !== 0 && withAlloc.length) {
      const largest = withAlloc.reduce((a, b) => (b.storeSubtotal > a.storeSubtotal ? b : a), withAlloc[0]);
      largest.basketAlloc = round2(largest.basketAlloc + remainder);
    }

    const finalItems = withAlloc.map((it) => {
      const afterBasket = Math.max(0, it.storeSubtotal - it.basketAlloc);
      // Tax is calculated on the price before manufacturer coupons come off.
      // A manufacturer coupon is reimbursed to the store by the manufacturer,
      // not a store price cut — most states still tax the pre-coupon price
      // even though you only pay the discounted amount out of pocket.
      const taxBasisLine = afterBasket;

      let remaining = afterBasket;
      const mfrDealApplied = Math.min(it.mfrDealPending, remaining);
      const mfrDealCapped = it.mfrDealPending > remaining;
      remaining = Math.max(0, remaining - mfrDealApplied);

      const mfrFieldApplied = Math.min(it.mfr, remaining);
      const mfrFieldCapped = it.mfr > remaining;
      remaining = Math.max(0, remaining - mfrFieldApplied);

      return {
        ...it, afterBasket, taxBasisLine,
        mfrDealApplied: round2(mfrDealApplied), mfrDealCapped,
        mfrFieldApplied: round2(mfrFieldApplied), mfrFieldCapped,
        remaining,
      };
    });

    // Manufacturer spend deals come off last, after tax is figured — no overage.
    applySpendDeals(spendDeals, 'mfr', finalItems, 'remaining');
    finalItems.forEach((it) => { it.finalLine = round2(Math.max(0, it.remaining)); });

    const taxableBasis = finalItems.filter((i) => i.taxable).reduce((s, i) => s + i.taxBasisLine, 0);
    const taxableSubtotal = finalItems.filter((i) => i.taxable).reduce((s, i) => s + i.finalLine, 0);
    const nonTaxableSubtotal = finalItems.filter((i) => !i.taxable).reduce((s, i) => s + i.finalLine, 0);
    const rate = Math.max(0, num(taxRateInput.value));
    const tax = round2(taxableBasis * (rate / 100));
    const preTaxSubtotal = round2(taxableSubtotal + nonTaxableSubtotal);
    const total = round2(preTaxSubtotal + tax);
    const totalRetail = finalItems.reduce((s, i) => s + i.lineRetail, 0);
    const totalSaved = round2(totalRetail - preTaxSubtotal);

    return { basket, spendDeals, items: finalItems, hasAnyInput, thresholdSubtotal, qualifies, rate, tax, taxableBasis, preTaxSubtotal, total, totalRetail, totalSaved };
  }

  // ---------- Rendering ----------
  function renderThresholdStatus(result) {
    const { basket, thresholdSubtotal, qualifies } = result;
    if (!basket.enabled) { thresholdStatus.hidden = true; return; }
    thresholdStatus.hidden = false;
    if (qualifies) {
      thresholdStatus.textContent = `Qualified — ${basket.label} is applied below.`;
      thresholdStatus.className = 'threshold-status met';
    } else {
      const needed = Math.max(0, basket.threshold - thresholdSubtotal);
      thresholdStatus.textContent = needed > 0
        ? `Add ${money(needed)} more before coupons to unlock ${basket.label}.`
        : `Set a threshold above $0 to use ${basket.label || 'this coupon'}.`;
      thresholdStatus.className = 'threshold-status unmet';
    }
  }

  function renderSpendStatus(result) {
    result.spendDeals.forEach((d) => {
      const el = $('.spend-status', d.el);
      el.hidden = false;
      if (d.amount <= 0 || d.threshold <= 0) {
        el.textContent = 'Enter how much you save and how much you need to spend.';
        el.className = 'threshold-status spend-status unmet';
      } else if (!d.memberCount) {
        el.textContent = 'Tick at least one item that counts toward this deal.';
        el.className = 'threshold-status spend-status unmet';
      } else if (d.qualifies) {
        const split = d.memberCount > 1 ? ` split ${d.split === 'even' ? 'evenly' : 'by price'} across ${d.memberCount} items` : '';
        el.textContent = `Qualified — ${money(d.spend)} spent, ${money(d.amount)} off${split}.` + (d.capped ? ' (Capped at what the items cost.)' : '');
        el.className = 'threshold-status spend-status met';
      } else {
        el.textContent = `${money(d.spend)} of ${money(d.threshold)} — spend ${money(d.threshold - d.spend)} more on these items to unlock it.`;
        el.className = 'threshold-status spend-status unmet';
      }
    });
  }

  function renderReceipt(result) {
    const { items, hasAnyInput, basket, qualifies, rate, tax, taxableBasis, preTaxSubtotal, total, totalRetail, totalSaved } = result;

    if (!hasAnyInput) {
      receipt.innerHTML = `
        <div class="rt-store">
          <div class="rt-store-name">Estimated Receipt</div>
          <div class="rt-store-accent"></div>
          <div class="rt-store-sub">Not a real transaction</div>
        </div>
        <hr class="rt-rule">
        <p class="rt-empty">Add an item on the left and your running total prints out here.</p>
      `;
      stickyTotal.dataset.visible = 'false';
      return;
    }

    const lines = items.filter((i) => i.retail > 0 || i.lineSale > 0).map((it) => {
      const label = (it.name || 'Item') + (it.qty > 1 ? ` ×${it.qty}` : '');
      let html = `
        <div class="rt-item">
          <div class="rt-line name"><span>${escapeHtml(label)}</span><span class="fill"></span><span class="amt">${money(it.lineSale)}</span></div>
      `;
      if (it.lineRetail !== it.lineSale) {
        html += deductionLine('Sale price', it.lineRetail - it.lineSale);
      }
      if (it.saleDealApplied > 0) html += deductionLine(it.saleDealLabel, it.saleDealApplied);
      if (it.saleDealCapped) html += cappedLine('Multi-buy deal capped — can\'t exceed the item price.');
      html += spendLinesHTML(it, 'sale');
      if (it.dgDealApplied > 0) html += deductionLine(it.dgDealLabel, it.dgDealApplied);
      if (it.dgDealCapped) html += cappedLine('Multi-buy deal capped — can\'t exceed the item price.');
      if (it.dgFieldApplied > 0) html += deductionLine('DG coupon', it.dgFieldApplied);
      if (it.dgFieldCapped) html += cappedLine('DG coupon capped — can\'t exceed the item price.');
      html += spendLinesHTML(it, 'dg');
      if (it.basketAlloc > 0) html += deductionLine(basket.label + ' (share)', it.basketAlloc);
      if (it.mfrDealApplied > 0) html += deductionLine(it.mfrDealLabel, it.mfrDealApplied);
      if (it.mfrDealCapped) html += cappedLine('Multi-buy deal capped — no overage allowed.');
      if (it.mfrFieldApplied > 0) html += deductionLine('Manufacturer coupon', it.mfrFieldApplied);
      if (it.mfrFieldCapped) html += cappedLine('Manufacturer coupon capped — no overage allowed.');
      html += spendLinesHTML(it, 'mfr');
      html += `</div>`;
      return html;
    }).join('');

    const itemCount = items.filter((i) => i.retail > 0 || i.lineSale > 0).reduce((s, i) => s + i.qty, 0);
    const mfrCouponsUsed = items.some((i) => i.mfrDealApplied > 0 || i.mfrFieldApplied > 0 || i.spendLines.some((l) => l.kind === 'mfr'));

    receipt.innerHTML = `
      <div class="rt-store">
        <div class="rt-store-name">Estimated Receipt</div>
        <div class="rt-store-accent"></div>
        <div class="rt-store-sub">Not a real transaction</div>
      </div>
      <hr class="rt-rule">
      ${lines || '<p class="rt-empty">Fill in a retail or sale price to start.</p>'}
      <hr class="rt-rule">
      <div class="rt-summary">
        <div class="rt-line"><span>Items</span><span class="fill"></span><span class="amt">${itemCount}</span></div>
        <div class="rt-line retail"><span>Retail price</span><span class="fill"></span><span class="amt">${money(totalRetail)}</span></div>
        <div class="rt-line"><span>Subtotal after discounts</span><span class="fill"></span><span class="amt">${money(preTaxSubtotal)}</span></div>
        <div class="rt-line"><span>Tax (${rate.toFixed(2)}%)</span><span class="fill"></span><span class="amt">${money(tax)}</span></div>
        ${mfrCouponsUsed ? `<p class="tax-note">Tax is based on ${money(taxableBasis)} — the price before manufacturer coupons. Most states still tax the pre-coupon price even though you pay less.</p>` : ''}
        <hr class="rt-rule strong">
        <div class="rt-line total"><span>Total</span><span class="fill"></span><span class="amt">${money(total)}</span></div>
        ${itemCount > 0 ? `<div class="rt-line per-item"><span>Per item</span><span class="fill"></span><span class="amt">${money(round2(total / itemCount))}</span></div>` : ''}
        ${totalSaved > 0 ? `<div class="rt-line saved"><span>You saved ${money(totalSaved)} off retail</span></div>` : ''}
      </div>
      <div class="rt-barcode-block">
        ${BARCODE_SVG}
        <div class="rt-barcode-caption">ESTIMATE ONLY · NOT A RECEIPT</div>
      </div>
    `;

    stickyTotalAmount.textContent = money(total);
    stickyTotal.dataset.visible = 'true';
  }

  function spendLinesHTML(it, kind) {
    return it.spendLines.filter((l) => l.kind === kind).map((l) => deductionLine(l.label, l.amount)).join('');
  }
  function deductionLine(label, amount) {
    return `<div class="rt-line deduction"><span>${escapeHtml(label)}</span><span class="fill"></span><span class="amt">-${money(amount).replace('-', '')}</span></div>`;
  }
  function cappedLine(text) {
    return `<div class="rt-line capped"><span>${escapeHtml(text)}</span></div>`;
  }
  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---------- Persistence ----------
  function serializeState() {
    return {
      state: stateSelect.value,
      taxRate: taxRateInput.value,
      basket: $('input[name="basket"]:checked').value,
      customAmount: customAmount.value,
      customThreshold: customThreshold.value,
      spendDeals: readSpendDeals().map((d) => ({
        name: d.name, amount: $('.s-amount', d.el).value, threshold: $('.s-threshold', d.el).value,
        kind: d.kind, split: d.split, items: d.itemUids,
      })),
      items: readItems().map((it) => ({
        uid: it.uid, name: it.name, qty: it.qty, retail: $('.f-retail', it.el).value, sale: $('.f-sale', it.el).value,
        dg: $('.f-dg', it.el).value, mfr: $('.f-mfr', it.el).value,
        taxable: it.taxable, deals: it.deals,
      })),
    };
  }

  function persistAndRender() {
    syncSpendChips();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeState())); } catch (e) { /* storage unavailable */ }
    const result = calculate();
    renderThresholdStatus(result);
    renderSpendStatus(result);
    renderReceipt(result);
  }

  function restoreState() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (e) { saved = null; }

    if (!saved) {
      stateSelect.value = 'KY';
      stateSelect.dispatchEvent(new Event('change'));
      addItemRow();
      addItemRow();
      return;
    }

    stateSelect.value = saved.state || 'KY';
    const opt = stateSelect.selectedOptions[0];
    rateStateName.textContent = opt ? opt.dataset.name : 'Kentucky';
    taxRateInput.value = saved.taxRate ?? (opt ? opt.dataset.rate : 6);

    const basketInput = document.querySelector(`input[name="basket"][value="${saved.basket}"]`);
    if (basketInput) basketInput.checked = true;
    customFields.hidden = saved.basket !== 'custom';
    customAmount.value = saved.customAmount || '';
    customThreshold.value = saved.customThreshold || '';

    if (Array.isArray(saved.items) && saved.items.length) {
      saved.items.forEach((it) => addItemRow(it));
    } else {
      addItemRow();
      addItemRow();
    }
    if (Array.isArray(saved.spendDeals)) saved.spendDeals.forEach((d) => addSpendRow(d));
  }

  // ---------- Init ----------
  restoreState();
  persistAndRender();
})();
