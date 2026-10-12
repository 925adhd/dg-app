(() => {
  'use strict';

  // ---------- "Bought" tab: a haul & resale tracker ----------
  // Every saved receipt becomes a haul (one shopping trip) holding its items.
  // Each item tracks what it cost, what it's worth at retail, what you plan to
  // resell it for, and what it actually sold for — so profit adds itself up.
  // Optionally mirrors everything to a Google Sheet you own (see
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
    if (!i || typeof i !== 'object' || !validId(i.haulId)) return null;
    const qty = Math.max(1, Math.round(num(i.qty) || 1));
    const unitRetail = cleanMoney(i.unitRetail);
    return {
      id: validId(i.id) ? i.id : newId(),
      haulId: i.haulId,
      name: cleanText(i.name),
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
      .filter((i) => i && haulIds.has(i.haulId) && !itemIds.has(i.id) && itemIds.add(i.id));
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
          <input type="text" class="item-name" data-f="name" placeholder="Item name" maxlength="${MAX_TEXT}" value="${esc(it.name)}">
          <button type="button" class="remove-item" data-action="delete-item" aria-label="Delete item">&times;</button>
        </div>
        <div class="b-grid">
          ${field('Qty', 'qty', it.qty, 'min="1" step="1" inputmode="numeric"')}
          ${field('Retail each', 'unitRetail', blankIfZero(it.unitRetail))}
          ${field('Paid total (with tax)', 'totalPaid', blankIfZero(it.totalPaid))}
          ${field('Resell at (each)', 'resalePrice', blankIfZero(it.resalePrice))}
        </div>
        <div class="b-grid b-grid-2">
          <label><span class="field-label">Location</span><input type="text" data-f="location" placeholder="e.g. Bin 3" maxlength="${MAX_TEXT}" value="${esc(it.location)}"></label>
          <label><span class="field-label">Notes</span><input type="text" data-f="notes" placeholder="e.g. dented box" maxlength="${MAX_TEXT}" value="${esc(it.notes)}"></label>
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
        <button type="button" class="add-button add-button-secondary" data-action="add-item">+ Add item</button>
      </article>`;
  }

  // One search box at the top of the tab drives both views.
  const searchQuery = () => searchInput.value.trim().toLowerCase();
  const has = (text, q) => String(text || '').toLowerCase().includes(q);
  const itemSearchMatch = (it, q) => !q || has(it.name, q) || has(it.location, q) || has(it.notes, q) || has(it.platform, q);

  function renderHauls() {
    const mode = filterMode();
    const q = searchQuery();
    const sorted = data.hauls.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const html = sorted.map((h) => {
      const all = itemsOf(h.id);
      // A search that matches the trip itself (name or store) shows the whole trip.
      const tripHit = q && (has(h.name, q) || has(h.store, q));
      const shown = all.filter((it) => itemMatches(it, mode) && (tripHit || itemSearchMatch(it, q)));
      // Always show empty trips under "All" so a just-added one doesn't vanish.
      if (!shown.length && (q || mode !== 'all' || all.length)) return '';
      return haulHTML(h, shown);
    }).join('');
    haulList.innerHTML = html || `<p class="empty-note">${data.hauls.length
      ? (q ? 'Nothing matches that search.' : 'Nothing matches this filter.')
      : 'No purchases yet. Build a receipt on the Calculator tab and tap “Save to Bought”, or add a purchase by hand.'}</p>`;
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
      return `<li>${esc(formatDate(g.haulDate.get(it.haulId)))} · ${c.left} left · ${money(c.unitCost)} each${it.location ? ` · ${esc(it.location)}` : ''}${it.notes ? ` · ${esc(it.notes)}` : ''}</li>`;
    }).join('');
    const field = (label, cls, attrs, type = 'number') => `<label><span class="field-label">${label}</span><input type="${type}" class="${cls}" ${attrs}></label>`;
    return `
      <div class="b-item inv-item" data-group="${index}">
        <div class="inv-head">
          <span class="inv-name">${esc(g.name)}</span>
          <span class="inv-onhand">${g.onHand} on hand</span>
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

  invList.addEventListener('click', (e) => {
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
    if (!haul) return;

    if (el.dataset.h) {
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
    else it[f] = cleanText(el.value);
    it.soldQty = Math.min(it.soldQty, it.qty);

    save();
    $('.b-foot', itemEl).innerHTML = itemFootHTML(it);
    $('.haul-totals', haulEl).textContent = haulTotalsText(haul.id);
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

    if (btn.dataset.action === 'add-item') {
      data.items.push(cleanItem({ haulId, qty: 1 }));
      save();
      render();
      const added = $$(`.haul[data-haul="${CSS.escape(haulId)}"] .b-item`).pop();
      if (added) $('.item-name', added).focus();
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
    };
  }

  const syncedText = () => `Synced ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

  async function pull() {
    setSyncStatus('busy', 'Syncing…');
    try {
      const remote = cleanData(await callSheet(sync, 'pull'));
      pulled = true;
      if (remote.hauls.length) {
        data = remote;
        persist();
        render();
        setSyncStatus('ok', syncedText());
      } else if (data.hauls.length) {
        // An empty sheet just gets this device's data.
        await push();
      } else {
        setSyncStatus('ok', syncedText());
      }
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
    let remote;
    try {
      remote = cleanData(await callSheet(conn, 'pull'));
    } catch (err) {
      showMessage(err.message, 'unmet');
      return;
    }
    // Only remember the connection once it's proven to work.
    if (remote.hauls.length && data.hauls.length) {
      // Closing this without choosing cancels the connect, rather than
      // silently overwriting either side.
      const choice = await window.appChoose({
        title: 'Your sheet already has data',
        message: `The sheet has ${remote.hauls.length} trip${remote.hauls.length === 1 ? '' : 's'} and this device has ${data.hauls.length}. Which should be kept? The other one gets replaced.`,
        confirmText: 'Use the sheet’s data',
        altText: 'Keep this device’s data',
        cancelText: 'Don’t connect',
      });
      if (choice === 'cancel') { showMessage('Not connected — nothing was changed.', 'unmet'); return; }
      if (choice === 'confirm') data = remote;
    } else if (remote.hauls.length) {
      data = remote;
    }
    sync = conn;
    pulled = true;
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(conn)); } catch (e) { /* storage unavailable */ }
    syncUrlInput.value = '';
    syncKeyInput.value = '';
    showMessage('');
    persist();
    render();
    renderSyncPanel();
    await push();
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
      message: 'Your purchases stay on this device and in the sheet; they just stop syncing here.',
      confirmText: 'Disconnect', cancelText: 'Stay connected',
    })) return;
    try { localStorage.removeItem(SYNC_KEY); } catch (e) { /* storage unavailable */ }
    sync = null;
    pulled = false;
    clearTimeout(syncTimer);
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
