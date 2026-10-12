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

  function loadPricing() {
    try { return cleanPricing(JSON.parse(localStorage.getItem(PRICING_KEY)) || {}); } catch (e) { return { ...DEFAULT_PRICING }; }
  }

  let pricing = loadPricing();
  const boothPrice = (unitRetail) => round2(unitRetail * (1 - pricing.pctOff / 100));
  const afterCommission = (amount) => amount * (1 - pricing.commission / 100);

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
    summaryEl.innerHTML = `
      ${tile('Spent', money(t.paid), `${t.units} item${t.units === 1 ? '' : 's'} · incl. ${money(t.tax)} tax`)}
      ${tile('Saved', money(t.saved), `${pct(t.saved, t.retail)}% off ${money(t.retail)} retail`, 'good')}
      ${tile('Sold', money(t.soldTotal), `${t.soldUnits} item${t.soldUnits === 1 ? '' : 's'} sold`)}
      ${(() => {
        const rent = rentSoFar();
        if (!rent.paid) return tile('Profit', signedMoney(t.profit), 'after cost & fees', t.profit < 0 ? 'bad' : 'good');
        const net = t.profit - rent.paid;
        return tile('Profit', signedMoney(net), `after cost, fees & ${money(rent.paid)} rent`, net < 0 ? 'bad' : 'good');
      })()}
      ${tile('In stock', `${t.leftUnits}`, `${money(t.leftCost)} cost · ${signedMoney(t.potential)} potential`)}
    `;
    renderRentStatus();
  }

  function haulTotalsText(haulId) {
    const t = totalsFor(itemsOf(haulId));
    return `${t.units} item${t.units === 1 ? '' : 's'} · Paid ${money(t.paid)} · Retail ${money(t.retail)} · Saved ${pct(t.saved, t.retail)}%`
      + (t.soldUnits ? ` · Profit ${signedMoney(t.profit)}` : '');
  }

  const STATUS_LABELS = { unsold: 'In stock', partial: 'Partly sold', sold: 'Sold' };

  function itemFootHTML(it) {
    const c = itemCalc(it);
    const parts = [
      `<span class="status-pill ${c.status}">${STATUS_LABELS[c.status]}</span>`,
      `<span>Cost ${money(c.unitCost)} each</span>`,
      `<span class="${pct(c.saved, c.retail) >= 50 ? 'good' : 'bad'}">Saved ${pct(c.saved, c.retail)}%</span>`,
    ];
    if (it.soldQty > 0) parts.push(`<span class="${c.profit < 0 ? 'bad' : 'good'}">Profit ${signedMoney(c.profit)}</span>`);
    if (c.left > 0) parts.push(`<span class="muted">${c.left > 1 ? `${c.left} left` : '1 left'} · potential ${signedMoney(c.potential)}</span>`);
    if (c.belowCost) parts.push(`<span class="below-cost">Below cost — price at ${money(minPrice(c.unitCost))}+ to break even</span>`);
    return parts.join('');
  }

  function itemHTML(it) {
    const field = (label, f, value, attrs = 'min="0" step="0.01" inputmode="decimal"', type = 'number') => `
      <label><span class="field-label">${label}</span><input type="${type}" data-f="${f}" value="${esc(value)}" ${attrs}></label>`;
    return `
      <div class="b-item" data-item="${esc(it.id)}">
        <div class="item-row-top">
          ${photoThumbHTML(it.photo, it.name)}
          <input type="text" class="item-name" data-f="name" placeholder="Item name" maxlength="${MAX_TEXT}" value="${esc(it.name)}">
          <button type="button" class="remove-item" data-action="delete-item" aria-label="Delete item">&times;</button>
        </div>
        <div class="b-grid">
          ${field('Qty', 'qty', it.qty, 'min="1" step="1" inputmode="numeric"')}
          ${field('Retail each', 'unitRetail', blankIfZero(it.unitRetail))}
          ${field('Paid total (with tax)', 'totalPaid', blankIfZero(it.totalPaid))}
          ${field('Resell at (each)', 'resalePrice', blankIfZero(it.resalePrice))}
        </div>
        <div class="b-grid b-grid-3">
          <label><span class="field-label">Location</span><input type="text" data-f="location" placeholder="e.g. Bin 3" maxlength="${MAX_TEXT}" value="${esc(it.location)}"></label>
          <label><span class="field-label">Notes</span><input type="text" data-f="notes" placeholder="e.g. dented box" maxlength="${MAX_TEXT}" value="${esc(it.notes)}"></label>
          <label><span class="field-label">Barcode</span><input type="text" data-f="upc" inputmode="numeric" placeholder="Scan or type" maxlength="14" autocomplete="off" value="${esc(it.upc)}"></label>
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
      </div>`;
  }

  // Items added straight to inventory, with no trip.
  function looseHTML(items) {
    return `
      <article class="haul haul-loose" data-haul="">
        <div class="haul-head">
          <h3 class="haul-loose-title">Not from a trip</h3>
        </div>
        <p class="haul-totals">${esc(haulTotalsText(''))}</p>
        <div class="haul-items">${items.map(itemHTML).join('')}</div>
        <div class="haul-add">
          <button type="button" class="add-button add-button-secondary" data-action="add-item">+ Add item</button>
          <button type="button" class="add-button add-button-secondary" data-action="scan-items">Scan items</button>
        </div>
      </article>`;
  }

  function haulHTML(h, items) {
    return `
      <article class="haul" data-haul="${esc(h.id)}">
        <div class="haul-head">
          <div class="haul-fields">
            <input type="date" data-h="date" value="${esc(h.date)}" aria-label="Trip date">
            <input type="text" data-h="name" placeholder="Trip name (optional)" maxlength="${MAX_TEXT}" value="${esc(h.name)}" aria-label="Trip name">
            <input type="text" data-h="store" placeholder="Store" maxlength="${MAX_TEXT}" value="${esc(h.store)}" aria-label="Store">
          </div>
          <button type="button" class="ghost-button" data-action="delete-haul">Delete trip</button>
        </div>
        <p class="haul-totals">${esc(haulTotalsText(h.id))}</p>
        <div class="haul-items">${items.map(itemHTML).join('')}</div>
        <div class="haul-add">
          <button type="button" class="add-button add-button-secondary" data-action="add-item">+ Add item</button>
          <button type="button" class="add-button add-button-secondary" data-action="scan-items">Scan items</button>
        </div>
      </article>`;
  }

  // One search box at the top of the tab drives both views.
  const searchQuery = () => searchInput.value.trim().toLowerCase();
  const has = (text, q) => String(text || '').toLowerCase().includes(q);
  const itemSearchMatch = (it, q) => !q || has(it.name, q) || has(it.location, q) || has(it.notes, q) || has(it.platform, q) || has(it.upc, q);

  function renderHauls() {
    const mode = filterMode();
    const q = searchQuery();
    const sorted = data.hauls.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const loose = itemsOf('').filter((it) => itemMatches(it, mode) && itemSearchMatch(it, q));
    const html = (loose.length ? looseHTML(loose) : '') + sorted.map((h) => {
      const all = itemsOf(h.id);
      // A search that matches the trip itself (name or store) shows the whole trip.
      const tripHit = q && (has(h.name, q) || has(h.store, q));
      const shown = all.filter((it) => itemMatches(it, mode) && (tripHit || itemSearchMatch(it, q)));
      // Always show empty trips under "All" so a just-added one doesn't vanish.
      if (!shown.length && (q || mode !== 'all' || all.length)) return '';
      return haulHTML(h, shown);
    }).join('');
    haulList.innerHTML = html || `<p class="empty-note">${data.hauls.length || data.items.length
      ? (q ? 'Nothing matches that search.' : 'Nothing matches this filter.')
      : 'No purchases yet. Build a receipt on the Calculator tab and tap “Save to Bought”, or add a purchase by hand.'}</p>`;
    showPhotos(haulList);
  }

  // ---------- Inventory view ----------
  // Every unsold unit across all trips, merged by product name so the same
  // thing bought on three trips reads as one line with a combined count.
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
      if (it.soldQty >= it.qty) return;
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
      return { ...g, onHand, cost, potential, prices, places, haulDate };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  function invFootHTML(g) {
    const resell = g.prices.length === 1 ? money(g.prices[0]) : `${money(Math.min(...g.prices))}–${money(Math.max(...g.prices))}`;
    const below = g.lots.filter((it) => itemCalc(it).belowCost);
    const worstCost = below.reduce((m, it) => Math.max(m, itemCalc(it).unitCost), 0);
    return `<span>Avg cost ${money(g.onHand ? g.cost / g.onHand : 0)}</span>`
      + `<span>Retail ${money(g.lots[0].unitRetail)}</span>`
      + `<span>Price ${resell}</span>`
      + `<span class="${g.potential < 0 ? 'bad' : 'good'}">Potential ${signedMoney(g.potential)}</span>`
      + (g.lots.length > 1 ? `<span class="muted">from ${g.lots.length} trips</span>` : '')
      + (below.length ? `<span class="below-cost">Below cost — price at ${money(minPrice(worstCost))}+ to break even</span>` : '');
  }

  // Lowest price that still covers cost once the commission comes out.
  const minPrice = (unitCost) => Math.ceil((unitCost / Math.max(0.01, 1 - pricing.commission / 100)) * 100) / 100;

  function invGroupHTML(g, index) {
    const lotLines = g.lots.map((it) => {
      const c = itemCalc(it);
      return `<li>${it.haulId ? esc(formatDate(g.haulDate.get(it.haulId))) : 'No trip'} · ${c.left} left · ${money(c.unitCost)} each${it.location ? ` · ${esc(it.location)}` : ''}${it.notes ? ` · ${esc(it.notes)}` : ''}</li>`;
    }).join('');
    const field = (label, cls, attrs, type = 'number') => `<label><span class="field-label">${label}</span><input type="${type}" class="${cls}" ${attrs}></label>`;
    return `
      <div class="b-item inv-item" data-group="${index}">
        <div class="inv-head">
          ${photoThumbHTML((g.lots.find((it) => it.photo) || {}).photo, g.name)}
          <span class="inv-name">${esc(g.name)}</span>
          <span class="inv-onhand">${g.onHand} on hand</span>
          <button type="button" class="remove-item" data-action="remove-stock" aria-label="Remove from inventory">&times;</button>
        </div>
        <div class="b-foot">${invFootHTML(g)}</div>
        <div class="b-grid b-grid-2">
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
          <button type="button" class="add-button inv-sell-btn" data-action="record-sale">Record sale</button>
        </details>
        <details class="inv-lots">
          <summary>Where it came from (${g.lots.length})</summary>
          <ul>${lotLines}</ul>
        </details>
      </div>`;
  }

  function renderInventory() {
    invGroups = buildInventory();
    const q = searchQuery();
    const shown = invGroups
      .map((g, i) => ({ g, i }))
      .filter(({ g }) => !q || has(g.name, q) || g.lots.some((it) => itemSearchMatch(it, q)));
    invList.innerHTML = shown.length
      ? shown.map(({ g, i }) => invGroupHTML(g, i)).join('')
      : `<p class="empty-note">${invGroups.length ? 'Nothing in stock matches that search.' : 'Nothing in stock. Items you buy show up here until they’re sold.'}</p>`;
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
    } else if (el.classList.contains('inv-location')) {
      g.lots.forEach((it) => { it.location = cleanText(el.value); });
      g.places = el.value.trim() ? [el.value.trim()] : [];
    } else {
      return;
    }
    save();
    renderSummary();
  });

  // Takes a product's unsold units out of stock. Units already sold stay, so
  // recorded sales and profit don't change; a lot with no sales is deleted.
  async function removeStock(g) {
    const trips = g.lots.length;
    if (!await window.appConfirm({
      title: `Remove ${g.onHand} × ${g.name}?`,
      message: `This takes ${g.onHand === 1 ? 'it' : 'them'} out of your purchases${trips > 1 ? ` (from ${trips} trips)` : ''}. Any sales you've recorded for it are kept.`,
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
    // Blank fees + a commission set = the commission is the fee.
    const fees = feesInput === '' ? round2(total * (pricing.commission / 100)) : cleanMoney(feesInput);
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
    tripFilters.hidden = inv;
    haulList.hidden = inv;
    invList.hidden = !inv;
    if (!inv) invMessage.hidden = true;
    try { localStorage.setItem(VIEW_KEY, inv ? 'inventory' : 'trips'); } catch (e) { /* storage unavailable */ }
    render();
  }

  viewInputs.forEach((r) => r.addEventListener('change', () => setView(viewMode())));

  function render() {
    renderSummary();
    if (viewMode() === 'inventory') renderInventory(); else renderHauls();
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
      save();
      return;
    }

    const itemEl = el.closest('.b-item');
    const f = el.dataset.f;
    if (!itemEl || !f) return;
    const it = data.items.find((i) => i.id === itemEl.dataset.item);
    if (!it) return;

    if (f === 'qty') it.qty = Math.max(1, Math.round(num(el.value) || 1));
    else if (f === 'soldQty') it.soldQty = Math.max(0, Math.round(num(el.value)));
    else if (NUMBER_FIELDS.has(f)) it[f] = cleanMoney(el.value);
    else if (f === 'soldDate') it.soldDate = DATE_RE.test(el.value) ? el.value : '';
    else if (f === 'upc') it.upc = cleanUpc(el.value);
    else it[f] = cleanText(el.value);
    it.soldQty = Math.min(it.soldQty, it.qty);

    save();
    $('.b-foot', itemEl).innerHTML = itemFootHTML(it);
    $('.haul-totals', haulEl).textContent = haulTotalsText(haulEl.dataset.haul);
    renderSummary();
  });

  // Once something is marked sold, fill in today's date if none is set yet.
  haulList.addEventListener('change', (e) => {
    const el = e.target;
    const itemEl = el.closest('.b-item');
    if (!itemEl || (el.dataset.f !== 'soldQty' && el.dataset.f !== 'soldTotal')) return;
    const it = data.items.find((i) => i.id === itemEl.dataset.item);
    if (!it || it.soldDate || !(it.soldQty > 0 || it.soldTotal > 0)) return;
    it.soldDate = today();
    $('input[data-f="soldDate"]', itemEl).value = it.soldDate;
    if (el.dataset.f === 'soldQty' && it.soldQty > it.qty) el.value = it.qty;
    save();
  });

  haulList.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const haulEl = btn.closest('.haul');
    const haulId = haulEl && haulEl.dataset.haul;

    if (btn.dataset.action === 'photo') {
      const it = data.items.find((i) => i.id === btn.closest('.b-item').dataset.item);
      if (it) openPhoto([it]);
    } else if (btn.dataset.action === 'add-item') {
      data.items.push(cleanItem({ haulId, qty: 1 }));
      save();
      render();
      const added = $$(`.haul[data-haul="${CSS.escape(haulId)}"] .b-item`).pop();
      if (added) $('.item-name', added).focus();
    } else if (btn.dataset.action === 'scan-items') {
      scanIntoHaul(haulId);
    } else if (btn.dataset.action === 'delete-item') {
      const id = btn.closest('.b-item').dataset.item;
      const it = data.items.find((i) => i.id === id);
      if (!await window.appConfirm({
        title: `Delete ${it && it.name ? `“${it.name}”` : 'this item'}?`,
        message: 'This can’t be undone.',
        confirmText: 'Delete', cancelText: 'Keep', danger: true,
      })) return;
      data.items = data.items.filter((i) => i.id !== id);
      save();
      render();
    } else if (btn.dataset.action === 'delete-haul') {
      const count = itemsOf(haulId).length;
      if (!await window.appConfirm({
        title: 'Delete this whole trip?',
        message: (count ? `Its ${count} item${count === 1 ? '' : 's'} will be deleted too. ` : '') + 'This can’t be undone.',
        confirmText: 'Delete trip', cancelText: 'Keep', danger: true,
      })) return;
      data.hauls = data.hauls.filter((h) => h.id !== haulId);
      data.items = data.items.filter((i) => i.haulId !== haulId);
      save();
      render();
    }
  });

  filterInputs.forEach((r) => r.addEventListener('change', renderHauls));

  $('#add-loose').addEventListener('click', () => {
    data.items.push(cleanItem({ haulId: '', qty: 1 }));
    filterInputs.forEach((r) => { r.checked = r.value === 'all'; });
    searchInput.value = '';
    save();
    setView('trips');
    const el = $$('.haul[data-haul=""] .item-name').pop();
    if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); }
  });

  addHaulBtn.addEventListener('click', () => {
    const haul = cleanHaul({ date: today(), store: 'Dollar General' });
    data.hauls.unshift(haul);
    data.items.push(cleanItem({ haulId: haul.id, qty: 1 }));
    filterInputs.forEach((r) => { r.checked = r.value === 'all'; });
    searchInput.value = '';
    save();
    setView('trips');
    const el = $(`.haul[data-haul="${CSS.escape(haul.id)}"] .item-name`);
    if (el) el.focus();
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

  // `onAdded` runs as soon as the item is in the trip, before any online lookup.
  async function addScannedItem(haulId, code, onAdded = () => {}) {
    if (haulId !== '' && !data.hauls.some((h) => h.id === haulId)) return { text: 'That trip is gone.', tone: 'unmet', close: true };
    const same = data.items.find((i) => i.haulId === haulId && i.upc === code);
    if (same) {
      same.qty += 1;
      save();
      render();
      onAdded(same);
      return { text: `${same.name || code} — now ${same.qty} in this trip.`, tone: 'met' };
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

  // Jump to a trip, at the first item that still needs a name typed in.
  function showHaul(haulId) {
    const haulEl = $(`.haul[data-haul="${CSS.escape(haulId)}"]`);
    if (!haulEl) return;
    const blank = $('.item-name[value=""]', haulEl);
    (blank || haulEl).scrollIntoView({ block: blank ? 'center' : 'start' });
  }

  function scanIntoHaul(haulId) {
    const session = scanSession(() => haulId);
    window.openScanner({
      title: 'Scan items into this trip',
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
          <button type="button" class="add-button add-button-secondary" data-p="add">Add to a new purchase</button>
          <button type="button" class="add-button add-button-secondary" data-p="add-loose">Add without a trip</button>
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
          data.items.push(cleanItem({ haulId, qty: 1, upc: code, name, photo, unitRetail: known ? known.unitRetail : 0 }));
          filterInputs.forEach((r) => { r.checked = r.value === 'all'; });
          searchInput.value = '';
          save();
          setView('trips');
          const el = $$(`.haul[data-haul="${CSS.escape(haulId)}"] .b-item`).pop();
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
    add: ['Add to a new purchase', ADD_HINT],
    loose: ['Add without a trip', ADD_HINT],
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
        <label class="filter-chip"><input type="radio" name="scan-into" value="trip"><span>New trip</span></label>
        <label class="filter-chip"><input type="radio" name="scan-into" value="none"><span>No trip</span></label>
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
          filterInputs.forEach((r) => { r.checked = r.value === 'all'; });
          searchInput.value = '';
          setView('trips');
          showHaul(haulId && itemsOf(haulId).length ? haulId : '');
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
    lines.forEach((line) => {
      const it = cleanItem({ ...line, haulId: haul.id });
      if (it) data.items.push(it);
    });
    filterInputs.forEach((r) => { r.checked = r.value === 'all'; });
    searchInput.value = '';
    save();
    setView('trips');
    setTab('bought');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

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
      : items.length > 1 ? `Your photo · used for all ${items.length} trips of this item.` : 'Your photo.';
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
  // Nothing is pushed until a pull has succeeded, so a fresh device (or one
  // that couldn't reach the sheet) never overwrites the sheet with stale data.
  let pulled = false;
  let syncTimer = null;
  let pushing = false;
  let pushAgain = false;

  // ---------- Calculator build ----------
  // The calculator (script.js) owns its working copy and saved scenarios;
  // the sync just carries them to and from the sheet's "Calculator" tab as
  // one JSON string.
  const calc = window.calcSync;
  // Changed here before the first pull finished, so it beats the sheet's copy.
  let calcEdited = false;
  document.addEventListener('calc:change', () => {
    if (!pulled) calcEdited = true;
    scheduleSync();
  });

  function remoteBuild(body) {
    if (typeof body.calc !== 'string' || !body.calc) return null;
    try {
      const build = JSON.parse(body.calc);
      return build && typeof build === 'object' ? build : null;
    } catch (e) { return null; }
  }

  // Skips the reload when nothing changed, so the page doesn't jump.
  function loadBuild(build) {
    if (JSON.stringify(calc.get()) !== JSON.stringify(build)) calc.load(build);
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
      calc: JSON.stringify(calc.get()),
    };
  }

  const syncedText = () => `Synced ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

  async function pull() {
    setSyncStatus('busy', 'Syncing…');
    try {
      const body = await callSheet(sync, 'pull');
      const remote = cleanData(body);
      const build = remoteBuild(body);
      pulled = true;
      // Whatever the sheet is missing just gets this device's copy.
      let needPush = false;
      if (remote.hauls.length) {
        data = remote;
        persist();
        render();
      } else if (data.hauls.length) {
        needPush = true;
      }
      if (build && !calcEdited) loadBuild(build);
      else if (build || !calc.isBlank()) needPush = true;
      calcEdited = false;
      if (needPush) await push();
      else setSyncStatus('ok', syncedText());
      syncPhotos(true);
    } catch (err) {
      setSyncStatus('error', `Sync error: ${err.message}`);
    }
  }

  async function push() {
    if (!sync || !pulled) return;
    if (pushing) { pushAgain = true; return; }
    pushing = true;
    setSyncStatus('busy', 'Syncing…');
    try {
      await callSheet(sync, 'push', sheetRows());
      setSyncStatus('ok', syncedText());
      syncPhotos();
    } catch (err) {
      setSyncStatus('error', `Sync error: ${err.message}`);
    } finally {
      pushing = false;
      if (pushAgain) { pushAgain = false; push(); }
    }
  }

  // Collapses a burst of typing into one request ~1.2s after the last change.
  function scheduleSync() {
    if (!sync || !pulled) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(push, 1200);
  }

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
    let body;
    try {
      body = await callSheet(conn, 'pull');
    } catch (err) {
      showMessage(err.message, 'unmet');
      return;
    }
    const remote = cleanData(body);
    const build = remoteBuild(body);
    const deviceHasBuild = !calc.isBlank();
    // Only remember the connection once it's proven to work.
    let preferSheet = true;
    if ((remote.hauls.length && data.hauls.length) || (build && deviceHasBuild)) {
      // Closing this without choosing cancels the connect, rather than
      // silently overwriting either side.
      const describe = (trips, hasBuild) => [
        trips ? `${trips} trip${trips === 1 ? '' : 's'}` : '',
        hasBuild ? 'calculator scenarios' : '',
      ].filter(Boolean).join(' and ');
      const choice = await window.appChoose({
        title: 'Your sheet already has data',
        message: `The sheet has ${describe(remote.hauls.length, !!build)} and this device has ${describe(data.hauls.length, deviceHasBuild)}. Which should be kept? The other one gets replaced.`,
        confirmText: 'Use the sheet’s data',
        altText: 'Keep this device’s data',
        cancelText: 'Don’t connect',
      });
      if (choice === 'cancel') { showMessage('Not connected — nothing was changed.', 'unmet'); return; }
      preferSheet = choice === 'confirm';
    }
    // Anything only one side has is kept either way.
    if (remote.hauls.length && (preferSheet || !data.hauls.length)) data = remote;
    if (build && (preferSheet || !deviceHasBuild)) loadBuild(build);
    sync = conn;
    pulled = true;
    calcEdited = false;
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(conn)); } catch (e) { /* storage unavailable */ }
    syncUrlInput.value = '';
    syncKeyInput.value = '';
    showMessage('');
    persist();
    render();
    renderSyncPanel();
    await push();
    syncPhotos(true);
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

  $('#sync-copy-script').addEventListener('click', async () => {
    try {
      const res = await fetch('google-sheet-sync/Code.gs', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      await navigator.clipboard.writeText(await res.text());
      showMessage('Script copied. Paste it into Apps Script (step 3).', 'met');
    } catch (e) {
      showMessage('Couldn’t copy automatically — use the “open it here” link instead.', 'unmet');
    }
  });

  $('#sync-now').addEventListener('click', () => {
    clearTimeout(syncTimer);
    if (pulled) push(); else pull();
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
  pricingPct.value = pricing.pctOff;
  pricingCommission.value = pricing.commission || '';
  pricingRent.value = pricing.rent || '';
  pricingRentPeriod.value = pricing.rentPeriod;
  pricingRentStart.value = pricing.rentStart;
  renderPricingStatus();
  let startView = 'trips';
  try { startView = localStorage.getItem(VIEW_KEY) || 'trips'; } catch (e) { /* storage unavailable */ }
  setView(startView);
  renderSyncPanel();
  if (sync) pull();
})();
