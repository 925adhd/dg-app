(() => {
  'use strict';

  // ---------- "Bought" tab: a haul & resale tracker ----------
  // Every saved receipt becomes a haul (one shopping trip) holding its items.
  // Each item tracks what it cost, what it's worth at retail, what you plan to
  // resell it for, and what it actually sold for — so profit adds itself up.
  // Optionally mirrors everything, plus the calculator and its saved
  // scenarios, to a Google Sheet you own (see
  // google-sheet-sync/Code.gs). The sheet link and secret key are stored only
  // in this browser — never in the code — because this repo is public.

  const DATA_KEY = 'therealtotal:bought:v1';
  const SYNC_KEY = 'therealtotal:sync:v1';
  const TAB_KEY = 'therealtotal:tab';
  const VIEW_KEY = 'therealtotal:bought-view';

  // Only Google Apps Script web app URLs are accepted, so the secret key can
  // never be sent anywhere else by a typo or a pasted look-alike link.
  const SCRIPT_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
  const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
  // typeof check matters: ID_RE.test(undefined) is true (it tests "undefined").
  const validId = (v) => typeof v === 'string' && ID_RE.test(v);
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  // Product photos may only come from the databases' own image servers.
  const IMAGE_RE = /^https:\/\/images\.open(food|products|beauty)facts\.org\/[\w./-]+$/;
  const MAX_TEXT = 200;
  const MAX_ROWS = 5000;

  // ---------- Helpers ----------
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const money = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(round2(n)).toFixed(2);
  const signedMoney = (n) => (round2(n) > 0 ? '+' : '') + money(n);
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const pad = (n) => String(n).padStart(2, '0');
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  // Escapes everything that's put into HTML — item names typed here or pulled
  // from the sheet are treated as text, never as markup.
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
  // Profit as a share of what it sold for, e.g. " (62%)".
  const marginText = (profit, sold) => (sold > 0 ? ` (${pct(profit, sold)}%)` : '');
  const blankIfZero = (n) => (n ? String(round2(n)) : '');

  function formatDate(iso) {
    if (!DATE_RE.test(iso)) return '';
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ---------- Booth pricing ----------
  // New items default to a resell price of X% off retail; an optional
  // commission (what a booth or mall keeps from each sale) is taken out of
  // potential profit and pre-filled as the fee when recording a sale.
  // Booth rent is a fixed cost per week or month, so it comes out of total
  // profit rather than out of any one item.
  const PRICING_KEY = 'therealtotal:pricing';
  const clampPct = (v, fallback) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback; };
  const DEFAULT_PRICING = { pctOff: 30, commission: 0, rent: 0, rentPeriod: 'month', rentStart: '' };

  function cleanPricing(p) {
    return {
      pctOff: clampPct(p.pctOff, 30),
      commission: clampPct(p.commission, 0),
      rent: Math.max(0, round2(num(p.rent))),
      rentPeriod: p.rentPeriod === 'week' ? 'week' : 'month',
      rentStart: typeof p.rentStart === 'string' && DATE_RE.test(p.rentStart) ? p.rentStart : '',
    };
  }

  function storedPricing() {
    try { return cleanPricing(JSON.parse(localStorage.getItem(PRICING_KEY)) || {}); } catch (e) { return { ...DEFAULT_PRICING }; }
  }

  let pricing = storedPricing();
  const boothPrice = (unitRetail) => round2(unitRetail * (1 - pricing.pctOff / 100));
  const afterCommission = (amount) => amount * (1 - pricing.commission / 100);

  // ---------- Categories ----------
  // Your own list (laundry, body wash…), so a category can exist before any
  // item is in it. Items keep the name as text; a category on an item that
  // isn't in the list (say, typed into the sheet) still shows everywhere.
  const CATEGORY_KEY = 'therealtotal:categories';
  const catKey = (c) => String(c || '').trim().toLowerCase();
  // The "+ New category…" choice in a category menu. Real categories are
  // trimmed, so one can never start with a space and clash with this.
  const NEW_CATEGORY = ' new';

  function cleanCategories(list) {
    const seen = new Set();
    return (Array.isArray(list) ? list.slice(0, 500) : [])
      .map((c) => cleanText(c).trim())
      .filter((c) => c && !seen.has(catKey(c)) && seen.add(catKey(c)))
      .sort((a, b) => a.localeCompare(b));
  }

  let categories = [];
  try { categories = cleanCategories(JSON.parse(localStorage.getItem(CATEGORY_KEY))); } catch (e) { /* storage unavailable */ }

  // Your list plus any category an item has that isn't in it.
  const allCategories = () => cleanCategories([...categories, ...data.items.map((it) => it.category)]);
  // A category's name as you entered it, or '' if there's no such category.
  const categoryNamed = (text) => allCategories().find((c) => catKey(c) === catKey(text)) || '';

  // `mixed` is for a product whose purchases are in different categories.
  function categoryOptionsHTML(current, mixed = false) {
    return (mixed ? '<option value="" selected disabled>Mixed</option>' : '')
      + `<option value=""${!mixed && !current ? ' selected' : ''}>No category</option>`
      + allCategories().map((c) => `<option value="${esc(c)}"${!mixed && catKey(c) === catKey(current) ? ' selected' : ''}>${esc(c)}</option>`).join('')
      + `<option value="${NEW_CATEGORY}">+ New category…</option>`;
  }

  const parseISO = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
  const toISO = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;

  // Rent is paid up front, so every period that has started counts in full:
  // a booth started Sep 15 at $60/month has paid $60 on Oct 11 and $120 on Oct 15.
  function rentSoFar() {
    if (!pricing.rent || !pricing.rentStart) return { periods: 0, paid: 0, periodStart: '' };
    const start = parseISO(pricing.rentStart);
    const now = parseISO(today());
    if (now < start) return { periods: 0, paid: 0, periodStart: '' };
    let periods;
    let periodStart;
    if (pricing.rentPeriod === 'week') {
      periods = Math.floor(Math.round((now - start) / 86400000) / 7) + 1;
      periodStart = new Date(start.getFullYear(), start.getMonth(), start.getDate() + (periods - 1) * 7);
    } else {
      periods = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth()) + (now.getDate() >= start.getDate() ? 1 : 0);
      periodStart = new Date(start.getFullYear(), start.getMonth() + periods - 1, start.getDate());
    }
    return { periods, paid: round2(periods * pricing.rent), periodStart: toISO(periodStart) };
  }

  // ---------- Data cleaning ----------
  // Everything loaded from storage or the sheet goes through these, so bad or
  // hostile values can't break the page or sneak markup in.
  const cleanText = (v) => (v === undefined || v === null ? '' : String(v).slice(0, MAX_TEXT));
  const cleanMoney = (v) => Math.max(0, round2(num(v)));
  // An item's photo is either the id of one you took (kept in photos.js and
  // the sheet's Photos tab) or a product-database image link.
  const cleanPhoto = (v) => (validId(v) || (typeof v === 'string' && IMAGE_RE.test(v)) ? v : '');
  // Barcodes are kept as digit strings so leading zeros survive.
  const cleanUpc = (v) => (v === undefined || v === null ? '' : String(v).replace(/\D/g, '').slice(0, 14));

  function cleanHaul(h) {
    if (!h || typeof h !== 'object') return null;
    return {
      id: validId(h.id) ? h.id : newId(),
      date: typeof h.date === 'string' && DATE_RE.test(h.date) ? h.date : today(),
      store: cleanText(h.store),
      name: cleanText(h.name),
      notes: cleanText(h.notes),
    };
  }

  function cleanItem(i) {
    // An empty haulId is an item added straight to inventory, not from a trip.
    const loose = i && (i.haulId === undefined || i.haulId === null || i.haulId === '');
    if (!i || typeof i !== 'object' || !(loose || validId(i.haulId))) return null;
    const qty = Math.max(1, Math.round(num(i.qty) || 1));
    const unitRetail = cleanMoney(i.unitRetail);
    return {
      id: validId(i.id) ? i.id : newId(),
      haulId: loose ? '' : i.haulId,
      name: cleanText(i.name),
      category: cleanText(i.category).trim(),
      upc: cleanUpc(i.upc),
      photo: cleanPhoto(i.photo),
      qty,
      unitRetail,
      totalPaid: cleanMoney(i.totalPaid),
      taxPaid: cleanMoney(i.taxPaid),
      resalePrice: i.resalePrice === undefined || i.resalePrice === '' ? boothPrice(unitRetail) : cleanMoney(i.resalePrice),
      soldQty: Math.min(qty, Math.max(0, Math.round(num(i.soldQty)))),
      soldTotal: cleanMoney(i.soldTotal),
      fees: cleanMoney(i.fees),
      soldDate: DATE_RE.test(i.soldDate) ? i.soldDate : '',
      platform: cleanText(i.platform),
      location: cleanText(i.location),
      notes: cleanText(i.notes),
    };
  }

  function cleanData(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const seen = new Set();
    const hauls = (Array.isArray(src.hauls) ? src.hauls.slice(0, MAX_ROWS) : [])
      .map(cleanHaul)
      .filter((h) => h && !seen.has(h.id) && seen.add(h.id));
    const haulIds = new Set(hauls.map((h) => h.id));
    const itemIds = new Set();
    const items = (Array.isArray(src.items) ? src.items.slice(0, MAX_ROWS) : [])
      .map(cleanItem)
      .filter((i) => i && (i.haulId === '' || haulIds.has(i.haulId)) && !itemIds.has(i.id) && itemIds.add(i.id));
    return { hauls, items };
  }

  // ---------- Storage ----------
  function loadData() {
    try { return cleanData(JSON.parse(localStorage.getItem(DATA_KEY))); } catch (e) { return { hauls: [], items: [] }; }
  }

  let data = loadData();

  function persist() {
    try { localStorage.setItem(DATA_KEY, JSON.stringify(data)); } catch (e) { /* storage unavailable */ }
  }

  function save() {
    persist();
    noteLocalChanges();
    scheduleSync();
    schedulePhotoCleanup();
  }

  // ---------- Math ----------
  function itemCalc(it) {
    const unitCost = it.qty ? it.totalPaid / it.qty : 0;
    const retail = it.unitRetail * it.qty;
    // Savings are measured before tax, matching the calculator's receipt.
    const saved = Math.max(0, retail - (it.totalPaid - it.taxPaid));
    const left = it.qty - it.soldQty;
    const profit = it.soldQty > 0 ? it.soldTotal - it.fees - unitCost * it.soldQty : 0;
    const netEach = afterCommission(it.resalePrice);
    const potential = left * (netEach - unitCost);
    // Selling at this price (after commission) wouldn't cover what it cost.
    const belowCost = left > 0 && it.resalePrice > 0 && netEach < unitCost - 0.004;
    const status = it.soldQty <= 0 ? 'unsold' : it.soldQty >= it.qty ? 'sold' : 'partial';
    return { unitCost, retail, saved, left, profit, potential, belowCost, status };
  }

  function totalsFor(items) {
    return items.reduce((t, it) => {
      const c = itemCalc(it);
      t.units += it.qty;
      t.retail += c.retail;
      t.paid += it.totalPaid;
      t.tax += it.taxPaid;
      t.saved += c.saved;
      t.soldUnits += it.soldQty;
      t.soldTotal += it.soldTotal;
      t.profit += c.profit;
      t.leftUnits += c.left;
      t.leftCost += c.left * c.unitCost;
      t.potential += c.potential;
      return t;
    }, { units: 0, retail: 0, paid: 0, tax: 0, saved: 0, soldUnits: 0, soldTotal: 0, profit: 0, leftUnits: 0, leftCost: 0, potential: 0 });
  }

  const itemsOf = (haulId) => data.items.filter((i) => i.haulId === haulId);

  // ---------- Elements ----------
  const tabButtons = $$('.tab-button');
  const views = { calc: $('#view-calc'), bought: $('#view-bought') };
  const summaryEl = $('#bought-summary');
  const haulList = $('#haul-list');
  const filterInputs = $$('input[name="bought-filter"]');
  const addHaulBtn = $('#add-haul');
  const viewInputs = $$('input[name="bought-view"]');
  const tripFilters = $('#trip-filters');
  const searchInput = $('#bought-search');
  const invList = $('#inv-list');
  const invMessage = $('#inv-message');
  const catFilters = $('#cat-filters');
  const syncStatusEl = $('#sync-status');
  const syncSetup = $('#sync-setup');
  const syncConnected = $('#sync-connected');
  const syncUrlInput = $('#sync-url');
  const syncKeyInput = $('#sync-key');
  const syncMessage = $('#sync-message');

  // ---------- Tabs ----------
  function setTab(name) {
    const tab = views[name] ? name : 'calc';
    Object.entries(views).forEach(([key, el]) => { el.hidden = key !== tab; });
    tabButtons.forEach((b) => {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    document.body.dataset.tab = tab;
    try { localStorage.setItem(TAB_KEY, tab); } catch (e) { /* storage unavailable */ }
  }

  tabButtons.forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('.tab-bar').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = tabButtons.findIndex((b) => b.getAttribute('aria-selected') === 'true');
    const next = tabButtons[(i + (e.key === 'ArrowRight' ? 1 : tabButtons.length - 1)) % tabButtons.length];
    setTab(next.dataset.tab);
    next.focus();
  });

  // ---------- Rendering ----------
  // All / In stock / Sold, remembered separately for each view.
  const viewFilter = { trips: 'all', inventory: 'stock' };

  function filterMode() {
    const checked = filterInputs.find((r) => r.checked);
    return checked ? checked.value : 'all';
  }

  function itemMatches(it, mode) {
    if (mode === 'stock') return it.soldQty < it.qty;
    if (mode === 'sold') return it.soldQty > 0;
    return true;
  }

  function renderSummary() {
    const t = totalsFor(data.items);
    const tile = (label, value, sub = '', tone = '') => `
      <div class="stat${tone ? ` ${tone}` : ''}">
        <span class="stat-label">${label}</span>
        <span class="stat-value">${value}</span>
        ${sub ? `<span class="stat-sub">${sub}</span>` : ''}
      </div>`;
    const products = new Set(data.items.filter((it) => it.soldQty < it.qty).map((it) => productKey(it.name))).size;
    summaryEl.innerHTML = `
      <div class="stat stat-hero">
        <span class="stat-label">Your stockpile</span>
        <span class="stat-value">${t.leftUnits}<span class="stat-unit"> item${t.leftUnits === 1 ? '' : 's'} on hand</span></span>
        <span class="stat-sub">${products} product${products === 1 ? '' : 's'} · ${money(t.leftCost)} cost · ${signedMoney(t.potential)} potential profit</span>
      </div>
      ${tile('Spent', money(t.paid), `${t.units} item${t.units === 1 ? '' : 's'} · incl. ${money(t.tax)} tax`)}
      ${tile('Saved', money(t.saved), `${pct(t.saved, t.retail)}% off ${money(t.retail)} retail`, 'good')}
      ${tile('Sold', money(t.soldTotal), `${t.soldUnits} item${t.soldUnits === 1 ? '' : 's'} sold`)}
      ${(() => {
        const rent = rentSoFar();
        if (!rent.paid) return tile('Profit', signedMoney(t.profit), `after cost & fees${t.soldTotal ? ` · ${pct(t.profit, t.soldTotal)}% of sales` : ''}`, t.profit < 0 ? 'bad' : 'good');
        const net = t.profit - rent.paid;
        return tile('Profit', signedMoney(net), `after cost, fees & ${money(rent.paid)} rent${t.soldTotal ? ` · ${pct(net, t.soldTotal)}% of sales` : ''}`, net < 0 ? 'bad' : 'good');
      })()}
    `;
    renderRentStatus();
  }

  function haulTotalsText(haulId) {
    const t = totalsFor(itemsOf(haulId));
    return `${t.units} item${t.units === 1 ? '' : 's'} · Paid ${money(t.paid)} · Retail ${money(t.retail)} · Saved ${pct(t.saved, t.retail)}%`
      + (t.soldUnits ? ` · Profit ${signedMoney(t.profit)}${marginText(t.profit, t.soldTotal)}` : '');
  }

  const STATUS_LABELS = { unsold: 'In stock', partial: 'Partly sold', sold: 'Sold' };

  function itemFootHTML(it) {
    const c = itemCalc(it);
    const parts = [
      `<span class="status-pill ${c.status}">${STATUS_LABELS[c.status]}</span>`,
      `<span>Cost ${money(c.unitCost)} each${it.haulId && it.totalPaid ? (it.taxPaid ? ' with tax' : ' · no tax added yet') : ''}</span>`,
      `<span class="${pct(c.saved, c.retail) >= 50 ? 'good' : 'bad'}">Saved ${pct(c.saved, c.retail)}%</span>`,
    ];
    if (it.soldQty > 0) parts.push(`<span class="${c.profit < 0 ? 'bad' : 'good'}">Profit ${signedMoney(c.profit)}${marginText(c.profit, it.soldTotal)}</span>`);
    if (c.left > 0) parts.push(`<span class="muted">${c.left > 1 ? `${c.left} left` : '1 left'} · potential ${signedMoney(c.potential)}</span>`);
    if (c.belowCost) parts.push(`<span class="below-cost">Below cost — price at ${money(minPrice(c.unitCost))}+ to break even</span>`);
    return parts.join('');
  }

  // Trips and items start folded up as one-line summaries; these remember
  // which ones are open across re-renders. '' is the no-trip card.
  const openHauls = new Set();
  const openItems = new Set();

  const itemMetaText = (it) => [
    `Qty ${it.qty}`,
    it.totalPaid ? `Paid ${money(it.totalPaid)}` : '',
    STATUS_LABELS[itemCalc(it).status],
  ].filter(Boolean).join(' · ');

  const haulTitle = (h) => h.name || h.store || 'Haul';

  function itemHTML(it, forceOpen = false) {
    const open = forceOpen || openItems.has(it.id);
    const field = (label, f, value, attrs = 'min="0" step="0.01" inputmode="decimal"', type = 'number') => `
      <label><span class="field-label">${label}</span><input type="${type}" data-f="${f}" value="${esc(value)}" ${attrs}></label>`;
    return `
      <div class="b-item${open ? ' is-open' : ''}" data-item="${esc(it.id)}">
        <div class="b-item-summary">
          ${photoThumbHTML(it.photo, it.name)}
          <button type="button" class="b-item-toggle" data-action="toggle-item" aria-expanded="${open}">
            <span class="b-item-text">
              <span class="b-item-name">${esc(it.name || 'Unnamed item')}</span>
              <span class="b-item-meta">${esc(itemMetaText(it))}</span>
            </span>
            <svg class="chevron" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
          </button>
        </div>
        <div class="b-item-body"${open ? '' : ' hidden'}>
          <div class="item-row-top">
            <input type="text" class="item-name" data-f="name" placeholder="Item name" maxlength="${MAX_TEXT}" value="${esc(it.name)}">
            <button type="button" class="remove-item" data-action="delete-item" aria-label="Delete item">&times;</button>
          </div>
          <div class="b-grid">
            ${field('Qty', 'qty', it.qty, 'min="1" step="1" inputmode="numeric"')}
            ${field('Retail each', 'unitRetail', blankIfZero(it.unitRetail))}
            ${it.haulId
              ? field('Paid total (before tax)', 'paidBeforeTax', blankIfZero(it.totalPaid - it.taxPaid))
              : field('Paid total (with tax)', 'totalPaid', blankIfZero(it.totalPaid))}
            ${field('Resell at (each)', 'resalePrice', blankIfZero(it.resalePrice))}
          </div>
          <div class="b-grid b-grid-2">
            <label><span class="field-label">Location</span><input type="text" data-f="location" placeholder="e.g. Bin 3" maxlength="${MAX_TEXT}" value="${esc(it.location)}"></label>
            <label><span class="field-label">Notes</span><input type="text" data-f="notes" placeholder="e.g. dented box" maxlength="${MAX_TEXT}" value="${esc(it.notes)}"></label>
            <label><span class="field-label">Category</span><select data-f="category">${categoryOptionsHTML(it.category)}</select></label>
            <label><span class="field-label">Barcode</span><span class="barcode-field"><input type="text" data-f="upc" inputmode="numeric" placeholder="Scan or type" maxlength="14" autocomplete="off" value="${esc(it.upc)}"><button type="button" class="barcode-scan" data-action="scan-upc" aria-label="Scan this item’s barcode" title="Scan this item’s barcode">${BARCODE_ICON}</button></span></label>
          </div>
          <details class="b-sale"${it.soldQty > 0 ? ' open' : ''}>
            <summary>Sale info</summary>
            <div class="b-grid">
              ${field('Qty sold', 'soldQty', blankIfZero(it.soldQty), 'min="0" step="1" inputmode="numeric"')}
              ${field('Sold for (total)', 'soldTotal', blankIfZero(it.soldTotal))}
              ${field('Fees & shipping', 'fees', blankIfZero(it.fees))}
              ${field('Date sold', 'soldDate', it.soldDate, '', 'date')}
            </div>
            <label class="b-wide"><span class="field-label">Sold on</span><input type="text" data-f="platform" placeholder="e.g. Facebook, eBay" maxlength="${MAX_TEXT}" value="${esc(it.platform)}"></label>
          </details>
          <div class="b-foot">${itemFootHTML(it)}</div>
        </div>
      </div>`;
  }

  // A trip: a one-line summary that opens to show its items.
  function haulHTML(h, items, forceOpen = false) {
    const id = h.id;
    const open = forceOpen || openHauls.has(id);
    const head = `
          <div class="haul-head">
            <div class="haul-fields">
              <input type="date" data-h="date" value="${esc(h.date)}" aria-label="Haul date">
              <input type="text" data-h="name" placeholder="Haul name (optional)" maxlength="${MAX_TEXT}" value="${esc(h.name)}" aria-label="Haul name">
              <input type="text" data-h="store" placeholder="Store" maxlength="${MAX_TEXT}" value="${esc(h.store)}" aria-label="Store">
            </div>
          </div>`;
    return `
      <article class="haul${open ? ' is-open' : ''}" data-haul="${esc(id)}">
        <button type="button" class="haul-summary" data-action="toggle-haul" aria-expanded="${open}">
          <span class="haul-summary-text">
            <span class="haul-title-row">
              <span class="haul-title">${esc(haulTitle(h))}</span>
              <span class="haul-date">${esc(formatDate(h.date))}</span>
            </span>
            <span class="haul-totals">${esc(haulTotalsText(id))}</span>
          </span>
          <svg class="chevron" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <div class="haul-body"${open ? '' : ' hidden'}>${head}
          <div class="haul-items">${items.map((it) => itemHTML(it)).join('')}</div>
          <div class="haul-receipt">
            <div class="haul-receipt-row">
              <label><span class="field-label">Tax on receipt</span><input type="number" class="haul-receipt-tax" min="0" step="0.01" inputmode="decimal" placeholder="0.00"></label>
              <label><span class="field-label">Kept for myself (before tax)</span><input type="number" class="haul-receipt-kept" min="0" step="0.01" inputmode="decimal" placeholder="0.00"></label>
              <button type="button" class="add-button add-button-secondary" data-action="spread-tax">Spread tax</button>
            </div>
            <p class="haul-receipt-note">Enter the tax from your receipt, plus the prices of anything you kept for yourself added together. The tax is split across your items by price.</p>
          </div>
          <div class="haul-add">
            <button type="button" class="add-button add-button-secondary" data-action="add-item">+ Add item</button>
            <button type="button" class="add-button add-button-secondary" data-action="scan-items">Scan items</button>
          </div>
          <div class="haul-danger">
            <button type="button" class="haul-delete" data-action="delete-haul">Delete this haul</button>
          </div>
        </div>
      </article>`;
  }

  // Folds a trip or item open or shut in place, without re-rendering.
  function toggleOpen(el, set, key, bodySel, open = !el.classList.contains('is-open')) {
    if (open) set.add(key); else set.delete(key);
    el.classList.toggle('is-open', open);
    $(bodySel, el).hidden = !open;
    el.querySelector('[aria-expanded]').setAttribute('aria-expanded', String(open));
  }

  // One search box at the top of the tab drives both views.
  const searchQuery = () => searchInput.value.trim().toLowerCase();
  const has = (text, q) => String(text || '').toLowerCase().includes(q);
  const itemSearchMatch = (it, q) => !q || has(it.name, q) || has(it.category, q) || has(it.location, q) || has(it.notes, q) || has(it.platform, q) || has(it.upc, q);

  function renderHauls() {
    const mode = filterMode();
    const q = searchQuery();
    const sorted = data.hauls.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    // Searching or filtering opens every trip that has a match.
    const reveal = !!q || mode !== 'all';
    const html = sorted.map((h) => {
      const all = itemsOf(h.id);
      // A search that matches the trip itself (name or store) shows the whole trip.
      const tripHit = q && (has(h.name, q) || has(h.store, q));
      const shown = all.filter((it) => itemMatches(it, mode) && (tripHit || itemSearchMatch(it, q)));
      // Always show empty trips under "All" so a just-added one doesn't vanish.
      if (!shown.length && (q || mode !== 'all' || all.length)) return '';
      return haulHTML(h, shown, reveal && shown.length > 0);
    }).join('');
    haulList.innerHTML = html || `<p class="empty-note">${data.hauls.length
      ? (q ? 'No hauls match that search. Single items are in Inventory.' : 'Nothing matches this filter.')
      : data.items.length
        ? 'No hauls yet. Your single items are in Inventory.'
        : 'No purchases yet. Build a receipt on the Calculator tab and tap “Save to Bought”, or start a new haul by hand.'}</p>`;
    showPhotos(haulList);
  }

  // ---------- Inventory view ----------
  // Everything you've bought — from trips and single items — merged by
  // product name so the same thing bought three times reads as one line.
  const productKey = (name) => (name || '').trim().toLowerCase().replace(/\s+/g, ' ') || '(unnamed)';
  let invGroups = [];

  function buildInventory() {
    // The display name sticks to how the product was first entered, even
    // after that first batch sells out.
    const firstName = new Map();
    data.items.forEach((it) => {
      const key = productKey(it.name);
      if (!firstName.has(key)) firstName.set(key, it.name.trim() || 'Unnamed item');
    });
    const byKey = new Map();
    data.items.forEach((it) => {
      const key = productKey(it.name);
      if (!byKey.has(key)) byKey.set(key, { key, name: firstName.get(key), lots: [] });
      byKey.get(key).lots.push(it);
    });
    const haulDate = new Map(data.hauls.map((h) => [h.id, h.date]));
    return Array.from(byKey.values()).map((g) => {
      // Oldest first — that's the order sales are taken from.
      g.lots.sort((a, b) => (haulDate.get(a.haulId) || '').localeCompare(haulDate.get(b.haulId) || ''));
      let onHand = 0, cost = 0, potential = 0;
      g.lots.forEach((it) => {
        const c = itemCalc(it);
        onHand += c.left;
        cost += c.left * c.unitCost;
        potential += c.potential;
      });
      const prices = Array.from(new Set(g.lots.map((it) => round2(it.resalePrice))));
      const places = Array.from(new Set(g.lots.map((it) => it.location.trim()).filter(Boolean)));
      const cats = Array.from(new Set(g.lots.map((it) => catKey(it.category))));
      const category = cats.length === 1 ? g.lots[0].category : '';
      return { ...g, onHand, cost, potential, prices, places, category, mixedCategory: cats.length > 1, haulDate };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  function invFootHTML(g) {
    const resell = g.prices.length === 1 ? money(g.prices[0]) : `${money(Math.min(...g.prices))}–${money(Math.max(...g.prices))}`;
    const below = g.lots.filter((it) => itemCalc(it).belowCost);
    const worstCost = below.reduce((m, it) => Math.max(m, itemCalc(it).unitCost), 0);
    if (!g.onHand) {
      const sold = g.lots.reduce((t, it) => ({ units: t.units + it.soldQty, total: t.total + it.soldTotal, profit: t.profit + itemCalc(it).profit }), { units: 0, total: 0, profit: 0 });
      return `<span>Sold ${sold.units} for ${money(sold.total)}</span>`
        + `<span class="${sold.profit < 0 ? 'bad' : 'good'}">Profit ${signedMoney(sold.profit)}${marginText(sold.profit, sold.total)}</span>`;
    }
    return `<span>Avg cost ${money(g.onHand ? g.cost / g.onHand : 0)}</span>`
      + `<span>Retail ${money(g.lots[0].unitRetail)}</span>`
      + `<span>Price ${resell}</span>`
      + `<span class="${g.potential < 0 ? 'bad' : 'good'}">Potential ${signedMoney(g.potential)}</span>`
      + (g.lots.length > 1 ? `<span class="muted">bought ${g.lots.length} times</span>` : '')
      + (below.length ? `<span class="below-cost">Below cost — price at ${money(minPrice(worstCost))}+ to break even</span>` : '');
  }

  // Lowest price that still covers cost once the commission comes out.
  const minPrice = (unitCost) => Math.ceil((unitCost / Math.max(0.01, 1 - pricing.commission / 100)) * 100) / 100;

  // Where one purchase of a product came from: its trip, or "Single item".
  function lotOrigin(it) {
    const h = it.haulId && data.hauls.find((x) => x.id === it.haulId);
    return h ? `${formatDate(h.date)} haul${h.name ? ` (${h.name})` : ''}` : 'Single item';
  }

  function invGroupHTML(g, index) {
    const lotLines = g.lots.map((it) => {
      const c = itemCalc(it);
      return `<li><span>${esc(lotOrigin(it))} · ${c.left} of ${it.qty} left · ${money(c.unitCost)} each${it.location ? ` · ${esc(it.location)}` : ''}${it.notes ? ` · ${esc(it.notes)}` : ''}</span>`
        + `<button type="button" class="inv-edit" data-action="edit-lot" data-item="${esc(it.id)}">Edit</button></li>`;
    }).join('');
    const soldOut = !g.onHand;
    const field = (label, cls, attrs, type = 'number') => `<label><span class="field-label">${label}</span><input type="${type}" class="${cls}" ${attrs}></label>`;
    return `
      <div class="b-item inv-item" data-group="${index}">
        <div class="inv-head">
          ${photoThumbHTML((g.lots.find((it) => it.photo) || {}).photo, g.name)}
          <span class="inv-name">${esc(g.name)}</span>
          ${soldOut ? '<span class="inv-onhand inv-soldout">Sold out</span>' : `<span class="inv-onhand">${g.onHand} on hand</span>`}
          ${soldOut ? '' : '<button type="button" class="remove-item" data-action="remove-stock" aria-label="Remove from inventory">&times;</button>'}
        </div>
        <div class="b-foot">${invFootHTML(g)}</div>
        <div class="b-grid b-grid-2 inv-cat-row">
          <label><span class="field-label">Name${g.lots.length > 1 ? ` (all ${g.lots.length})` : ''}</span><input type="text" class="inv-rename" maxlength="${MAX_TEXT}" value="${esc(g.name)}"></label>
          <label><span class="field-label">Category</span><select class="inv-category">${categoryOptionsHTML(g.category, g.mixedCategory)}</select></label>
        </div>
        ${g.lots.length === 1 ? `<button type="button" class="ghost-button inv-edit-one" data-action="edit-lot" data-item="${esc(g.lots[0].id)}">Edit details</button>` : ''}
        ${soldOut ? '' : `<div class="b-grid b-grid-2">
          <label><span class="field-label">Resell at (each)</span><input type="number" class="inv-resell" min="0" step="0.01" inputmode="decimal" value="${g.prices.length === 1 ? esc(blankIfZero(g.prices[0])) : ''}" placeholder="${g.prices.length === 1 ? '0.00' : 'mixed'}"></label>
          <label><span class="field-label">Location</span><input type="text" class="inv-location" maxlength="${MAX_TEXT}" value="${g.places.length === 1 ? esc(g.places[0]) : ''}" placeholder="${g.places.length > 1 ? esc(g.places.join(', ')) : 'e.g. Bin 3'}"></label>
        </div>
        <details class="b-sale">
          <summary>Record a sale</summary>
          <div class="b-grid">
            ${field('Qty sold', 'inv-sell-qty', `min="1" max="${g.onHand}" step="1" inputmode="numeric" value="1"`)}
            ${field('Sold for (total)', 'inv-sell-total', 'min="0" step="0.01" inputmode="decimal" placeholder="0.00"')}
            ${field('Fees & shipping', 'inv-sell-fees', `min="0" step="0.01" inputmode="decimal" placeholder="${pricing.commission ? `${pricing.commission}% commission` : '0.00'}"`)}
            ${field('Sold on', 'inv-sell-platform', `maxlength="${MAX_TEXT}" placeholder="e.g. eBay"`, 'text')}
          </div>
          ${pricing.commission ? `<label class="inv-sell-outside"><input type="checkbox" class="inv-sell-outside-box"> Sold outside the booth (no ${pricing.commission}% commission)</label>` : ''}
          <button type="button" class="add-button inv-sell-btn" data-action="record-sale">Record sale</button>
        </details>`}
        ${g.lots.length > 1 ? `<details class="inv-lots">
          <summary>Where it came from · edit (${g.lots.length})</summary>
          <ul>${lotLines}</ul>
        </details>` : ''}
      </div>`;
  }

  // The category picked from the chips above Inventory ('' = all).
  let invCategory = '';

  // What Inventory shows, and what the price list exports. Searching a
  // category's exact name shows only that category.
  function shownGroups() {
    const q = searchQuery();
    const mode = filterMode();
    const searchedCat = !invCategory && categoryNamed(q);
    const cat = invCategory || searchedCat;
    const inMode = (g) => (mode === 'stock' ? g.onHand > 0 : mode === 'sold' ? g.lots.some((it) => it.soldQty > 0) : true);
    const inCat = (g) => !cat || g.lots.some((it) => catKey(it.category) === catKey(cat));
    const matches = (g) => searchedCat || !q || has(g.name, q) || g.lots.some((it) => itemSearchMatch(it, q));
    const shown = invGroups
      .map((g, i) => ({ g, i }))
      .filter(({ g }) => inMode(g) && inCat(g) && matches(g));
    return { shown, category: cat };
  }

  function renderCategoryChips() {
    const list = allCategories();
    if (invCategory && !list.some((c) => catKey(c) === catKey(invCategory))) invCategory = '';
    catFilters.hidden = viewMode() !== 'inventory' || !list.length;
    const chip = (value, label) => `<label class="filter-chip"><input type="radio" name="inv-category" value="${esc(value)}"${catKey(value) === catKey(invCategory) ? ' checked' : ''}><span>${esc(label)}</span></label>`;
    catFilters.innerHTML = chip('', 'All categories') + list.map((c) => chip(c, c)).join('');
  }

  function renderInventory() {
    invGroups = buildInventory();
    renderCategoryChips();
    const q = searchQuery();
    const mode = filterMode();
    const { shown } = shownGroups();
    const none = { stock: 'Nothing in stock.', sold: 'Nothing sold yet.', all: 'Nothing here yet.' }[mode] || 'Nothing here yet.';
    invList.innerHTML = shown.length
      ? shown.map(({ g, i }) => invGroupHTML(g, i)).join('')
      : `<p class="empty-note">${q ? 'Nothing matches that search.' : invCategory ? `Nothing in ${esc(invCategory)} here.` : `${none} Add a haul or a single item to fill your inventory.`}</p>`;
    showPhotos(invList);
  }

  // Splits a sale across the oldest stock first, sharing the money and fees
  // by how many units came out of each trip.
  function recordSale(g, qty, total, fees, platform) {
    let left = qty, totalLeft = total, feesLeft = fees;
    const takes = [];
    g.lots.forEach((it) => {
      if (left <= 0) return;
      const take = Math.min(left, it.qty - it.soldQty);
      if (take > 0) { takes.push([it, take]); left -= take; }
    });
    takes.forEach(([it, take], n) => {
      const last = n === takes.length - 1;
      const share = last ? totalLeft : round2(total * (take / qty));
      const feeShare = last ? feesLeft : round2(fees * (take / qty));
      totalLeft = round2(totalLeft - share);
      feesLeft = round2(feesLeft - feeShare);
      it.soldQty += take;
      it.soldTotal = round2(it.soldTotal + share);
      it.fees = round2(it.fees + feeShare);
      it.soldDate = today();
      if (platform) it.platform = platform;
    });
  }

  invList.addEventListener('input', (e) => {
    const el = e.target;
    const card = el.closest('.inv-item');
    const g = card && invGroups[Number(card.dataset.group)];
    if (!g) return;
    if (el.classList.contains('inv-resell')) {
      if (el.value === '') return;
      g.lots.forEach((it) => { it.resalePrice = cleanMoney(el.value); });
      g.prices = [cleanMoney(el.value)];
      g.potential = g.lots.reduce((s, it) => s + itemCalc(it).potential, 0);
      $('.b-foot', card).innerHTML = invFootHTML(g);
    } else if (el.classList.contains('inv-sell-outside-box')) {
      $('.inv-sell-fees', card).placeholder = el.checked ? '0.00' : `${pricing.commission}% commission`;
      return;
    } else if (el.classList.contains('inv-location')) {
      g.lots.forEach((it) => { it.location = cleanText(el.value); });
      g.places = el.value.trim() ? [el.value.trim()] : [];
    } else {
      return;
    }
    save();
    renderSummary();
  });

  // Name and category apply to every purchase of the product at once.
  invList.addEventListener('change', async (e) => {
    const el = e.target;
    const card = el.closest('.inv-item');
    const g = card && invGroups[Number(card.dataset.group)];
    if (!g) return;
    if (el.classList.contains('inv-rename')) {
      const name = cleanText(el.value.trim());
      if (!name || name === g.name) { el.value = g.name; return; }
      // Renaming to a product you already have puts the two together.
      const joins = invGroups.find((o) => o !== g && o.key === productKey(name));
      g.lots.forEach((it) => { it.name = name; });
      save();
      render();
      showInvMessage(joins ? `Renamed and combined with ${joins.name}.` : `Renamed to ${name}.`, 'met');
    } else if (el.classList.contains('inv-category')) {
      let cat = el.value;
      if (cat === NEW_CATEGORY) {
        cat = await askNewCategory();
        if (!cat) { el.innerHTML = categoryOptionsHTML(g.category, g.mixedCategory); return; }
      }
      g.lots.forEach((it) => { it.category = cat; });
      save();
      render();
    }
  });

  catFilters.addEventListener('change', (e) => {
    if (e.target.name !== 'inv-category') return;
    invCategory = e.target.value;
    renderInventory();
  });

  // Adds a category to your list (or finds the one already there by that
  // name) and returns its name.
  function addCategory(text) {
    const name = cleanText(String(text || '').trim());
    if (!name) return '';
    const existing = categoryNamed(name);
    if (existing) return existing;
    categories = cleanCategories([...categories, name]);
    saveCategories();
    return name;
  }

  async function askNewCategory() {
    const name = await window.appPrompt({
      title: 'New category',
      input: { placeholder: 'e.g. Laundry', maxLength: MAX_TEXT },
      confirmText: 'Add', cancelText: 'Cancel',
    });
    return name ? addCategory(name) : '';
  }

  function saveCategories() {
    try { localStorage.setItem(CATEGORY_KEY, JSON.stringify(categories)); } catch (e) { /* storage unavailable */ }
    noteLocalChanges();
    scheduleSync();
    renderCategoryPanel();
  }

  // Categories that came from the Google Sheet.
  function loadCategories(list) {
    const next = cleanCategories(list);
    if (JSON.stringify(next) === JSON.stringify(categories)) return;
    categories = next;
    try { localStorage.setItem(CATEGORY_KEY, JSON.stringify(categories)); } catch (e) { /* storage unavailable */ }
    render();
  }

  // ---------- Categories panel ----------
  const categoryList = $('#category-list');
  const categoryNew = $('#category-new');

  function renderCategoryPanel() {
    const list = allCategories();
    $('#category-status').textContent = list.length ? `${list.length} categor${list.length === 1 ? 'y' : 'ies'}` : 'None yet';
    categoryList.innerHTML = list.map((c) => {
      const n = data.items.filter((it) => catKey(it.category) === catKey(c)).length;
      return `<li class="scenario-row" data-cat="${esc(c)}">
          <span class="cat-name">${esc(c)}<span class="cat-count">${n} item${n === 1 ? '' : 's'}</span></span>
          <button type="button" class="ghost-button inline-button" data-action="rename-cat">Rename</button>
          <button type="button" class="remove-item" data-action="delete-cat" aria-label="Delete ${esc(c)}">&times;</button>
        </li>`;
    }).join('');
  }

  function onAddCategory() {
    if (!categoryNew.value.trim()) return;
    addCategory(categoryNew.value);
    categoryNew.value = '';
    render();
  }
  $('#category-add').addEventListener('click', onAddCategory);
  categoryNew.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onAddCategory(); } });

  categoryList.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    const row = btn && btn.closest('[data-cat]');
    if (!row) return;
    const old = row.dataset.cat;
    const inIt = data.items.filter((it) => catKey(it.category) === catKey(old));
    if (btn.dataset.action === 'rename-cat') {
      const name = cleanText((await window.appPrompt({
        title: `Rename ${old}`,
        input: { value: old, maxLength: MAX_TEXT },
        confirmText: 'Rename', cancelText: 'Cancel',
      })) || '');
      if (!name || name === old) return;
      // Renaming to a category you already have puts the two together.
      const other = catKey(name) !== catKey(old) && categoryNamed(name);
      const target = other || name;
      categories = cleanCategories([...categories.filter((c) => catKey(c) !== catKey(old)), target]);
      inIt.forEach((it) => { it.category = target; });
      if (catKey(invCategory) === catKey(old)) invCategory = target;
    } else if (btn.dataset.action === 'delete-cat') {
      if (!await window.appConfirm({
        title: `Delete ${old}?`,
        message: inIt.length ? `Its ${inIt.length} item${inIt.length === 1 ? '' : 's'} stay in your inventory, just without a category.` : '',
        confirmText: 'Delete', cancelText: 'Keep', danger: true,
      })) return;
      categories = categories.filter((c) => catKey(c) !== catKey(old));
      inIt.forEach((it) => { it.category = ''; });
    } else {
      return;
    }
    if (inIt.length) save();
    saveCategories();
    render();
  });

  // Takes a product's unsold units out of stock. Units already sold stay, so
  // recorded sales and profit don't change; a lot with no sales is deleted.
  async function removeStock(g) {
    const trips = g.lots.length;
    if (!await window.appConfirm({
      title: `Remove ${g.onHand} × ${g.name}?`,
      message: `This takes ${g.onHand === 1 ? 'it' : 'them'} out of your purchases${trips > 1 ? ` (from ${trips} hauls)` : ''}. Any sales you've recorded for it are kept.`,
      confirmText: 'Remove', cancelText: 'Keep', danger: true,
    })) return;
    const lots = new Set(g.lots);
    data.items = data.items.filter((it) => !lots.has(it) || it.soldQty > 0);
    // Shrink what was paid along with the count, so the sold units keep
    // their cost each and the profit on them doesn't move.
    g.lots.forEach((it) => {
      if (it.soldQty <= 0 || it.soldQty >= it.qty) return;
      const share = it.soldQty / it.qty;
      it.totalPaid = round2(it.totalPaid * share);
      it.taxPaid = round2(it.taxPaid * share);
      it.qty = it.soldQty;
    });
    save();
    render();
    showInvMessage(`Removed ${g.onHand} × ${g.name} from inventory.`, 'met');
  }

  invList.addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-action="edit-lot"]');
    if (editBtn) {
      const it = data.items.find((i) => i.id === editBtn.dataset.item);
      if (it) openItemEditor(it);
      return;
    }
    const photoBtn = e.target.closest('[data-action="photo"]');
    if (photoBtn) {
      const g = invGroups[Number(photoBtn.closest('.inv-item').dataset.group)];
      if (g) openPhoto(g.lots);
      return;
    }
    const removeBtn = e.target.closest('[data-action="remove-stock"]');
    if (removeBtn) {
      const g = invGroups[Number(removeBtn.closest('.inv-item').dataset.group)];
      if (g) removeStock(g);
      return;
    }
    const btn = e.target.closest('[data-action="record-sale"]');
    if (!btn) return;
    const card = btn.closest('.inv-item');
    const g = invGroups[Number(card.dataset.group)];
    if (!g) return;
    const qty = Math.round(num($('.inv-sell-qty', card).value));
    if (qty < 1 || qty > g.onHand) {
      showInvMessage(`Enter a quantity from 1 to ${g.onHand}.`, 'unmet');
      return;
    }
    const total = cleanMoney($('.inv-sell-total', card).value);
    const feesInput = $('.inv-sell-fees', card).value;
    // Blank fees + a commission set = the commission is the fee, unless it
    // sold outside the booth, where the booth takes nothing.
    const outside = $('.inv-sell-outside-box', card)?.checked;
    const fees = feesInput === '' && !outside ? round2(total * (pricing.commission / 100)) : cleanMoney(feesInput);
    recordSale(g, qty, total, fees, cleanText($('.inv-sell-platform', card).value.trim()));
    save();
    renderSummary();
    renderInventory();
    showInvMessage(`Recorded: ${qty} × ${g.name} sold for ${money(total)}${fees ? ` (${money(fees)} fees)` : ''}.`, 'met');
  });

  let invMessageTimer = null;
  function showInvMessage(text, tone) {
    invMessage.hidden = false;
    invMessage.textContent = text;
    invMessage.className = `threshold-status ${tone}`;
    clearTimeout(invMessageTimer);
    invMessageTimer = setTimeout(() => { invMessage.hidden = true; }, 5000);
  }

  searchInput.addEventListener('input', () => {
    if (viewMode() === 'inventory') renderInventory(); else renderHauls();
  });

  // ---------- Customer price list ----------
  // A plain PDF of what's in stock — each item's own photo, name, retail,
  // your price and how many are left — with the heading on every page.
  // It's built here rather than printed, since tablets add the web address
  // to printouts. Costs and profit are never included.
  let pdfLoading = null;
  function loadPdfMaker() {
    if (window.jspdf) return Promise.resolve();
    if (!pdfLoading) {
      pdfLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'vendor/jspdf.umd.min.js';
        s.onload = resolve;
        s.onerror = () => { pdfLoading = null; reject(new Error('The PDF maker didn’t load — check your connection and try again.')); };
        document.head.appendChild(s);
      });
    }
    return pdfLoading;
  }

  // Turns a photo (yours or a product database's) into a small JPEG the PDF
  // can hold. Resolves null if it won't load.
  function photoForPdf(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.referrerPolicy = 'no-referrer';
      const timer = setTimeout(() => resolve(null), 8000);
      img.onload = () => {
        clearTimeout(timer);
        try {
          const scale = Math.min(1, 240 / Math.max(img.naturalWidth, img.naturalHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve({ data: canvas.toDataURL('image/jpeg', 0.8), w: canvas.width, h: canvas.height });
        } catch (e) {
          resolve(null);
        }
      };
      img.onerror = () => { clearTimeout(timer); resolve(null); };
      img.src = src;
    });
  }

  async function exportPriceSheet() {
    // Exactly what Inventory is showing (search and category), in stock only.
    invGroups = buildInventory();
    const { shown, category } = shownGroups();
    const groups = shown.map(({ g }) => g).filter((g) => g.onHand > 0);
    if (!groups.length) { showInvMessage('Nothing in stock here to put on a price list.', 'unmet'); return; }
    const btn = $('#export-sheet');
    btn.disabled = true;
    showInvMessage('Making your price list…', '');
    try {
      await loadPdfMaker();
      const rows = await Promise.all(groups.map(async (g) => {
        const lots = g.lots.filter((it) => itemCalc(it).left > 0);
        const prices = Array.from(new Set(lots.map((it) => round2(it.resalePrice))));
        const retail = Math.max(...lots.map((it) => it.unitRetail));
        const photo = (lots.find((it) => it.photo) || g.lots.find((it) => it.photo) || {}).photo;
        const src = !photo ? null : IMAGE_RE.test(photo) ? photo : await photoStore.get(photo);
        return {
          name: g.name,
          retail: retail ? money(retail) : '-',
          price: prices.length === 1 ? money(prices[0]) : `${money(Math.min(...prices))} - ${money(Math.max(...prices))}`,
          qty: String(g.onHand),
          img: src ? await photoForPdf(src) : null,
        };
      }));

      const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'letter' });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const M = 36;
      const PHOTO = 60;
      const ROW_PAD = 6;
      // Right edges of the number columns, and where the name starts.
      const colQty = pageW - M;
      const colPrice = colQty - 50;
      const colRetail = colPrice - 80;
      const colName = M + PHOTO + 12;
      const nameWidth = colRetail - 80 - colName;
      const dateText = formatDate(today());

      const header = () => {
        let y = M;
        doc.setFont('helvetica', 'bold').setFontSize(18).text(category ? `Available items: ${category}` : 'Available items', M, y + 14);
        doc.setFont('helvetica', 'normal').setFontSize(10).text(dateText, M, y + 30);
        y += 50;
        doc.setFont('helvetica', 'bold').setFontSize(10);
        doc.text('Photo', M, y);
        doc.text('Item', colName, y);
        doc.text('Retail', colRetail, y, { align: 'right' });
        doc.text('My price', colPrice, y, { align: 'right' });
        doc.text('Qty', colQty, y, { align: 'right' });
        y += 6;
        doc.setDrawColor(0).setLineWidth(1).line(M, y, pageW - M, y);
        return y;
      };

      let y = header();
      doc.setDrawColor(160).setLineWidth(0.5);
      rows.forEach((r) => {
        doc.setFont('helvetica', 'normal').setFontSize(11);
        const lines = doc.splitTextToSize(r.name, nameWidth).slice(0, 4);
        const rowH = Math.max(PHOTO, lines.length * 14) + ROW_PAD * 2;
        if (y + rowH > pageH - M) {
          doc.addPage();
          y = header();
          doc.setFont('helvetica', 'normal').setFontSize(11);
        }
        const top = y + ROW_PAD;
        const mid = y + rowH / 2;
        if (r.img) {
          const s = PHOTO / Math.max(r.img.w, r.img.h);
          const w = r.img.w * s, h = r.img.h * s;
          doc.addImage(r.img.data, 'JPEG', M + (PHOTO - w) / 2, top + (PHOTO - h) / 2, w, h);
        }
        doc.text(lines, colName, mid - ((lines.length - 1) * 14) / 2 + 4);
        doc.text(r.retail, colRetail, mid + 4, { align: 'right' });
        doc.text(r.price, colPrice, mid + 4, { align: 'right' });
        doc.text(r.qty, colQty, mid + 4, { align: 'right' });
        y += rowH;
        doc.setDrawColor(160).setLineWidth(0.5).line(M, y, pageW - M, y);
      });

      // Characters a file name can't hold are left out.
      const fileCat = category.replace(/[^\w ,&'-]/g, '').trim();
      doc.save(`Price list${fileCat ? ` ${fileCat}` : ''} ${today()}.pdf`);
      showInvMessage('Price list saved.', 'met');
    } catch (err) {
      showInvMessage(err.message || 'Couldn’t make the price list.', 'unmet');
    } finally {
      btn.disabled = false;
    }
  }

  $('#export-sheet').addEventListener('click', exportPriceSheet);

  // ---------- Booth pricing controls ----------
  const pricingPct = $('#pricing-pct');
  const pricingCommission = $('#pricing-commission');
  const pricingRent = $('#pricing-rent');
  const pricingRentPeriod = $('#pricing-rent-period');
  const pricingRentStart = $('#pricing-rent-start');
  const pricingStatus = $('#pricing-status');
  const rentStatus = $('#rent-status');

  function renderPricingStatus() {
    pricingStatus.textContent = `${pricing.pctOff}% off retail`
      + (pricing.commission ? ` · ${pricing.commission}% commission` : '')
      + (pricing.rent ? ` · ${money(pricing.rent)}/${pricing.rentPeriod === 'week' ? 'wk' : 'mo'} rent` : '');
  }

  // How this rent period's sales stack up against its rent.
  function renderRentStatus() {
    if (!pricing.rent) { rentStatus.hidden = true; return; }
    rentStatus.hidden = false;
    const rent = rentSoFar();
    if (!pricing.rentStart) {
      rentStatus.textContent = 'Add the date your booth started to track rent against your sales.';
      rentStatus.className = 'threshold-status unmet';
      return;
    }
    if (!rent.periods) {
      rentStatus.textContent = `Rent starts ${formatDate(pricing.rentStart)}.`;
      rentStatus.className = 'threshold-status unmet';
      return;
    }
    const earned = data.items
      .filter((it) => it.soldQty > 0 && it.soldDate >= rent.periodStart)
      .reduce((s, it) => s + itemCalc(it).profit, 0);
    const label = `This ${pricing.rentPeriod} (since ${formatDate(rent.periodStart)})`;
    const left = pricing.rent - earned;
    rentStatus.textContent = left > 0.004
      ? `${label}: ${money(earned)} profit vs ${money(pricing.rent)} rent — ${money(left)} to go.`
      : `${label}: rent covered — ${signedMoney(-left)} profit after rent.`;
    rentStatus.className = `threshold-status ${left > 0.004 ? 'unmet' : 'met'}`;
  }

  function onPricingInput() {
    pricing = cleanPricing({
      pctOff: pricingPct.value === '' ? pricing.pctOff : pricingPct.value,
      commission: pricingCommission.value,
      rent: pricingRent.value,
      rentPeriod: pricingRentPeriod.value,
      rentStart: pricingRentStart.value,
    });
    try { localStorage.setItem(PRICING_KEY, JSON.stringify(pricing)); } catch (e) { /* storage unavailable */ }
    renderPricingStatus();
    render();
    noteLocalChanges();
    scheduleSync();
  }

  function fillPricingInputs() {
    pricingPct.value = pricing.pctOff;
    pricingCommission.value = pricing.commission || '';
    pricingRent.value = pricing.rent || '';
    pricingRentPeriod.value = pricing.rentPeriod;
    pricingRentStart.value = pricing.rentStart;
    renderPricingStatus();
  }

  // Booth pricing that came from the Google Sheet.
  function loadPricing(p) {
    const next = cleanPricing(p);
    if (JSON.stringify(next) === JSON.stringify(pricing)) return;
    pricing = next;
    try { localStorage.setItem(PRICING_KEY, JSON.stringify(pricing)); } catch (e) { /* storage unavailable */ }
    fillPricingInputs();
    render();
  }
  [pricingPct, pricingCommission, pricingRent, pricingRentPeriod, pricingRentStart]
    .forEach((el) => el.addEventListener('change', onPricingInput));

  $('#pricing-apply').addEventListener('click', async () => {
    const inStock = data.items.filter((it) => it.soldQty < it.qty && it.unitRetail > 0);
    if (!inStock.length) return;
    if (!await window.appConfirm({
      title: `Reprice ${inStock.length} item${inStock.length === 1 ? '' : 's'}?`,
      message: `Everything in stock will be set to ${pricing.pctOff}% off retail. Any prices you set by hand will be replaced.`,
      confirmText: 'Reprice', cancelText: 'Cancel',
    })) return;
    inStock.forEach((it) => { it.resalePrice = boothPrice(it.unitRetail); });
    save();
    render();
  });

  function viewMode() {
    const checked = viewInputs.find((r) => r.checked);
    return checked ? checked.value : 'trips';
  }

  function setView(mode) {
    const inv = mode === 'inventory';
    viewInputs.forEach((r) => { r.checked = r.value === (inv ? 'inventory' : 'trips'); });
    // Trips get "+ New trip"; Inventory gets "+ Single item".
    addHaulBtn.hidden = inv;
    $('#add-loose').hidden = !inv;
    $('#export-sheet').hidden = !inv;
    catFilters.hidden = true;
    filterInputs.forEach((r) => { r.checked = r.value === viewFilter[inv ? 'inventory' : 'trips']; });
    haulList.hidden = inv;
    invList.hidden = !inv;
    if (!inv) invMessage.hidden = true;
    try { localStorage.setItem(VIEW_KEY, inv ? 'inventory' : 'trips'); } catch (e) { /* storage unavailable */ }
    render();
  }

  viewInputs.forEach((r) => r.addEventListener('change', () => setView(viewMode())));

  function render() {
    renderSummary();
    renderCategoryPanel();
    if (viewMode() === 'inventory') renderInventory(); else renderHauls();
    refreshItemEditor();
  }

  // ---------- Editing ----------
  const NUMBER_FIELDS = new Set(['qty', 'unitRetail', 'totalPaid', 'resalePrice', 'soldQty', 'soldTotal', 'fees']);

  haulList.addEventListener('input', (e) => {
    const el = e.target;
    const haulEl = el.closest('.haul');
    if (!haulEl) return;
    const haul = data.hauls.find((h) => h.id === haulEl.dataset.haul);
    if (!haul && haulEl.dataset.haul !== '') return;

    if (el.dataset.h) {
      if (!haul) return;
      const v = el.dataset.h === 'date' ? (DATE_RE.test(el.value) ? el.value : haul.date) : cleanText(el.value);
      haul[el.dataset.h] = v;
      $('.haul-title', haulEl).textContent = haulTitle(haul);
      $('.haul-date', haulEl).textContent = formatDate(haul.date);
      save();
      return;
    }

    if (applyItemEdit(el, el.closest('.b-item'))) {
      $('.haul-totals', haulEl).textContent = haulTotalsText(haulEl.dataset.haul);
    }
  });

  // Applies a change typed into an item's details, wherever they're shown.
  function applyItemEdit(el, itemEl) {
    const f = el.dataset.f;
    const it = f && itemEl && data.items.find((i) => i.id === itemEl.dataset.item);
    if (!it) return null;
    if (f === 'category' && el.value === NEW_CATEGORY) {
      askNewCategory().then((name) => {
        if (name && data.items.includes(it)) { it.category = name; save(); }
        el.innerHTML = categoryOptionsHTML(it.category);
      });
      return null;
    }

    // A haul item's price is typed before tax; any tax already spread onto it stays.
    if (f === 'paidBeforeTax') it.totalPaid = round2(cleanMoney(el.value) + it.taxPaid);
    else if (f === 'qty') it.qty = Math.max(1, Math.round(num(el.value) || 1));
    else if (f === 'soldQty') it.soldQty = Math.max(0, Math.round(num(el.value)));
    else if (NUMBER_FIELDS.has(f)) it[f] = cleanMoney(el.value);
    // Tax is part of what was paid, so it can't be more than the total.
    if (f === 'totalPaid') it.taxPaid = Math.min(it.taxPaid, it.totalPaid);
    else if (f === 'soldDate') it.soldDate = DATE_RE.test(el.value) ? el.value : '';
    else if (f === 'upc') it.upc = cleanUpc(el.value);
    else it[f] = cleanText(el.value);
    it.soldQty = Math.min(it.soldQty, it.qty);

    save();
    $('.b-foot', itemEl).innerHTML = itemFootHTML(it);
    $('.b-item-name', itemEl).textContent = it.name || 'Unnamed item';
    $('.b-item-meta', itemEl).textContent = itemMetaText(it);
    renderSummary();
    return it;
  }

  // Once something is marked sold, fill in today's date if none is set yet.
  function fillSoldDate(el) {
    const itemEl = el.closest('.b-item');
    if (!itemEl || (el.dataset.f !== 'soldQty' && el.dataset.f !== 'soldTotal')) return;
    const it = data.items.find((i) => i.id === itemEl.dataset.item);
    if (!it || it.soldDate || !(it.soldQty > 0 || it.soldTotal > 0)) return;
    it.soldDate = today();
    $('input[data-f="soldDate"]', itemEl).value = it.soldDate;
    if (el.dataset.f === 'soldQty' && it.soldQty > it.qty) el.value = it.qty;
    save();
  }
  haulList.addEventListener('change', (e) => fillSoldDate(e.target));

  // The photo, barcode-scan and delete buttons in an item's details.
  // Returns true if it was one of those.
  async function itemAction(btn, e) {
    const it = data.items.find((i) => i.id === (btn.closest('.b-item') || {}).dataset?.item);
    if (!it) return false;
    const action = btn.dataset.action;
    if (action === 'photo') {
      openPhoto([it]);
    } else if (action === 'scan-upc') {
      e.preventDefault(); // don't let the tap fall through to the label's input
      scanItemBarcode(it);
    } else if (action === 'delete-item') {
      if (!await window.appConfirm({
        title: `Delete ${it.name ? `“${it.name}”` : 'this item'}?`,
        message: 'This can’t be undone.',
        confirmText: 'Delete', cancelText: 'Keep', danger: true,
      })) return true;
      data.items = data.items.filter((i) => i !== it);
      save();
      render();
    } else {
      return false;
    }
    return true;
  }

  haulList.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const haulEl = btn.closest('.haul');
    const haulId = haulEl && haulEl.dataset.haul;

    if (btn.dataset.action === 'toggle-haul') {
      toggleOpen(haulEl, openHauls, haulId, '.haul-body');
    } else if (btn.dataset.action === 'toggle-item') {
      const itemEl = btn.closest('.b-item');
      toggleOpen(itemEl, openItems, itemEl.dataset.item, '.b-item-body');
    } else if (btn.dataset.action === 'add-item') {
      const it = cleanItem({ haulId, qty: 1 });
      data.items.push(it);
      openItems.add(it.id);
      save();
      render();
      focusItem(it.id);
    } else if (btn.dataset.action === 'spread-tax') {
      spreadTax(haulId, haulEl);
    } else if (btn.dataset.action === 'scan-items') {
      scanIntoHaul(haulId);
    } else if (btn.dataset.action === 'delete-haul') {
      const count = itemsOf(haulId).length;
      if (!await window.appConfirm({
        title: 'Delete this whole haul?',
        message: (count ? `Its ${count} item${count === 1 ? '' : 's'} will be deleted too. ` : '') + 'This can’t be undone.',
        confirmText: 'Delete haul', cancelText: 'Keep', danger: true,
      })) return;
      data.hauls = data.hauls.filter((h) => h.id !== haulId);
      data.items = data.items.filter((i) => i.haulId !== haulId);
      save();
      render();
    } else {
      itemAction(btn, e);
    }
  });

  // Shares a receipt's tax across a haul's items by price, leaving out the
  // share that belongs to whatever was kept for personal use. Works from each
  // item's price before tax, so running it again replaces the tax rather
  // than adding it twice. When everything was free (a $0 subtotal), the tax
  // is split evenly by quantity instead.
  function spreadTax(haulId, haulEl) {
    const items = itemsOf(haulId);
    const receiptTax = cleanMoney($('.haul-receipt-tax', haulEl).value);
    const kept = cleanMoney($('.haul-receipt-kept', haulEl).value);
    const bases = items.map((it) => round2(it.totalPaid - it.taxPaid));
    const subtotal = round2(bases.reduce((s, b) => s + b, 0));
    const note = (text, tone = '') => {
      const el = $(`.haul[data-haul="${CSS.escape(haulId)}"] .haul-receipt-note`);
      if (el) { el.textContent = text; el.className = `haul-receipt-note ${tone}`; }
    };
    if (!items.length) {
      note('Add this haul’s items first.', 'bad');
      return;
    }
    const weights = subtotal ? bases : items.map((it) => it.qty);
    const weightTotal = weights.reduce((s, w) => s + w, 0);
    const tax = round2(receiptTax * (subtotal + kept ? subtotal / (subtotal + kept) : 1));
    items.forEach((it, n) => {
      it.taxPaid = round2(tax * (weights[n] / weightTotal));
      it.totalPaid = round2(bases[n] + it.taxPaid);
    });
    // Rounding pennies land on the priciest item so the shares add up exactly.
    const off = round2(tax - items.reduce((s, it) => s + it.taxPaid, 0));
    if (off) {
      const top = items.reduce((a, b, n) => (weights[n] > weights[items.indexOf(a)] ? b : a), items[0]);
      top.taxPaid = round2(top.taxPaid + off);
      top.totalPaid = round2(top.totalPaid + off);
    }
    save();
    render();
    note(receiptTax
      ? `Added ${money(tax)} of the ${money(receiptTax)} tax across ${items.length} item${items.length === 1 ? '' : 's'}${kept ? ' (the rest goes with what you kept)' : ''}.`
      : 'Tax cleared from these items.', 'good');
  }

  // ---------- Item pop-up ----------
  // Full details for one item, opened from Inventory or "+ Single item".
  let itemDialog = null;
  let editing = null;
  let editingNew = false;

  const blankItem = (it) => !it.name && !it.upc && !it.photo && !it.unitRetail && !it.totalPaid
    && !it.location && !it.notes && !it.soldQty && !it.soldTotal;

  function refreshItemEditor() {
    if (!itemDialog || !itemDialog.open || !editing) return;
    if (!data.items.includes(editing)) { itemDialog.close(); return; }
    $('.item-origin', itemDialog).textContent = editingNew ? 'Goes straight into your Inventory — no haul needed.' : `From: ${lotOrigin(editing)}`;
    $('.item-editor', itemDialog).innerHTML = itemHTML(editing, true);
    showPhotos(itemDialog);
  }

  function openItemEditor(it, isNew = false) {
    if (!itemDialog) {
      itemDialog = document.createElement('dialog');
      itemDialog.className = 'scan-dialog item-dialog';
      itemDialog.setAttribute('aria-labelledby', 'item-dialog-title');
      itemDialog.innerHTML = `
        <div class="scan-body">
          <div class="scan-head">
            <div>
              <h2 class="scan-title" id="item-dialog-title"></h2>
              <p class="item-origin"></p>
            </div>
            <button type="button" class="scan-close" data-close aria-label="Close">&times;</button>
          </div>
          <div class="item-editor"></div>
        </div>
      `;
      itemDialog.addEventListener('input', (e) => applyItemEdit(e.target, e.target.closest('.b-item')));
      itemDialog.addEventListener('change', (e) => fillSoldDate(e.target));
      itemDialog.addEventListener('click', (e) => {
        if (e.target === itemDialog || e.target.closest('[data-close]')) { itemDialog.close(); return; }
        const btn = e.target.closest('[data-action]');
        if (btn && btn.dataset.action !== 'toggle-item') itemAction(btn, e);
      });
      itemDialog.addEventListener('close', () => {
        const it = editing;
        const wasNew = editingNew;
        editing = null;
        if (!it) return;
        // A new single item closed without anything filled in isn't kept.
        if (wasNew && data.items.includes(it) && blankItem(it)) {
          data.items = data.items.filter((i) => i !== it);
          save();
        }
        if (wasNew && data.items.includes(it)) {
          searchInput.value = '';
          setView('inventory');
          showInvMessage(`Added ${it.name || 'your item'} to Inventory.`, 'met');
        } else {
          render();
        }
      });
      document.body.appendChild(itemDialog);
    }
    editing = it;
    editingNew = isNew;
    $('.scan-title', itemDialog).textContent = isNew ? 'Add a single item' : 'Item details';
    itemDialog.showModal();
    refreshItemEditor();
    if (isNew && !it.name) $('.item-name', itemDialog).focus();
  }

  filterInputs.forEach((r) => r.addEventListener('change', () => {
    viewFilter[viewMode()] = r.value;
    render();
  }));

  // Puts the cursor in a just-added item's name box.
  function focusItem(id) {
    const el = $(`.b-item[data-item="${CSS.escape(id)}"] .item-name`);
    if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); }
  }

  $('#add-loose').addEventListener('click', () => {
    const it = cleanItem({ haulId: '', qty: 1 });
    data.items.push(it);
    save();
    openItemEditor(it, true);
  });

  addHaulBtn.addEventListener('click', () => {
    const haul = cleanHaul({ date: today(), store: 'Dollar General' });
    const it = cleanItem({ haulId: haul.id, qty: 1 });
    data.hauls.unshift(haul);
    data.items.push(it);
    openHauls.add(haul.id);
    openItems.add(it.id);
    viewFilter.trips = 'all';
    searchInput.value = '';
    save();
    setView('trips');
    focusItem(it.id);
  });

  // ---------- Barcode scanning ----------
  // Scanned codes are saved on each item. A product's name comes from your own
  // earlier purchases first, then from the free Open Food Facts databases
  // (food, household and beauty), which only ever see the barcode number.
  const NAMES_KEY = 'therealtotal:upc-names';
  const MAX_NAMES = 1000;
  const LOOKUP_HOSTS = ['world.openfoodfacts.org', 'world.openproductsfacts.org', 'world.openbeautyfacts.org'];

  let lookedUpNames = {};
  try {
    const raw = JSON.parse(localStorage.getItem(NAMES_KEY));
    if (raw && typeof raw === 'object') {
      Object.entries(raw).forEach(([code, v]) => {
        const name = typeof v === 'string' ? v : v && v.name;
        const image = v && typeof v.image === 'string' && IMAGE_RE.test(v.image) ? v.image : '';
        if (/^\d{6,14}$/.test(code) && typeof name === 'string' && name) lookedUpNames[code] = { name: cleanText(name), image };
      });
    }
  } catch (e) { lookedUpNames = {}; }

  function rememberName(code, name, image) {
    delete lookedUpNames[code];
    lookedUpNames[code] = { name, image: image || '' };
    const codes = Object.keys(lookedUpNames);
    codes.slice(0, Math.max(0, codes.length - MAX_NAMES)).forEach((c) => delete lookedUpNames[c]);
    try { localStorage.setItem(NAMES_KEY, JSON.stringify(lookedUpNames)); } catch (e) { /* storage unavailable */ }
  }

  const cleanField = (v) => String(v || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

  // Brand, name, size and photo from a database record. The full name reads
  // like "Gain Detergent 92 oz".
  function productDetails(p) {
    const brand = cleanField(String(p.brands || '').split(',')[0]);
    const title = cleanField(p.product_name);
    const size = cleanField(p.quantity);
    let name = title ? (brand && !title.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${title}` : title) : brand;
    if (name && size && !name.toLowerCase().includes(size.toLowerCase())) name += ` ${size}`;
    const image = [p.image_front_small_url, p.image_small_url].find((u) => typeof u === 'string' && IMAGE_RE.test(u)) || '';
    return { name: name.slice(0, MAX_TEXT), brand, size, image };
  }

  // Resolves to the product's details when found, { name: '' } when no
  // database has it, or { offline: true } when none could be reached.
  // `cached` skips the network for a name looked up before.
  async function lookUpOnline(code, cached = true) {
    if (cached && lookedUpNames[code]) return { ...lookedUpNames[code] };
    let answered = false;
    const tries = LOOKUP_HOSTS.map(async (host) => {
      const ctrl = new AbortController();
      const stopper = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(`https://${host}/api/v2/product/${code.padStart(13, '0')}.json?fields=product_name,brands,quantity,image_front_small_url,image_small_url`, {
          credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: ctrl.signal,
        });
        answered = true;
        const body = await res.json();
        const product = body && body.status === 1 && body.product ? productDetails(body.product) : null;
        if (!product || !product.name) throw new Error('not found');
        return product;
      } finally {
        clearTimeout(stopper);
      }
    });
    try {
      const product = await Promise.any(tries);
      rememberName(code, product.name, product.image);
      return product;
    } catch (e) {
      if (lookedUpNames[code]) return { ...lookedUpNames[code] };
      return answered ? { name: '' } : { offline: true };
    }
  }

  // The newest item you've saved with this barcode, to reuse its name and price.
  const knownItem = (code, except) => data.items.slice().reverse().find((i) => i !== except && i.upc === code && i.name);

  // The scan icon in an item's Barcode box: fills in that one item's barcode,
  // plus its name, photo and retail price if those are still empty.
  function scanItemBarcode(it) {
    window.openScanner({
      title: it.name ? `Scan the barcode for ${it.name}` : 'Scan this item’s barcode',
      hint: 'Line the barcode up inside the box.',
      onCode: async (code) => {
        if (!data.items.includes(it)) return { close: true };
        it.upc = code;
        const known = knownItem(code, it);
        if (known) {
          if (!it.name) it.name = known.name;
          if (!it.photo) it.photo = known.photo;
          if (!it.unitRetail && known.unitRetail) it.unitRetail = known.unitRetail;
        }
        if (!it.name || !it.photo) {
          const found = await lookUpOnline(code);
          if (!it.name && found.name) it.name = cleanText(found.name);
          if (!it.photo) it.photo = cleanPhoto(found.image);
        }
        save();
        render();
        return { close: true };
      },
    });
  }

  // `onAdded` runs as soon as the item is in the trip, before any online lookup.
  async function addScannedItem(haulId, code, onAdded = () => {}) {
    if (haulId !== '' && !data.hauls.some((h) => h.id === haulId)) return { text: 'That haul is gone.', tone: 'unmet', close: true };
    const same = data.items.find((i) => i.haulId === haulId && i.upc === code);
    if (same) {
      same.qty += 1;
      save();
      render();
      onAdded(same);
      return { text: `${same.name || code} — now ${same.qty} in this haul.`, tone: 'met' };
    }
    // A new trip starts with one empty row; scanning replaces it.
    const blank = (i) => i.haulId === haulId && haulId !== '' && !i.name && !i.upc && !i.unitRetail && !i.totalPaid && !i.soldQty && !i.location && !i.notes;
    data.items = data.items.filter((i) => !blank(i));
    const known = knownItem(code);
    const it = cleanItem({
      haulId, qty: 1, upc: code,
      name: known ? known.name : (lookedUpNames[code] || {}).name || '',
      photo: known && known.photo ? known.photo : (lookedUpNames[code] || {}).image || '',
      unitRetail: known ? known.unitRetail : 0,
    });
    data.items.push(it);
    save();
    render();
    onAdded(it);
    if (it.name) return { text: `Added ${it.name}${known && known.unitRetail ? ` (retail ${money(known.unitRetail)})` : ''}.`, tone: 'met' };

    const found = await lookUpOnline(code);
    if (found.name && data.items.includes(it) && !it.name) {
      it.name = cleanText(found.name);
      if (!it.photo) it.photo = cleanPhoto(found.image);
      save();
      render();
      return { text: `Added ${it.name}.`, tone: 'met' };
    }
    return {
      text: found.offline
        ? `Added ${code}. Couldn’t look up its name (no connection?) — type it in after.`
        : `Added ${code}. It’s not in the free database, so type its name in after.`,
      tone: 'unmet',
    };
  }

  // A run of scans into one trip. The scanner lists everything scanned so
  // far, with – and + to change how many without scanning again.
  // `getHaulId` returns the trip to add to, creating it if need be.
  function scanSession(getHaulId) {
    const panel = document.createElement('div');
    panel.className = 'scan-list-wrap';
    // Item id -> how many it had before this scanning session (0 = new).
    const scanned = new Map();

    function renderList() {
      const rows = Array.from(scanned.keys())
        .map((id) => data.items.find((i) => i.id === id))
        .filter(Boolean)
        .reverse();
      const units = rows.reduce((n, it) => n + it.qty - scanned.get(it.id), 0);
      panel.innerHTML = rows.length ? `
        <p class="scan-list-head">Scanned so far: ${units} item${units === 1 ? '' : 's'}</p>
        <ul class="scan-list">${rows.map((it) => `
          <li data-id="${esc(it.id)}">
            <span class="scan-list-name">${esc(it.name || `Barcode ${it.upc}`)}</span>
            <span class="scan-qty">
              <button type="button" data-step="-1" aria-label="One less">&minus;</button>
              <span class="scan-qty-n">${it.qty}</span>
              <button type="button" data-step="1" aria-label="One more">+</button>
              <button type="button" class="scan-remove" data-step="remove" aria-label="Remove from this scan">&times;</button>
            </span>
          </li>`).join('')}
        </ul>` : '';
    }

    panel.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-step]');
      if (!btn) return;
      const id = btn.closest('li').dataset.id;
      const it = data.items.find((i) => i.id === id);
      if (!it) return;
      const before = scanned.get(id);
      if (btn.dataset.step === 'remove') {
        // Undo everything this scan added: a new item goes away, an item the
        // trip already had goes back to its old count.
        if (before === 0) data.items = data.items.filter((i) => i !== it);
        else it.qty = before;
        scanned.delete(id);
        window.setScannerStatus(`Removed ${it.name || `barcode ${it.upc}`}.`);
      } else if (btn.dataset.step === '1') {
        it.qty += 1;
      } else if (it.qty > Math.max(1, before)) {
        it.qty -= 1;
      } else if (before === 0) {
        // Taking a just-scanned item down from 1 removes it again.
        data.items = data.items.filter((i) => i !== it);
        scanned.delete(id);
      } else {
        return; // never below what the trip had before scanning
      }
      it.soldQty = Math.min(it.soldQty, it.qty);
      save();
      render();
      renderList();
    });

    async function onCode(code) {
      const result = await addScannedItem(getHaulId(), code, (it) => {
        if (!scanned.has(it.id)) scanned.set(it.id, it.qty - 1);
        renderList();
      });
      renderList(); // picks up a name found online
      return result;
    }

    return { panel, onCode, count: () => scanned.size };
  }

  // Opens a trip and jumps to it, at the first item that still needs a name.
  function showHaul(haulId) {
    openHauls.add(haulId);
    const unnamed = itemsOf(haulId).filter((it) => !it.name);
    unnamed.forEach((it) => openItems.add(it.id));
    render();
    const haulEl = $(`.haul[data-haul="${CSS.escape(haulId)}"]`);
    if (!haulEl) return;
    const blank = unnamed.length && $(`.b-item[data-item="${CSS.escape(unnamed[0].id)}"]`, haulEl);
    (blank || haulEl).scrollIntoView({ block: blank ? 'center' : 'start' });
  }

  function scanIntoHaul(haulId) {
    const session = scanSession(() => haulId);
    window.openScanner({
      title: 'Scan items into this haul',
      hint: 'Scan each item. Use + for more than one of the same thing. Tap × when you’re finished.',
      panel: session.panel,
      onCode: session.onCode,
      onClose: () => showHaul(haulId),
    });
  }

  // ---------- Product card (barcode icon in the search bar) ----------
  // Scanning here shows what the product is and what you have of it.
  let productDialog = null;

  function buildProductDialog() {
    productDialog = document.createElement('dialog');
    productDialog.className = 'scan-dialog product-dialog';
    productDialog.setAttribute('aria-labelledby', 'product-title');
    productDialog.innerHTML = `
      <div class="scan-body">
        <div class="scan-head">
          <h2 class="scan-title" id="product-title">Product</h2>
          <button type="button" class="scan-close" data-p="close" aria-label="Close">&times;</button>
        </div>
        <div class="product-card">
          <img class="product-img" alt="" referrerpolicy="no-referrer" hidden>
          <div class="product-text">
            <p class="product-name"></p>
            <p class="product-meta"></p>
            <p class="product-code"></p>
          </div>
        </div>
        <p class="threshold-status product-owned"></p>
        <div class="product-actions">
          <button type="button" class="add-button" data-p="show">Show my items</button>
          <button type="button" class="add-button add-button-secondary" data-p="add">Add to a new haul</button>
          <button type="button" class="add-button add-button-secondary" data-p="add-loose">Add without a haul</button>
          <button type="button" class="ghost-button" data-p="again">Scan another</button>
        </div>
      </div>
    `;
    productDialog.addEventListener('click', (e) => {
      if (e.target === productDialog) productDialog.close();
    });
    document.body.appendChild(productDialog);
  }

  function ownedSummary(code) {
    const mine = data.items.filter((i) => i.upc === code);
    if (!mine.length) return { text: 'You haven’t bought this yet.', tone: 'unmet', count: 0 };
    const left = mine.reduce((n, it) => n + itemCalc(it).left, 0);
    const bought = mine.reduce((n, it) => n + it.qty, 0);
    const places = Array.from(new Set(mine.map((i) => i.location.trim()).filter(Boolean)));
    const haulDate = new Map(data.hauls.map((h) => [h.id, h.date]));
    const lastDate = mine.map((i) => haulDate.get(i.haulId) || '').sort().pop();
    const newest = mine[mine.length - 1];
    const parts = [
      left ? `You have ${left} in stock${places.length ? ` (${places.join(', ')})` : ''}` : `All ${bought} sold`,
      `bought ${bought} in all`,
    ];
    if (newest.qty && newest.totalPaid) parts.push(`paid ${money(newest.totalPaid / newest.qty)} each last time`);
    if (lastDate) parts.push(`last bought ${formatDate(lastDate)}`);
    return { text: parts.join(' · ') + '.', tone: 'met', count: mine.length };
  }

  function showProduct(code, product) {
    if (!productDialog) buildProductDialog();
    const known = knownItem(code);
    const name = product.name || (known && known.name) || '';
    const photo = (known && known.photo) || product.image || '';
    const img = $('.product-img', productDialog);
    img.hidden = !photo;
    img.removeAttribute('src');
    delete img.dataset.photoId;
    if (validId(photo)) { img.dataset.photoId = photo; showPhotos(productDialog); } else if (photo) img.src = photo;
    $('.product-name', productDialog).textContent = name || 'Unknown product';
    const meta = [product.brand, product.size].filter(Boolean).join(' · ');
    $('.product-meta', productDialog).textContent = product.name
      ? meta
      : product.offline
        ? 'Couldn’t reach the product database (no connection?).'
        : `Not in the free product database.${known ? ' Name from your purchases.' : ''}`;
    $('.product-code', productDialog).textContent = `Barcode ${code}`;
    const owned = ownedSummary(code);
    const ownedEl = $('.product-owned', productDialog);
    ownedEl.textContent = owned.text;
    ownedEl.className = `threshold-status product-owned ${owned.tone}`;
    $('[data-p="show"]', productDialog).hidden = !owned.count;

    $$('[data-p]', productDialog).forEach((btn) => {
      btn.onclick = () => {
        const action = btn.dataset.p;
        productDialog.close();
        if (action === 'show') {
          searchInput.value = code;
          render();
          (viewMode() === 'inventory' ? invList : haulList).scrollIntoView({ block: 'start' });
        } else if (action === 'add' || action === 'add-loose') {
          let haulId = '';
          if (action === 'add') {
            const haul = cleanHaul({ date: today(), store: 'Dollar General' });
            data.hauls.unshift(haul);
            haulId = haul.id;
          }
          const it = cleanItem({ haulId, qty: 1, upc: code, name, photo, unitRetail: known ? known.unitRetail : 0 });
          data.items.push(it);
          if (!haulId) { save(); openItemEditor(it, true); return; }
          openHauls.add(haulId);
          openItems.add(it.id);
          viewFilter.trips = 'all';
          searchInput.value = '';
          save();
          setView('trips');
          const el = $(`.b-item[data-item="${CSS.escape(it.id)}"]`);
          if (el) el.scrollIntoView({ block: 'center' });
        } else if (action === 'again') {
          scanFromSearch('lookup');
        }
      };
    });
    productDialog.showModal();
  }

  // The barcode icon in the search bar: look products up, or add them to a
  // new purchase. The last mode used is remembered on this device.
  const SCAN_MODE_KEY = 'therealtotal:scan-mode';
  const SCAN_INTO_KEY = 'therealtotal:scan-into';
  const ADD_HINT = 'Scan each item. Use + for more than one of the same thing. Tap × when you’re finished.';
  const SCAN_MODES = {
    lookup: ['Look up a product', 'Scan any product to see what it is and whether you have it.'],
    add: ['Add to a new haul', ADD_HINT],
    loose: ['Add without a haul', ADD_HINT],
  };

  function scanFromSearch(startMode) {
    let mode = startMode || 'lookup';
    try { if (!startMode) mode = localStorage.getItem(SCAN_MODE_KEY) === 'add' ? 'add' : 'lookup'; } catch (e) { /* storage unavailable */ }
    // Add mode can put items in a new trip or straight into inventory.
    let into = 'trip';
    try { into = localStorage.getItem(SCAN_INTO_KEY) === 'none' ? 'none' : 'trip'; } catch (e) { /* storage unavailable */ }
    const titleFor = () => SCAN_MODES[mode === 'add' && into === 'none' ? 'loose' : mode];
    let found = null;
    let haulId = null;
    let addedLoose = false;
    // The new purchase is only made once something is actually scanned.
    const session = scanSession(() => {
      if (into === 'none') { addedLoose = true; return ''; }
      if (!haulId || !data.hauls.some((h) => h.id === haulId)) {
        const haul = cleanHaul({ date: today(), store: 'Dollar General' });
        data.hauls.unshift(haul);
        haulId = haul.id;
      }
      return haulId;
    });

    const top = document.createElement('div');
    top.innerHTML = `
      <div class="segmented scan-modes" role="radiogroup" aria-label="What scanning does">
        <label class="segment"><input type="radio" name="scan-mode" value="lookup"><span>Look up</span></label>
        <label class="segment"><input type="radio" name="scan-mode" value="add"><span>Add</span></label>
      </div>
      <div class="filter-chips scan-into" role="radiogroup" aria-label="Add to">
        <label class="filter-chip"><input type="radio" name="scan-into" value="trip"><span>New haul</span></label>
        <label class="filter-chip"><input type="radio" name="scan-into" value="none"><span>No haul</span></label>
      </div>
    `;
    const intoRow = $('.scan-into', top);
    intoRow.hidden = mode !== 'add';
    $$('input[name="scan-mode"]', top).forEach((r) => {
      r.checked = r.value === mode;
      r.addEventListener('change', () => {
        mode = r.value;
        try { localStorage.setItem(SCAN_MODE_KEY, mode); } catch (e) { /* storage unavailable */ }
        intoRow.hidden = mode !== 'add';
        window.setScannerText(...titleFor());
      });
    });
    $$('input[name="scan-into"]', top).forEach((r) => {
      r.checked = r.value === into;
      r.addEventListener('change', () => {
        into = r.value;
        try { localStorage.setItem(SCAN_INTO_KEY, into); } catch (e) { /* storage unavailable */ }
        window.setScannerText(...titleFor());
      });
    });

    window.openScanner({
      title: titleFor()[0],
      hint: titleFor()[1],
      top,
      panel: session.panel,
      onCode: async (code) => {
        if (mode === 'add') return session.onCode(code);
        found = { code, product: await lookUpOnline(code, false) };
        return { close: true };
      },
      onClose: () => {
        if (found) {
          showProduct(found.code, found.product);
        } else if (haulId && !itemsOf(haulId).length) {
          // Everything scanned was taken back out, so drop the empty purchase.
          data.hauls = data.hauls.filter((h) => h.id !== haulId);
          save();
          render();
        }
        if (!found && session.count() && (addedLoose || (haulId && itemsOf(haulId).length))) {
          searchInput.value = '';
          if (haulId && itemsOf(haulId).length) {
            viewFilter.trips = 'all';
            setView('trips');
            showHaul(haulId);
          } else {
            setView('inventory');
            showInvMessage('Added to your Inventory.', 'met');
          }
        }
      },
    });
  }

  $('#bought-scan').addEventListener('click', () => scanFromSearch());

  // ---------- Receipt -> Bought ----------
  // The calculator sends its finished receipt here as a new trip.
  document.addEventListener('realtotal:save-haul', (e) => {
    const lines = (e.detail && Array.isArray(e.detail.items)) ? e.detail.items : [];
    if (!lines.length) return;
    const haul = cleanHaul({ date: today(), store: 'Dollar General' });
    data.hauls.unshift(haul);
    openHauls.add(haul.id);
    lines.forEach((line) => {
      const it = cleanItem({ ...line, haulId: haul.id });
      if (it) data.items.push(it);
    });
    viewFilter.trips = 'all';
    searchInput.value = '';
    save();
    setView('trips');
    setTab('bought');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  const BARCODE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8v8M10 8v8M13 8v8M16.5 8v8"/></svg>';

  // ---------- Item photos ----------
  const CAMERA_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
  const photoStore = window.photoStore;

  // A database photo loads straight from its link; one you took is filled in
  // from this device by showPhotos() once the HTML is on the page.
  function photoThumbHTML(photo, label) {
    if (!photo) return `<button type="button" class="b-photo b-photo-empty" data-action="photo" aria-label="Add a photo" title="Add a photo">${CAMERA_ICON}</button>`;
    const img = IMAGE_RE.test(photo)
      ? `<img alt="" src="${esc(photo)}" referrerpolicy="no-referrer">`
      : `<img alt="" data-photo-id="${esc(photo)}">`;
    return `<button type="button" class="b-photo" data-action="photo" aria-label="Photo of ${esc(label || 'this item')}">${img}</button>`;
  }

  function showPhotos(root) {
    $$('img[data-photo-id]', root).forEach(async (img) => {
      const id = img.dataset.photoId;
      const photo = await photoStore.get(id);
      if (img.dataset.photoId !== id) return;
      if (photo) img.src = photo;
      // Not on this device yet — it arrives with the next photo sync.
      const box = img.closest('.b-photo');
      if (box) box.classList.toggle('b-photo-missing', !photo);
    });
  }

  // Ids of the photos you took that items still use.
  const photoRefs = () => Array.from(new Set(data.items.map((i) => i.photo).filter(validId))).sort();

  // Deletes photos from this device once no item uses them.
  let photoCleanupTimer = null;
  function schedulePhotoCleanup() {
    clearTimeout(photoCleanupTimer);
    photoCleanupTimer = setTimeout(async () => {
      const used = new Set(photoRefs());
      (await photoStore.ids()).forEach((id) => { if (!used.has(id)) photoStore.remove(id); });
    }, 5000);
  }

  // Opens the in-app camera (with "Choose from photos") and puts the photo
  // on every item given.
  async function pickPhoto(items) {
    const name = (items.find((it) => it.name) || {}).name;
    let photo;
    try {
      photo = await photoStore.capture(name ? `Photo of ${name}` : 'Take a photo');
    } catch (err) {
      showInvMessage(err.message, 'unmet');
      return;
    }
    const targets = items.filter((it) => data.items.includes(it));
    if (!photo || !targets.length) return;
    const id = newId();
    const kept = await photoStore.put(id, photo);
    targets.forEach((it) => { it.photo = id; });
    save();
    render();
    if (!kept) showInvMessage('Photo added, but this phone’s storage is full, so it may not stay after you close the app. It’s kept in your sheet if sync is on.', 'unmet');
  }

  let photoDialog = null;

  function openPhoto(items) {
    const photo = (items.find((it) => it.photo) || {}).photo;
    if (!photo) { pickPhoto(items); return; }
    if (!photoDialog) {
      photoDialog = document.createElement('dialog');
      photoDialog.className = 'scan-dialog photo-dialog';
      photoDialog.setAttribute('aria-labelledby', 'photo-title');
      photoDialog.innerHTML = `
        <div class="scan-body">
          <div class="scan-head">
            <h2 class="scan-title" id="photo-title"></h2>
            <button type="button" class="scan-close" data-ph="close" aria-label="Close">&times;</button>
          </div>
          <img class="photo-big" alt="" referrerpolicy="no-referrer">
          <p class="photo-source"></p>
          <div class="product-actions">
            <button type="button" class="add-button" data-ph="new">Take a new photo</button>
            <button type="button" class="ghost-button" data-ph="remove">Remove photo</button>
          </div>
        </div>
      `;
      photoDialog.addEventListener('click', (e) => { if (e.target === photoDialog) photoDialog.close(); });
      document.body.appendChild(photoDialog);
    }
    const name = (items.find((it) => it.name) || {}).name || 'Item photo';
    $('.scan-title', photoDialog).textContent = name;
    const img = $('.photo-big', photoDialog);
    img.removeAttribute('src');
    delete img.dataset.photoId;
    if (IMAGE_RE.test(photo)) img.src = photo;
    else { img.dataset.photoId = photo; showPhotos(photoDialog); }
    $('.photo-source', photoDialog).textContent = IMAGE_RE.test(photo)
      ? 'From the free product database. Take your own to replace it.'
      : items.length > 1 ? `Your photo · used for all ${items.length} hauls of this item.` : 'Your photo.';
    $$('[data-ph]', photoDialog).forEach((btn) => {
      btn.onclick = () => {
        photoDialog.close();
        if (btn.dataset.ph === 'new') pickPhoto(items);
        else if (btn.dataset.ph === 'remove') {
          items.forEach((it) => { it.photo = ''; });
          save();
          render();
        }
      };
    });
    photoDialog.showModal();
  }

  // Photos sync on their own, after the rest: each is uploaded once, and any
  // this device is missing are downloaded. The sheet drops photos no item
  // uses whenever purchases are saved.
  let photoSyncing = false;
  let photoSyncAgain = false;
  let lastPhotoRefs = null;

  async function syncPhotos(force = false) {
    if (!sync || !pulled) return;
    const refs = photoRefs();
    if (!force && refs.join() === lastPhotoRefs) return;
    if (photoSyncing) { photoSyncAgain = true; return; }
    photoSyncing = true;
    try {
      const remote = new Set((await callSheet(sync, 'photos-list')).ids || []);
      const local = new Set(await photoStore.ids());
      const up = refs.filter((id) => local.has(id) && !remote.has(id));
      for (let i = 0; i < up.length; i += 5) {
        const batch = (await Promise.all(up.slice(i, i + 5).map(async (id) => ({ id, data: await photoStore.get(id) }))))
          .filter((p) => p.data);
        if (batch.length) await callSheet(sync, 'photos-put', { photos: batch });
      }
      const down = refs.filter((id) => !local.has(id) && remote.has(id));
      for (let i = 0; i < down.length; i += 10) {
        const got = (await callSheet(sync, 'photos-get', { ids: down.slice(i, i + 10) })).photos || {};
        await Promise.all(Object.entries(got).map(([id, photo]) =>
          (validId(id) && typeof photo === 'string' && photoStore.PHOTO_RE.test(photo) ? photoStore.put(id, photo) : null)));
      }
      if (down.length) showPhotos(document);
      lastPhotoRefs = refs.join();
    } catch (err) {
      setSyncStatus('error', `Photo sync error: ${err.message}`);
    } finally {
      photoSyncing = false;
      if (photoSyncAgain) { photoSyncAgain = false; syncPhotos(true); }
    }
  }

  // ---------- Google Sheet sync ----------
  function loadSync() {
    try {
      const s = JSON.parse(localStorage.getItem(SYNC_KEY));
      return s && SCRIPT_URL_RE.test(s.url) && typeof s.key === 'string' && s.key ? { url: s.url, key: s.key } : null;
    } catch (e) { return null; }
  }

  let sync = loadSync();
  // Every sync pulls the sheet first and merges it in before pushing, so a
  // device never overwrites what another one saved.
  let pulled = false;
  let syncTimer = null;
  let syncing = false;
  let syncAgain = false;

  // ---------- Calculator build ----------
  // The calculator (script.js) owns its working copy and saved scenarios;
  // the sync just carries them to and from the sheet's "Calculator" tab as
  // one JSON string. Booth pricing, your categories and the merge times
  // below ride along in the same string.
  const calc = window.calcSync;
  document.addEventListener('calc:change', () => {
    noteLocalChanges();
    scheduleSync();
  });

  function remoteBuild(body) {
    if (typeof body.calc !== 'string' || !body.calc) return null;
    try {
      const build = JSON.parse(body.calc);
      return build && typeof build === 'object' ? build : null;
    } catch (e) { return null; }
  }

  // ---------- Merging, one record at a time ----------
  // Each haul, item and saved scenario — plus the calculator's working copy
  // booth pricing and the category list — remembers when it last changed on this device. A sync
  // keeps whichever side changed each one most recently, and deleted ones
  // are remembered so another device can't bring them back.
  const META_KEY = 'therealtotal:sync-meta';
  const BUILD_KEY = '~build';
  const PRICING_KEY_SYNC = '~pricing';
  const CATEGORIES_KEY_SYNC = '~categories';
  const META_KEY_RE = /^(?:[his]:[A-Za-z0-9_-]{1,40}|~build|~pricing|~categories)$/;
  // Long enough for every device to have synced since.
  const FORGET_DELETED_MS = 90 * 24 * 60 * 60 * 1000;

  function cleanTimes(raw) {
    const out = {};
    if (raw && typeof raw === 'object') {
      Object.entries(raw).slice(0, 3 * MAX_ROWS).forEach(([k, t]) => {
        if (META_KEY_RE.test(k) && Number.isFinite(t) && t > 0) out[k] = t;
      });
    }
    return out;
  }

  function cleanSeen(raw) {
    const out = {};
    if (raw && typeof raw === 'object') {
      Object.entries(raw).forEach(([k, f]) => { if (META_KEY_RE.test(k) && typeof f === 'string') out[k] = f; });
    }
    return out;
  }

  // A short fingerprint of a record, to notice when it changes.
  function fingerprint(value) {
    const s = JSON.stringify(value);
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  // Every synced record on this device, by key.
  function localRecords() {
    const out = new Map();
    const c = calc.get();
    data.hauls.forEach((h) => out.set(`h:${h.id}`, h));
    data.items.forEach((it) => out.set(`i:${it.id}`, it));
    c.scenarios.forEach((sc) => out.set(`s:${sc.id}`, sc));
    out.set(BUILD_KEY, c.build);
    out.set(PRICING_KEY_SYNC, pricing);
    out.set(CATEGORIES_KEY_SYNC, categories);
    return out;
  }

  // Marks everything as it is now as already seen, without counting it as
  // changed. Also forgets times for records that are gone, and deletions
  // old enough that every device has caught up.
  function markSeen() {
    const records = localRecords();
    meta.seen = {};
    records.forEach((rec, k) => { meta.seen[k] = fingerprint(rec); });
    Object.keys(meta.stamps).forEach((k) => { if (!records.has(k)) delete meta.stamps[k]; });
    const cutoff = Date.now() - FORGET_DELETED_MS;
    Object.keys(meta.deleted).forEach((k) => { if (meta.deleted[k] < cutoff || records.has(k)) delete meta.deleted[k]; });
    saveMeta();
  }

  function saveMeta() {
    try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) { /* storage unavailable */ }
  }

  let meta = null;
  try {
    const m = JSON.parse(localStorage.getItem(META_KEY));
    if (m && typeof m === 'object') meta = { stamps: cleanTimes(m.stamps), deleted: cleanTimes(m.deleted), seen: cleanSeen(m.seen) };
  } catch (e) { meta = null; }
  // First run: what's here already has no change time, so on a tie with
  // the sheet the sheet's copy is kept, as before.
  if (!meta) {
    meta = { stamps: {}, deleted: {}, seen: {} };
    markSeen();
  }

  // Stamps whatever changed since last time; called on every edit.
  function noteLocalChanges() {
    const now = Date.now();
    const records = localRecords();
    let changed = false;
    records.forEach((rec, k) => {
      const f = fingerprint(rec);
      if (meta.seen[k] === f) return;
      meta.seen[k] = f;
      meta.stamps[k] = now;
      delete meta.deleted[k];
      changed = true;
    });
    Object.keys(meta.seen).forEach((k) => {
      if (records.has(k)) return;
      delete meta.seen[k];
      delete meta.stamps[k];
      meta.deleted[k] = now;
      changed = true;
    });
    if (changed) saveMeta();
  }

  // Combines this device with what the sheet sent, applies it here, and
  // says whether the sheet needs the result.
  function mergeWithSheet(body) {
    const remoteData = cleanData(body);
    const build = remoteBuild(body) || {};
    const remoteMeta = build.sync && typeof build.sync === 'object' ? build.sync : {};
    const remoteStamps = cleanTimes(remoteMeta.stamps);
    const remoteDeleted = cleanTimes(remoteMeta.deleted);

    const remote = new Map();
    remoteData.hauls.forEach((h) => remote.set(`h:${h.id}`, h));
    remoteData.items.forEach((it) => remote.set(`i:${it.id}`, it));
    (Array.isArray(build.scenarios) ? build.scenarios : []).forEach((sc) => {
      if (sc && typeof sc === 'object' && validId(sc.id)) remote.set(`s:${sc.id}`, sc);
    });
    if (build.build && typeof build.build === 'object') remote.set(BUILD_KEY, build.build);
    if (build.pricing && typeof build.pricing === 'object') remote.set(PRICING_KEY_SYNC, cleanPricing(build.pricing));
    if (Array.isArray(build.categories)) remote.set(CATEGORIES_KEY_SYNC, cleanCategories(build.categories));

    const local = localRecords();
    Object.entries(remoteDeleted).forEach(([k, t]) => { if (!(meta.deleted[k] >= t)) meta.deleted[k] = t; });

    let sheetBehind = !build.sync;
    const kept = new Map();
    const stamps = {};
    const keys = [...local.keys(), ...[...remote.keys()].filter((k) => !local.has(k))];
    keys.forEach((k) => {
      const mine = local.get(k);
      const theirs = remote.get(k);
      const mineAt = mine ? meta.stamps[k] || 0 : -1;
      const theirsAt = theirs ? remoteStamps[k] || 0 : -1;
      const at = Math.max(mineAt, theirsAt, 0);
      if (meta.deleted[k] >= at) {
        if (theirs) sheetBehind = true;
        return;
      }
      // A tie goes to the sheet, so a fix typed straight into it still
      // comes through. The same record from either side keeps this device's
      // copy, so open editors aren't disturbed.
      const same = mine && theirs && fingerprint(mine) === fingerprint(theirs);
      kept.set(k, theirsAt >= mineAt && !same ? theirs : mine);
      if (!theirs || (!same && mineAt > theirsAt)) sheetBehind = true;
      if (at) stamps[k] = at;
    });

    // Apply it here.
    const pick = (prefix) => [...kept].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
    const hauls = pick('h:');
    const haulIds = new Set(hauls.map((h) => h.id));
    const items = pick('i:').filter((it) => it.haulId === '' || haulIds.has(it.haulId));
    if (fingerprint(data) !== fingerprint({ hauls, items })) {
      data = { hauls, items };
      persist();
      render();
    }
    if (kept.has(PRICING_KEY_SYNC)) loadPricing(kept.get(PRICING_KEY_SYNC));
    if (kept.has(CATEGORIES_KEY_SYNC)) loadCategories(kept.get(CATEGORIES_KEY_SYNC));
    const nextCalc = { build: kept.get(BUILD_KEY) || calc.get().build, scenarios: pick('s:') };
    if (fingerprint(calc.get()) !== fingerprint(nextCalc)) calc.load(nextCalc);

    meta.stamps = stamps;
    markSeen();
    const sorted = (o) => JSON.stringify(Object.entries(o).sort());
    return sheetBehind || sorted(meta.stamps) !== sorted(remoteStamps) || sorted(meta.deleted) !== sorted(remoteDeleted);
  }

  function setSyncStatus(state, text) {
    syncStatusEl.textContent = text;
    syncStatusEl.className = `sync-status ${state}`;
  }

  function showMessage(text, tone = '') {
    syncMessage.hidden = !text;
    syncMessage.textContent = text || '';
    syncMessage.className = `threshold-status ${tone}`;
  }

  function renderSyncPanel() {
    syncSetup.hidden = !!sync;
    syncConnected.hidden = !sync;
    if (!sync) setSyncStatus('off', 'Not connected');
  }

  async function callSheet(conn, action, payload = {}) {
    let res;
    try {
      res = await fetch(conn.url, {
        method: 'POST',
        // text/plain keeps this a "simple" request with no CORS preflight,
        // which Apps Script web apps can't answer.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ key: conn.key, action, ...payload }),
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
    } catch (err) {
      throw new Error("Couldn't reach the sheet — check your connection.");
    }
    let body;
    try { body = await res.json(); } catch (err) {
      throw new Error("The sheet didn't answer. Check that the web app is deployed with access set to “Anyone”.");
    }
    if (!body || body.error) {
      throw new Error(body && body.error === 'unauthorized' ? 'Wrong secret key.' : String((body && body.error) || 'Unknown error').slice(0, 200));
    }
    return body;
  }

  function sheetRows() {
    const r2 = (n) => round2(n);
    return {
      hauls: data.hauls.map((h) => {
        const t = totalsFor(itemsOf(h.id));
        return { ...h, itemCount: t.units, retail: r2(t.retail), paid: r2(t.paid), tax: r2(t.tax), saved: r2(t.saved), soldTotal: r2(t.soldTotal), profit: r2(t.profit) };
      }),
      items: data.items.map((it) => {
        const c = itemCalc(it);
        return { ...it, unitCost: r2(c.unitCost), status: STATUS_LABELS[c.status], profit: r2(c.profit) };
      }),
      calc: JSON.stringify({ ...calc.get(), pricing, categories, sync: { stamps: meta.stamps, deleted: meta.deleted } }),
    };
  }

  const syncedText = () => `Synced ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

  // Pull, merge, and push back only if the sheet is missing something.
  async function syncNow() {
    if (!sync) return;
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    clearTimeout(syncTimer);
    setSyncStatus('busy', 'Syncing…');
    const first = !pulled;
    try {
      const body = await callSheet(sync, 'pull');
      noteLocalChanges();
      const needPush = mergeWithSheet(body);
      pulled = true;
      if (needPush) await callSheet(sync, 'push', sheetRows());
      setSyncStatus('ok', syncedText());
      syncPhotos(first);
    } catch (err) {
      setSyncStatus('error', `Sync error: ${err.message}`);
    } finally {
      syncing = false;
      if (syncAgain) { syncAgain = false; syncNow(); }
    }
  }

  // Collapses a burst of typing into one sync ~1.2s after the last change.
  function scheduleSync() {
    if (!sync) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, 1200);
  }

  // Coming back to the app picks up what another device changed meanwhile.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && sync) syncNow();
  });

  $('#sync-connect').addEventListener('click', async () => {
    const url = syncUrlInput.value.trim();
    const key = syncKeyInput.value.trim();
    if (!SCRIPT_URL_RE.test(url)) {
      showMessage('That link doesn’t look right — it should start with https://script.google.com/macros/s/ and end with /exec.', 'unmet');
      return;
    }
    if (key.length < 16) {
      showMessage('Use a secret key at least 16 characters long (tap “Generate a key”).', 'unmet');
      return;
    }
    const conn = { url, key };
    showMessage('Connecting…');
    try {
      await callSheet(conn, 'pull');
    } catch (err) {
      showMessage(err.message, 'unmet');
      return;
    }
    // Only remember the connection once it's proven to work. The first sync
    // combines this device's data with the sheet's, keeping both.
    sync = conn;
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(conn)); } catch (e) { /* storage unavailable */ }
    syncUrlInput.value = '';
    syncKeyInput.value = '';
    showMessage('');
    renderSyncPanel();
    await syncNow();
  });

  $('#sync-generate').addEventListener('click', async () => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const key = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    syncKeyInput.type = 'text';
    syncKeyInput.value = key;
    try {
      await navigator.clipboard.writeText(key);
      showMessage('New key made and copied. Paste it as the SECRET script property (step 4), then come back and tap Connect.', 'met');
    } catch (e) {
      showMessage('New key made — copy it from the box above into the SECRET script property (step 4).', 'met');
    }
  });

  async function copyScript(done) {
    try {
      const res = await fetch('google-sheet-sync/Code.gs', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      await navigator.clipboard.writeText(await res.text());
      showMessage(done, 'met');
    } catch (e) {
      showMessage('Couldn’t copy automatically — use the “open it here” link instead.', 'unmet');
    }
  }
  $('#sync-copy-script').addEventListener('click', () => copyScript('Script copied. Paste it into Apps Script (step 3).'));
  $('#sync-copy-update').addEventListener('click', () => copyScript('Script copied. Paste it over the old code in Apps Script, then deploy a new version (steps 2 and 3).'));

  $('#sync-now').addEventListener('click', () => {
    syncNow();
  });

  $('#sync-disconnect').addEventListener('click', async () => {
    if (!await window.appConfirm({
      title: 'Disconnect this device?',
      message: 'Your purchases and scenarios stay on this device and in the sheet; they just stop syncing here.',
      confirmText: 'Disconnect', cancelText: 'Stay connected',
    })) return;
    try { localStorage.removeItem(SYNC_KEY); } catch (e) { /* storage unavailable */ }
    sync = null;
    pulled = false;
    clearTimeout(syncTimer);
    showMessage('');
    renderSyncPanel();
  });

  // ---------- Init ----------
  let startTab = 'calc';
  try { startTab = localStorage.getItem(TAB_KEY) || 'calc'; } catch (e) { /* storage unavailable */ }
  setTab(startTab);
  fillPricingInputs();
  let startView = 'trips';
  try { startView = localStorage.getItem(VIEW_KEY) || 'trips'; } catch (e) { /* storage unavailable */ }
  setView(startView);
  renderSyncPanel();
  if (sync) syncNow();
})();
