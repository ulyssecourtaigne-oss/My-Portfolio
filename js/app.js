// app.js — page logic: state, views, actions, refresh scheduler. No maths here (see calc.js),
// no API calls here (see provider.js), no storage details here (see store.js).
import { calcPosition, calcPortfolio, benchmarkSeries, todayISO } from './calc.js';
import * as store from './store.js';
import { PROVIDERS, getProvider, fetchFx, convertPrice, minCycleMs, requestSpacingMs, sleep } from './provider.js';
import { h, clear, link, fmtMoney, fmtPct, fmtNum, fmtX, ago, pnlClass, field, input, select, button, numVal, modal, toast, confirmDialog } from './ui.js';
import { donut, lineChart } from './charts.js';

let state = store.load();
let view = location.hash.replace('#', '') || 'dashboard';
let sort = { key: 'netUnrealised', dir: -1 };
let refreshTimer = null;
let refreshing = false;
let lastCycleStarted = 0;
let nextCycleAt = 0;

const $app = document.getElementById('app');
const persist = () => {
  if (!store.save(state)) toast('Could not save to this browser (storage full or blocked).', 'error');
};
const settings = () => state.settings;
const qkey = (ex, t) => `${ex}:${String(t).toUpperCase()}`;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---------------------------------------------------------------- prices

function fxRates() {
  const r = { ...(state.fx.rates || {}) };
  r[settings().baseCurrency] = 1;
  return r;
}

/** Resolve the price used for a position, in the position's currency, with a status flag. */
function priceInfo(pos) {
  const prov = getProvider(settings().provider);
  const key = qkey(pos.exchange, pos.ticker);
  const q = state.quotes[key];
  const manual = pos.manualPrice && Number.isFinite(pos.manualPrice.price) ? pos.manualPrice : null;
  const covered = prov.covers(pos.exchange) && !!settings().apiKeys[prov.id];
  const cycle = minCycleMs(prov, openSymbols().length, settings().refreshSeconds);
  if (pos.priceMode === 'manual' || !covered) {
    if (manual) return { price: manual.price, prevClose: null, time: manual.date, status: 'manual', detail: `Manual price set ${manual.date || ''}` };
    const why = pos.priceMode === 'manual' ? 'Manual mode, no price entered'
      : prov.id === 'manual' ? 'No price provider set up yet — go to Settings → Price provider, choose a provider and paste your API key'
      : !settings().apiKeys[prov.id] ? `No API key saved for ${prov.label.split(' (')[0]} — paste it under Settings → Price provider`
      : `${prov.label.split(' (')[0]} does not cover ${pos.exchange} — switch to EODHD or enter a manual price`;
    return { price: null, prevClose: null, time: null, status: 'none', detail: why };
  }
  if (q && q.price != null) {
    const rates = fxRates();
    const price = convertPrice(q.price, pos.quoteCurrency, pos.currency, rates);
    const prevClose = convertPrice(q.prevClose, pos.quoteCurrency, pos.currency, rates);
    if (price == null) return { price: manual ? manual.price : null, prevClose: null, time: q.time, status: 'nofx', detail: `Quote is in ${pos.quoteCurrency} but no FX rate to ${pos.currency} yet` };
    let status = 'live';
    let detail = `Fetched ${ago(q.fetchedAt)} (${prov.id})`;
    if (q.error) { status = 'error'; detail = `Last fetch failed: ${q.error}. Showing price from ${ago(q.fetchedAt)}`; }
    else if (Date.now() - q.fetchedAt > cycle * 3 + 60000) { status = 'stale'; detail = `Not refreshed for ${ago(q.fetchedAt)}`; }
    return { price, prevClose, time: q.fetchedAt, status, detail, raw: q.price, rawCurrency: pos.quoteCurrency };
  }
  if (q && q.error) return { price: manual ? manual.price : null, prevClose: null, time: null, status: 'error', detail: `Fetch failed: ${q.error}` };
  if (manual) return { price: manual.price, prevClose: null, time: manual.date, status: 'manual', detail: 'Manual price (no live quote yet)' };
  return { price: null, prevClose: null, time: null, status: 'none', detail: 'No price yet' };
}

function openSymbols() {
  const prov = getProvider(settings().provider);
  const seen = new Set();
  const out = [];
  for (const p of state.positions) {
    const r = calcPosition(p, { asOf: todayISO() });
    if (r.isClosed || p.priceMode === 'manual' || !prov.covers(p.exchange) || !p.ticker) continue;
    const k = qkey(p.exchange, p.ticker);
    if (!seen.has(k)) { seen.add(k); out.push({ key: k, ticker: p.ticker, exchange: p.exchange }); }
  }
  const b = settings().benchmark;
  if (b && b.ticker && prov.covers(b.exchange)) {
    const k = qkey(b.exchange, b.ticker);
    if (!seen.has(k)) out.push({ key: k, ticker: b.ticker, exchange: b.exchange });
  }
  return out;
}

function neededCurrencies() {
  const s = new Set([settings().baseCurrency]);
  for (const p of state.positions) { s.add(p.currency); s.add(p.quoteCurrency === 'GBX' ? 'GBP' : p.quoteCurrency); }
  const b = settings().benchmark;
  if (b && b.quoteCurrency) s.add(b.quoteCurrency === 'GBX' ? 'GBP' : b.quoteCurrency);
  return [...s];
}

async function refreshFx(force = false) {
  const base = settings().baseCurrency;
  const fresh = state.fx.base === base && state.fx.time && Date.now() - state.fx.time < 3600000;
  if (fresh && !force) return;
  try {
    const prov = settings().provider;
    const { rates, source } = await fetchFx(prov, settings().apiKeys[prov], base, neededCurrencies());
    state.fx = { rates: { ...(state.fx.base === base ? state.fx.rates : {}), ...rates }, time: Date.now(), base, source, error: null };
  } catch (e) {
    state.fx = { ...state.fx, error: String(e.message || e) };
  }
  persist();
}

async function refreshAll({ manual = false } = {}) {
  if (refreshing) return;
  const prov = getProvider(settings().provider);
  const key = settings().apiKeys[prov.id];
  refreshing = true;
  lastCycleStarted = Date.now();
  render();
  try {
    await refreshFx(manual);
    if (prov.id !== 'manual' && key) {
      const syms = openSymbols();
      const spacing = requestSpacingMs(prov);
      for (let i = 0; i < syms.length; i++) {
        const s = syms[i];
        try {
          const q = await prov.quote(s.ticker, s.exchange, key);
          state.quotes[s.key] = { price: q.price, prevClose: q.prevClose, time: q.time, currency: q.currency, fetchedAt: Date.now(), source: prov.id, error: null };
        } catch (e) {
          state.quotes[s.key] = { ...(state.quotes[s.key] || {}), error: String(e.message || e), errorAt: Date.now(), source: prov.id };
        }
        persist();
        render();
        if (i < syms.length - 1) await sleep(spacing);
      }
    }
    takeSnapshot();
  } finally {
    refreshing = false;
    persist();
    render();
    schedule();
  }
}

function schedule() {
  clearTimeout(refreshTimer);
  const prov = getProvider(settings().provider);
  if (prov.id === 'manual' || !settings().apiKeys[prov.id]) { nextCycleAt = 0; return; }
  const cycle = minCycleMs(prov, openSymbols().length, settings().refreshSeconds);
  const wait = Math.max(5000, lastCycleStarted + cycle - Date.now());
  nextCycleAt = Date.now() + wait;
  refreshTimer = setTimeout(() => refreshAll(), wait);
}

// ---------------------------------------------------------------- portfolio

function portfolio() {
  const prices = {};
  const infos = {};
  for (const p of state.positions) {
    const i = priceInfo(p);
    infos[p.id] = i;
    prices[p.id] = { price: i.price, prevClose: i.prevClose };
  }
  const res = calcPortfolio(state.positions, {
    asOf: todayISO(),
    baseCurrency: settings().baseCurrency,
    fx: fxRates(),
    prices,
    maintenanceMargin: settings().maintenanceMargin / 100,
    cash: settings().cash,
  });
  for (const r of res.rows) r.priceInfo = infos[r.id];
  return res;
}

function benchmarkPrice() {
  const b = settings().benchmark;
  if (!b || !b.ticker) return null;
  const q = state.quotes[qkey(b.exchange, b.ticker)];
  if (q && q.price != null && !q.error) return q.price;
  return Number.isFinite(Number(b.manualPrice)) && b.manualPrice !== null ? Number(b.manualPrice) : null;
}

function takeSnapshot() {
  const res = portfolio();
  const open = res.rows.filter((r) => !r.isClosed);
  if (open.length && res.totals.priced === 0) return; // nothing priced → do not record a misleading day
  const date = todayISO();
  const snap = {
    date,
    equity: res.totals.equity,
    exposure: res.totals.exposure,
    unrealised: res.totals.unrealised,
    realised: res.totals.realised,
    costs: res.totals.costsToDate,
    benchmarkPrice: benchmarkPrice(),
    baseCurrency: settings().baseCurrency,
  };
  const idx = state.snapshots.findIndex((s) => s.date === date);
  if (idx >= 0) state.snapshots[idx] = snap;
  else state.snapshots.push(snap);
  state.snapshots.sort((a, b) => (a.date < b.date ? -1 : 1));
  persist();
}

// ---------------------------------------------------------------- rendering

function render() {
  clear($app);
  $app.append(header());
  const main = h('main', { class: 'container' });
  if (view === 'dashboard') main.append(dashboardView());
  else if (view === 'positions') main.append(positionsView());
  else if (view === 'research') main.append(researchView());
  else if (view === 'settings') main.append(settingsView());
  else main.append(dashboardView());
  $app.append(main, footer());
}

function nav(to) {
  view = to;
  location.hash = to;
  render();
  window.scrollTo(0, 0);
}

function header() {
  const prov = getProvider(settings().provider);
  const live = prov.id !== 'manual' && settings().apiKeys[prov.id];
  const status = refreshing ? 'Refreshing…' : live ? `Next refresh ${nextCycleAt ? ago(nextCycleAt).replace(' ago', '').replace(/^0s$/, 'now') : '—'}` : 'Manual prices';
  const tabs = [['dashboard', 'Dashboard'], ['positions', 'Positions'], ['research', 'Research'], ['settings', 'Settings']];
  return h('header', { class: 'topbar' },
    h('div', { class: 'container row between wrap' },
      h('div', { class: 'brand' }, h('span', { class: 'logo' }, '◆'), h('strong', null, 'Portfolio Tracker'), h('span', { class: 'muted small' }, ' · private, browser-only')),
      h('nav', { class: 'tabs' }, tabs.map(([id, label]) => h('button', { type: 'button', class: `tab ${view === id ? 'active' : ''}`, onClick: () => nav(id) }, label))),
      h('div', { class: 'row gap' },
        h('span', { class: 'muted small', title: live ? `Refreshing every ${Math.round(minCycleMs(prov, openSymbols().length, settings().refreshSeconds) / 1000)}s` : '' }, status),
        button(refreshing ? '…' : '↻ Refresh', () => refreshAll({ manual: true }), 'ghost'),
        button(settings().theme === 'dark' ? '☀' : '☾', toggleTheme, 'ghost icon'))));
}

function footer() {
  const fx = state.fx;
  return h('footer', { class: 'container muted small' },
    h('span', null, `Base ${settings().baseCurrency} · FX ${fx.time ? `${fx.source || ''} ${ago(fx.time)}` : 'not loaded'}${fx.error ? ` · FX error: ${fx.error}` : ''}`),
    h('span', null, ' · All data stays in this browser. Export regularly.'));
}

function toggleTheme() {
  settings().theme = settings().theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  persist();
  render();
}

function applyTheme() {
  const t = settings().theme;
  if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
}

// ---------------------------------------------------------------- dashboard

function tile(label, value, sub, cls = '') {
  return h('div', { class: `tile ${cls}` }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, value), sub ? h('div', { class: 'tile-sub' }, sub) : null);
}

function statusBadge(info) {
  const map = { live: ['Live', 'ok'], stale: ['Stale', 'warn'], error: ['Failed', 'bad'], manual: ['Manual', 'info'], nofx: ['No FX', 'warn'], none: ['No price', 'bad'] };
  const [label, cls] = map[info.status] || ['?', ''];
  return h('span', { class: `badge ${cls}`, title: info.detail }, label);
}

function dashboardView() {
  const res = portfolio();
  const base = settings().baseCurrency;
  const t = res.totals;
  const open = res.rows.filter((r) => !r.isClosed);
  const problems = open.filter((r) => ['stale', 'error', 'none', 'nofx'].includes(r.priceInfo.status) || r.fxMissing);
  const wrap = h('section', null);
  if (!state.positions.length) {
    wrap.append(h('div', { class: 'card empty' },
      h('h2', null, 'No positions yet'),
      h('p', null, 'Add your first position, or import a backup. Set your price provider and API key under Settings.'),
      h('div', { class: 'row gap' }, button('+ Add position', () => editPosition(null), 'primary'), button('Settings', () => nav('settings')))));
  }
  wrap.append(h('div', { class: 'tiles' },
    tile('Equity', fmtMoney(t.equity, base), `cash ${fmtMoney(settings().cash, base)} + margin ${fmtMoney(t.marginUsed, base)} + P&L`),
    tile('Total exposure', fmtMoney(t.exposure, base), `net ${fmtMoney(t.netExposure, base)} · borrowed ${fmtMoney(t.borrowed, base)}`),
    tile('Effective leverage', fmtX(t.effectiveLeverage), 'exposure ÷ equity'),
    tile("Today's change", fmtMoney(t.todayChange, base, { plus: true }), 'vs previous close', pnlClass(t.todayChange)),
    tile('Unrealised P&L', fmtMoney(t.unrealised, base, { plus: true }), 'net of costs', pnlClass(t.unrealised)),
    tile('Realised P&L', fmtMoney(t.realised, base, { plus: true }), 'closed quantities, net', pnlClass(t.realised)),
    tile('Costs to date', fmtMoney(t.costsToDate, base), 'fees + financing − dividends'),
    tile('Next overnight cost', fmtMoney(t.nextNightCost, base), `tonight (${WEEKDAYS[new Date().getUTCDay()]})`)));
  if (problems.length || res.warnings.length || t.unpriced) {
    wrap.append(h('div', { class: 'card warn-card' },
      h('strong', null, 'Attention: '),
      h('ul', null,
        problems.map((r) => h('li', null, `${r.position.ticker}: ${r.priceInfo.detail}`)),
        res.warnings.map((w) => h('li', null, w)))));
  }
  wrap.append(positionsTable(res));
  // charts
  const byStock = res.allocation.byPosition.map((x) => ({ label: `${x.label}${x.side === 'short' ? ' (S)' : ''}`, value: x.value })).sort((a, b) => b.value - a.value);
  const byCcy = Object.entries(res.allocation.byCurrency).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  wrap.append(h('div', { class: 'grid2' },
    h('div', { class: 'card' }, donut(byStock, { title: 'Allocation by stock (exposure)', format: (v) => fmtMoney(v, base) })),
    h('div', { class: 'card' }, donut(byCcy, { title: 'Allocation by currency', format: (v) => fmtMoney(v, base) }))));
  const series = benchmarkSeries(state.snapshots, Object.fromEntries(state.snapshots.map((s) => [s.date, s.benchmarkPrice])));
  const b = settings().benchmark;
  wrap.append(h('div', { class: 'card' },
    lineChart([
      { name: 'Portfolio equity (indexed)', points: series.map((s) => ({ x: s.date, y: s.equityIndex })) },
      { name: `${b && b.ticker ? b.ticker : 'Benchmark'} (indexed)`, points: series.map((s) => ({ x: s.date, y: s.benchIndex })) },
    ], { title: 'Portfolio vs benchmark (first snapshot = 100)', baseline: 100 }),
    lineChart([{ name: `Net P&L (${base})`, points: series.map((s) => ({ x: s.date, y: s.netPnl })), format: (v) => fmtMoney(v, base, { plus: true }) }],
      { title: 'Net P&L over time (realised + unrealised)', yFormat: (v) => fmtNum(v, 0), baseline: 0 }),
    h('p', { class: 'muted small' }, `${state.snapshots.length} daily snapshot(s) stored in this browser. A snapshot is saved each day the page is open with prices.`)));
  return wrap;
}

const COLUMNS = [
  { key: 'ticker', label: 'Ticker', get: (r) => r.position.ticker, text: (r) => null },
  { key: 'side', label: 'Side', get: (r) => r.position.side, text: (r) => (r.position.side === 'short' ? 'Short' : 'Long') },
  { key: 'qtyOpen', label: 'Qty', get: (r) => r.qtyOpen, text: (r) => fmtNum(r.qtyOpen, 4) },
  { key: 'entry', label: 'Entry', get: (r) => r.position.entryPrice, text: (r) => fmtMoney(r.position.entryPrice, r.position.currency, { price: true }) },
  { key: 'price', label: 'Price', get: (r) => r.price, text: null },
  { key: 'todayChange', label: 'Today', get: (r) => r.base.todayChange, text: (r) => fmtMoney(r.base.todayChange, null, { plus: true }), cls: (r) => pnlClass(r.todayChange) },
  { key: 'value', label: 'Value', get: (r) => r.base.currentValue, text: (r) => fmtMoney(r.base.currentValue) },
  { key: 'margin', label: 'Margin', get: (r) => r.base.margin, text: (r) => fmtMoney(r.base.margin) },
  { key: 'lev', label: 'Lev', get: (r) => r.position.leverage, text: (r) => `${r.position.leverage}×` },
  { key: 'gross', label: 'Gross P&L', get: (r) => r.grossUnrealised, text: (r) => fmtMoney(r.grossUnrealised, r.position.currency, { plus: true }), cls: (r) => pnlClass(r.grossUnrealised) },
  { key: 'costs', label: 'Costs', get: (r) => r.totalCostsUnrealised, text: (r) => fmtMoney(r.totalCostsUnrealised, r.position.currency) },
  { key: 'netUnrealised', label: 'Net P&L', get: (r) => r.base.netUnrealised, text: (r) => fmtMoney(r.netUnrealised, r.position.currency, { plus: true }), cls: (r) => pnlClass(r.netUnrealised) },
  { key: 'rom', label: 'Ret. on margin', get: (r) => r.returnOnMargin, text: (r) => fmtPct(r.returnOnMargin, { plus: true }), cls: (r) => pnlClass(r.returnOnMargin) },
  { key: 'be', label: 'Break-even', get: (r) => r.breakEven, text: (r) => fmtMoney(r.breakEven, r.position.currency, { price: true }) },
  { key: 'mc', label: 'Margin call', get: (r) => r.marginCallPrice, text: (r) => (r.position.leverage <= 1 && r.position.side === 'long' ? '—' : fmtMoney(r.marginCallPrice, r.position.currency, { price: true })) },
  { key: 'night', label: 'Per night', get: (r) => r.perNight, text: (r) => fmtMoney(r.perNight, r.position.currency) },
];

function positionsTable(res) {
  const base = settings().baseCurrency;
  const open = res.rows.filter((r) => !r.isClosed);
  const col = COLUMNS.find((c) => c.key === sort.key) || COLUMNS[0];
  open.sort((a, b) => {
    const x = col.get(a); const y = col.get(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
  });
  const head = h('tr', null, COLUMNS.map((c) => h('th', {
    class: `sortable ${sort.key === c.key ? 'sorted' : ''}`, onClick: () => { sort = { key: c.key, dir: sort.key === c.key ? -sort.dir : -1 }; render(); },
    title: ['value', 'margin', 'todayChange'].includes(c.key) ? `in ${base}` : '',
  }, c.label, sort.key === c.key ? (sort.dir < 0 ? ' ▼' : ' ▲') : '')), h('th', null, ''));
  const rows = open.map((r) => h('tr', { class: 'clickable', onClick: () => showPosition(r.position.id) }, COLUMNS.map((c) => {
    if (c.key === 'ticker') return h('td', null, h('strong', null, r.position.ticker), h('span', { class: 'muted small' }, ` ${r.position.exchange}`));
    if (c.key === 'price') return h('td', null, h('div', null, fmtMoney(r.price, r.position.currency, { price: true }), ' ', statusBadge(r.priceInfo)), h('div', { class: 'muted tiny' }, r.priceInfo.time ? (typeof r.priceInfo.time === 'number' ? ago(r.priceInfo.time) : r.priceInfo.time) : ''));
    return h('td', { class: c.cls ? c.cls(r) : '' }, c.text(r));
  }), h('td', null, button('⋯', (e) => { e.stopPropagation(); showPosition(r.position.id); }, 'ghost icon'))));
  const closed = res.rows.filter((r) => r.isClosed);
  const card = h('div', { class: 'card' },
    h('div', { class: 'row between' }, h('h3', null, `Open positions (${open.length})`), button('+ Add position', () => editPosition(null), 'primary small')),
    open.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'positions' }, h('thead', null, head), h('tbody', null, rows))) : h('p', { class: 'muted' }, 'No open positions.'),
    h('p', { class: 'muted tiny' }, `Value, margin and Today are in ${base}; other money columns are in each position's own currency.`));
  if (closed.length) {
    const det = h('details', null, h('summary', null, `Closed positions (${closed.length})`),
      h('table', { class: 'positions' }, h('thead', null, h('tr', null, ['Ticker', 'Side', 'Qty', 'Entry', 'Realised gross', 'Costs', 'Realised net', ''].map((x) => h('th', null, x)))),
        h('tbody', null, closed.map((r) => h('tr', { class: 'clickable', onClick: () => showPosition(r.position.id) },
          h('td', null, h('strong', null, r.position.ticker), ` ${r.position.exchange}`), h('td', null, r.position.side), h('td', null, fmtNum(r.qtyClosed, 4)),
          h('td', null, fmtMoney(r.position.entryPrice, r.position.currency, { price: true })), h('td', { class: pnlClass(r.realised.gross) }, fmtMoney(r.realised.gross, r.position.currency, { plus: true })),
          h('td', null, fmtMoney(r.realised.costs, r.position.currency)), h('td', { class: pnlClass(r.realised.net) }, fmtMoney(r.realised.net, r.position.currency, { plus: true })), h('td', null, '›'))))));
    card.append(det);
  }
  return card;
}

// ---------------------------------------------------------------- positions view

function positionsView() {
  const res = portfolio();
  return h('section', null, positionsTable(res));
}

function findPos(id) {
  return state.positions.find((p) => p.id === id);
}

function metric(label, value, cls = '') {
  return h('div', { class: `metric ${cls}` }, h('span', { class: 'metric-label' }, label), h('span', { class: 'metric-value' }, value));
}

function showPosition(id) {
  const pos = findPos(id);
  if (!pos) return;
  const info = priceInfo(pos);
  const r = calcPosition(pos, { price: info.price, asOf: todayISO(), maintenanceMargin: settings().maintenanceMargin / 100 });
  const c = pos.currency;
  const body = h('div', { class: 'detail' });
  const reopen = () => { m.close(); showPosition(id); };
  const f = pos.financing;
  const methodLabel = { borrowed: `${fmtPct(f.rate)} a year on borrowed amount`, notional: `${fmtPct(f.rate)} a year on full position value`, fixed: `${fmtMoney(f.perNight, c)} per night` }[f.method];
  body.append(
    h('div', { class: 'row between wrap' },
      h('div', null, h('h3', null, `${pos.ticker} · ${pos.exchange} · ${pos.side === 'short' ? 'Short' : 'Long'} ${fmtNum(r.qtyOpen, 4)}${r.qtyClosed ? ` (closed ${fmtNum(r.qtyClosed, 4)})` : ''} · ${pos.leverage}×`),
        h('div', { class: 'muted small' }, `Entered ${pos.entryDate} @ ${fmtMoney(pos.entryPrice, c, { price: true })} · ${r.nights} night(s) · quote in ${pos.quoteCurrency}, position in ${c}`)),
      h('div', { class: 'row gap wrap' },
        button('Edit', () => { m.close(); editPosition(pos); }),
        !r.isClosed ? button('Close / partial close', () => { m.close(); closeForm(pos); }, 'primary') : null,
        button('Ledger entry', () => { m.close(); ledgerForm(pos); }),
        button('Manual price', () => { m.close(); manualPriceForm(pos); }),
        button('Delete', async () => { if (await confirmDialog(`Delete ${pos.ticker} and all its history?`)) { state.positions = state.positions.filter((p) => p.id !== id); persist(); m.close(); render(); } }, 'danger'))),
    h('div', { class: 'row gap' }, h('span', null, 'Price: ', h('b', null, fmtMoney(info.price, c, { price: true })), ' ', statusBadge(info)), h('span', { class: 'muted small' }, info.detail)),
  );
  if (!r.isClosed) {
    body.append(h('h4', null, 'Open position'), h('div', { class: 'metrics' },
      metric('Current value', fmtMoney(r.currentValue, c)), metric('Margin used', fmtMoney(r.margin, c)), metric('Borrowed', fmtMoney(r.borrowed, c)),
      metric('Gross P&L', fmtMoney(r.grossUnrealised, c, { plus: true }), pnlClass(r.grossUnrealised)), metric('Total costs', fmtMoney(r.totalCostsUnrealised, c)),
      metric('Net P&L', fmtMoney(r.netUnrealised, c, { plus: true }), pnlClass(r.netUnrealised)), metric('Return on margin', fmtPct(r.returnOnMargin, { plus: true }), pnlClass(r.returnOnMargin)),
      metric('Return on position value', fmtPct(r.returnOnNotional, { plus: true }), pnlClass(r.returnOnNotional)), metric('Cost per night', fmtMoney(r.perNight, c)),
      metric('Tonight', fmtMoney(r.nextNightCost, c)), metric('Break-even after costs', fmtMoney(r.breakEven, c, { price: true })),
      metric(`Margin call (${settings().maintenanceMargin}% maint.)`, pos.leverage <= 1 && pos.side === 'long' ? 'n/a (no leverage)' : fmtMoney(r.marginCallPrice, c, { price: true }))));
  }
  body.append(h('h4', null, 'Costs'), h('div', { class: 'metrics' },
    metric('Opening fees', fmtMoney(r.fees.open, c)), metric('Closing fees', fmtMoney(r.fees.close, c)), metric('Other ledger fees', fmtMoney(r.fees.ledger, c)),
    metric('Financing estimated', fmtMoney(r.financing.estimated, c)), metric(`Financing actual (${r.financing.nightsWithActual} night(s))`, fmtMoney(r.financing.actual, c)),
    metric('Financing applied', fmtMoney(r.financing.applied, c)), metric('Dividends (net received)', fmtMoney(r.dividends.total, c)), metric('All costs to date', fmtMoney(r.totals.costs, c))),
    h('p', { class: 'muted small' }, `Financing: ${methodLabel}, ${f.dayCount}-day count, weekends ${f.weekendMode === 'triple' ? `charged as a triple night on ${WEEKDAYS[f.tripleDay]}` : 'charged as calendar nights'}. "Applied" uses your ledger's actual charge for any night that has one, and the estimate otherwise.`));
  if (r.qtyClosed) {
    body.append(h('h4', null, 'Realised'), h('div', { class: 'metrics' },
      metric('Realised gross', fmtMoney(r.realised.gross, c, { plus: true }), pnlClass(r.realised.gross)), metric('Realised costs', fmtMoney(r.realised.costs, c)), metric('Realised net', fmtMoney(r.realised.net, c, { plus: true }), pnlClass(r.realised.net))));
    body.append(h('table', { class: 'mini' }, h('thead', null, h('tr', null, ['Date', 'Qty', 'Price', 'Fees', 'Note', ''].map((x) => h('th', null, x)))),
      h('tbody', null, pos.closes.map((cl) => h('tr', null, h('td', null, cl.date), h('td', null, fmtNum(cl.quantity, 4)), h('td', null, fmtMoney(cl.price, c, { price: true })),
        h('td', null, fmtMoney(cl.commission + cl.fxFee + cl.other, c)), h('td', null, cl.note || ''),
        h('td', null, button('remove', async () => { if (await confirmDialog('Remove this close?')) { pos.closes = pos.closes.filter((x) => x.id !== cl.id); persist(); reopen(); } }, 'ghost small')))))));
  }
  // ledger
  body.append(h('h4', null, `Ledger (${pos.ledger.length})`));
  if (pos.ledger.length) {
    const sortedL = [...pos.ledger].sort((a, b) => (a.date < b.date ? 1 : -1));
    body.append(h('table', { class: 'mini' }, h('thead', null, h('tr', null, ['Date', 'Type', 'Amount', 'Note', ''].map((x) => h('th', null, x)))),
      h('tbody', null, sortedL.map((l) => h('tr', null, h('td', null, l.date), h('td', null, l.type === 'dividend' ? (l.amount >= 0 ? 'Dividend received' : 'Dividend paid') : l.type === 'financing' ? 'Overnight (actual)' : 'Fee'),
        h('td', null, fmtMoney(Math.abs(l.amount), c)), h('td', null, l.note || ''),
        h('td', null, button('remove', () => { pos.ledger = pos.ledger.filter((x) => x.id !== l.id); persist(); reopen(); }, 'ghost small')))))));
  } else body.append(h('p', { class: 'muted small' }, 'No ledger entries. Add what your broker actually charged (overnight fees, dividends, other fees) to replace estimates.'));
  // nightly schedule
  const det = h('details', null, h('summary', null, `Nightly financing schedule (${r.nightly.length} nights)`));
  const recent = r.nightly.slice(-60).reverse();
  det.append(h('table', { class: 'mini' }, h('thead', null, h('tr', null, ['Night of', 'Open qty', '×', 'Estimated', 'Actual', 'Applied'].map((x) => h('th', null, x)))),
    h('tbody', null, recent.map((n) => h('tr', { class: n.actual != null ? 'has-actual' : '' }, h('td', null, `${n.date} ${WEEKDAYS[new Date(n.date).getUTCDay()].slice(0, 3)}`), h('td', null, fmtNum(n.qtyOpen, 4)), h('td', null, n.multiplier),
      h('td', null, fmtMoney(n.estimated, c, { decimals: 4 })), h('td', null, n.actual == null ? '—' : fmtMoney(n.actual, c, { decimals: 4 })), h('td', null, fmtMoney(n.applied, c, { decimals: 4 })))))),
    r.nightly.length > 60 ? h('p', { class: 'muted tiny' }, 'Showing the last 60 nights.') : null);
  body.append(det);
  // rate changes
  body.append(h('h4', null, 'Rate changes'), rateChangesEditor(pos, reopen));
  // research
  body.append(h('h4', null, 'Research & thesis'), researchCard(pos.research, { onEdit: () => { m.close(); researchForm(pos, () => showPosition(id)); } }));
  if (pos.notes) body.append(h('h4', null, 'Notes'), h('p', { class: 'pre' }, pos.notes));
  const m = modal(`${pos.ticker} — details`, body, { wide: true });
}

function rateChangesEditor(pos, reopen) {
  const list = pos.financing.rateChanges || [];
  const dateEl = input({ type: 'date' });
  const rateEl = input({ type: 'number', step: 'any', placeholder: 'annual %' });
  return h('div', null,
    list.length ? h('ul', { class: 'plain' }, list.map((rc) => h('li', null, `From ${rc.from}: ${fmtPct(rc.rate)} a year `, button('remove', () => { pos.financing.rateChanges = list.filter((x) => x !== rc); persist(); reopen(); }, 'ghost small')))) : h('p', { class: 'muted small' }, 'None. Add one when your broker changes the financing rate (for example when the benchmark rate moves).'),
    h('div', { class: 'row gap' }, dateEl, rateEl, button('Add rate change', () => {
      if (!dateEl.value) return toast('Pick a date', 'error');
      pos.financing.rateChanges = [...list, { from: dateEl.value, rate: numVal(rateEl) / 100 }];
      persist(); reopen();
    }, 'small')));
}

// ---------------------------------------------------------------- forms

function editPosition(existing, prefill) {
  const pos = existing ? JSON.parse(JSON.stringify(existing)) : { ...store.newPosition(settings()), ...(prefill || {}) };
  const ex = select(store.EXCHANGES.map((e) => ({ value: e.id, label: e.label })), pos.exchange);
  const quoteCcy = select(['USD', 'GBX', 'GBP', 'EUR', 'KRW', 'CHF', 'JPY', 'CAD', 'HKD'].map((c) => ({ value: c, label: c })), pos.quoteCurrency);
  ex.addEventListener('change', () => { quoteCcy.value = store.EXCHANGES.find((e) => e.id === ex.value).quoteCurrency; });
  const ticker = input({ value: pos.ticker, placeholder: 'e.g. AAPL, VOD, ASML, 005930', required: true, autocomplete: 'off' });
  const ccy = select(store.CURRENCIES.map((c) => ({ value: c, label: c })), pos.currency);
  const side = select([{ value: 'long', label: 'Long (buy)' }, { value: 'short', label: 'Short (sell)' }], pos.side);
  const qty = input({ type: 'number', step: 'any', min: '0', value: pos.quantity || '' });
  const entry = input({ type: 'number', step: 'any', min: '0', value: pos.entryPrice || '' });
  const date = input({ type: 'date', value: pos.entryDate });
  const lev = input({ type: 'number', step: 'any', min: '1', value: pos.leverage });
  const notes = h('textarea', { rows: 3 }, pos.notes);
  const cOpen = input({ type: 'number', step: 'any', value: pos.costs.openCommission });
  const cFx = input({ type: 'number', step: 'any', value: pos.costs.fxFee });
  const cStamp = input({ type: 'number', step: 'any', value: pos.costs.stampDuty });
  const cOther = input({ type: 'number', step: 'any', value: pos.costs.other });
  const f = pos.financing;
  const method = select([{ value: 'borrowed', label: 'Annual % on borrowed amount' }, { value: 'notional', label: 'Annual % on full position value' }, { value: 'fixed', label: 'Fixed amount per night' }], f.method);
  const rate = input({ type: 'number', step: 'any', value: f.rate * 100 });
  const perNight = input({ type: 'number', step: 'any', value: f.perNight });
  const dayCount = select([{ value: 365, label: '365' }, { value: 360, label: '360' }], f.dayCount);
  const weekend = select([{ value: 'calendar', label: 'Every calendar night (Sat & Sun charged)' }, { value: 'triple', label: 'Triple charge on one weekday, none on Sat/Sun' }], f.weekendMode);
  const tripleDay = select(WEEKDAYS.map((d, i) => ({ value: i, label: d })).filter((x) => x.value >= 1 && x.value <= 5), f.tripleDay);
  const priceMode = select([{ value: 'auto', label: 'From provider (manual as fallback)' }, { value: 'manual', label: 'Manual only' }], pos.priceMode);
  const form = h('form', { class: 'form', onSubmit: (e) => { e.preventDefault(); save(); } },
    h('div', { class: 'grid3' },
      field('Ticker', ticker), field('Exchange', ex), field('Quote currency of the feed', quoteCcy, 'LSE quotes are in pence (GBX)'),
      field('Position currency', ccy, 'eToro: USD for every stock'), field('Direction', side), field('Quantity (units)', qty),
      field('Entry price (position currency)', entry), field('Entry date', date), field('Leverage (1 = none)', lev)),
    h('h4', null, 'One-off costs (position currency)'),
    h('div', { class: 'grid4' }, field('Opening commission', cOpen), field('FX fee', cFx), field('Stamp duty', cStamp), field('Other', cOther)),
    h('h4', null, 'Overnight financing'),
    h('div', { class: 'grid3' }, field('Method', method), field('Annual rate %', rate), field('Fixed per night', perNight), field('Day count', dayCount), field('Weekends', weekend), field('Triple-charge day', tripleDay)),
    h('h4', null, 'Pricing'),
    h('div', { class: 'grid3' }, field('Price source', priceMode)),
    field('Notes', notes),
    h('div', { class: 'row end gap' }, button('Cancel', () => m.close()), h('button', { type: 'submit', class: 'btn primary' }, existing ? 'Save changes' : 'Add position')));
  const m = modal(existing ? `Edit ${existing.ticker}` : 'Add position', form, { wide: true });
  function save() {
    const t = ticker.value.trim().toUpperCase();
    if (!t) return toast('Ticker is required', 'error');
    if (numVal(qty) <= 0) return toast('Quantity must be positive', 'error');
    if (numVal(entry) <= 0) return toast('Entry price must be positive', 'error');
    if (!date.value) return toast('Entry date is required', 'error');
    const closedQty = (pos.closes || []).reduce((a, c) => a + c.quantity, 0);
    if (numVal(qty) < closedQty) return toast(`Quantity cannot be below the ${closedQty} already closed`, 'error');
    Object.assign(pos, {
      ticker: t, exchange: ex.value, quoteCurrency: quoteCcy.value, currency: ccy.value, side: side.value, quantity: numVal(qty), entryPrice: numVal(entry), entryDate: date.value,
      leverage: Math.max(1, numVal(lev, 1)), notes: notes.value, priceMode: priceMode.value,
      costs: { openCommission: numVal(cOpen), fxFee: numVal(cFx), stampDuty: numVal(cStamp), other: numVal(cOther) },
      financing: { ...f, method: method.value, rate: numVal(rate) / 100, perNight: numVal(perNight), dayCount: Number(dayCount.value), weekendMode: weekend.value, tripleDay: Number(tripleDay.value) },
    });
    const norm = store.normalisePosition(pos, settings());
    const idx = state.positions.findIndex((p) => p.id === norm.id);
    if (idx >= 0) state.positions[idx] = norm; else state.positions.push(norm);
    if (pos.ideaId) {
      const idea = state.ideas.find((i) => i.id === pos.ideaId);
      if (idea) { idea.status = 'opened'; idea.positionId = norm.id; }
    }
    persist();
    m.close();
    render();
    toast(existing ? 'Saved' : 'Position added');
    if (!existing) refreshAll({ manual: true });
  }
}

function closeForm(pos) {
  const r = calcPosition(pos, { asOf: todayISO() });
  const info = priceInfo(pos);
  const date = input({ type: 'date', value: todayISO() });
  const qty = input({ type: 'number', step: 'any', min: '0', max: r.qtyOpen, value: r.qtyOpen });
  const price = input({ type: 'number', step: 'any', value: info.price ?? '' });
  const comm = input({ type: 'number', step: 'any', value: settings().defaults.openCommission || 0 });
  const fx = input({ type: 'number', step: 'any', value: 0 });
  const other = input({ type: 'number', step: 'any', value: 0 });
  const note = input({ placeholder: 'optional' });
  const form = h('form', { class: 'form', onSubmit: (e) => { e.preventDefault();
    const q = numVal(qty);
    if (q <= 0 || q > r.qtyOpen + 1e-9) return toast(`Quantity must be between 0 and ${r.qtyOpen}`, 'error');
    if (numVal(price) <= 0) return toast('Close price required', 'error');
    pos.closes.push({ id: store.uid(), date: date.value, quantity: q, price: numVal(price), commission: numVal(comm), fxFee: numVal(fx), other: numVal(other), note: note.value });
    persist(); m.close(); render(); toast(q >= r.qtyOpen - 1e-9 ? 'Position closed' : 'Partial close recorded'); } },
    h('p', { class: 'muted small' }, `${fmtNum(r.qtyOpen, 4)} units open. Closing fewer records a partial close; opening costs are split pro-rata.`),
    h('div', { class: 'grid3' }, field('Close date', date), field('Quantity to close', qty), field(`Close price (${pos.currency})`, price), field('Closing commission', comm), field('FX fee', fx), field('Other cost', other)),
    field('Note', note),
    h('div', { class: 'row end gap' }, button('Cancel', () => m.close()), h('button', { type: 'submit', class: 'btn primary' }, 'Record close')));
  const m = modal(`Close ${pos.ticker}`, form);
}

function ledgerForm(pos) {
  const date = input({ type: 'date', value: todayISO() });
  const type = select([{ value: 'financing', label: 'Overnight fee actually charged (for that night)' }, { value: 'dividend_in', label: 'Dividend received' }, { value: 'dividend_out', label: 'Dividend paid (short)' }, { value: 'fee', label: 'Other fee / adjustment' }], 'financing');
  const amount = input({ type: 'number', step: 'any', min: '0' });
  const note = input({ placeholder: 'optional' });
  const form = h('form', { class: 'form', onSubmit: (e) => { e.preventDefault();
    const a = Math.abs(numVal(amount));
    if (!date.value) return toast('Date required', 'error');
    const t = type.value;
    pos.ledger.push({ id: store.uid(), date: date.value, type: t.startsWith('dividend') ? 'dividend' : t, amount: t === 'dividend_out' ? -a : a, note: note.value });
    persist(); m.close(); toast('Ledger entry added'); showPosition(pos.id); } },
    h('p', { class: 'muted small' }, 'For overnight fees, use the date of the night the charge is for. eToro shows a Wednesday triple charge as one line: enter it on the Wednesday.'),
    h('div', { class: 'grid2' }, field('Date', date), field('Type', type), field(`Amount (${pos.currency}, positive)`, amount), field('Note', note)),
    h('div', { class: 'row end gap' }, button('Cancel', () => m.close()), h('button', { type: 'submit', class: 'btn primary' }, 'Add entry')));
  const m = modal(`Ledger — ${pos.ticker}`, form);
}

function manualPriceForm(pos) {
  const price = input({ type: 'number', step: 'any', value: pos.manualPrice ? pos.manualPrice.price : '' });
  const mode = select([{ value: 'auto', label: 'Use provider, manual as fallback' }, { value: 'manual', label: 'Manual only' }], pos.priceMode);
  const form = h('form', { class: 'form', onSubmit: (e) => { e.preventDefault();
    pos.manualPrice = numVal(price) > 0 ? { price: numVal(price), date: todayISO() } : null;
    pos.priceMode = mode.value; persist(); m.close(); render(); toast('Price saved'); } },
    h('div', { class: 'grid2' }, field(`Price (${pos.currency})`, price, 'Leave empty to clear'), field('Mode', mode)),
    h('div', { class: 'row end gap' }, button('Cancel', () => m.close()), h('button', { type: 'submit', class: 'btn primary' }, 'Save')));
  const m = modal(`Manual price — ${pos.ticker}`, form);
}

// ---------------------------------------------------------------- research

function researchCard(r, { onEdit } = {}) {
  const stars = '★'.repeat(r.conviction) + '☆'.repeat(5 - r.conviction);
  const empty = !r.thesis && !r.sources.length && !r.log.length && !r.chatUrl;
  return h('div', { class: 'research' },
    h('div', { class: 'row between wrap' },
      h('div', { class: 'row gap wrap' }, h('span', { title: 'Conviction' }, stars), r.targetPrice != null ? h('span', { class: 'pill' }, `Target ${fmtNum(r.targetPrice, 4)}`) : null, r.stopPrice != null ? h('span', { class: 'pill' }, `Stop ${fmtNum(r.stopPrice, 4)}`) : null, r.horizon ? h('span', { class: 'pill' }, r.horizon) : null),
      onEdit ? button('Edit research', onEdit, 'small') : null),
    empty ? h('p', { class: 'muted small' }, 'No research attached yet. Paste the JSON your Claude chat produced under Research → Import, or edit by hand.') : null,
    r.thesis ? h('div', null, h('h5', null, 'Thesis'), h('p', { class: 'pre' }, r.thesis)) : null,
    r.risks ? h('div', null, h('h5', null, 'Risks'), h('p', { class: 'pre' }, r.risks)) : null,
    r.chatUrl ? h('p', null, 'Source chat: ', link(r.chatUrl, r.chatUrl)) : null,
    r.sources.length ? h('div', null, h('h5', null, 'Sources'), h('ul', null, r.sources.map((s) => h('li', null, s.url ? link(s.url, s.title || s.url) : s.title)))) : null,
    r.log.length ? h('div', null, h('h5', null, 'Research log'), h('ul', { class: 'log' }, [...r.log].sort((a, b) => (a.date < b.date ? 1 : -1)).map((l) => h('li', null, h('span', { class: 'muted small' }, l.date + ' '), h('span', { class: 'pre' }, l.text))))) : null);
}

function researchForm(target, after) {
  const r = target.research;
  const thesis = h('textarea', { rows: 5 }, r.thesis);
  const risks = h('textarea', { rows: 3 }, r.risks);
  const conviction = select([0, 1, 2, 3, 4, 5].map((v) => ({ value: v, label: v ? '★'.repeat(v) : 'not set' })), r.conviction);
  const target_ = input({ type: 'number', step: 'any', value: r.targetPrice ?? '' });
  const stop = input({ type: 'number', step: 'any', value: r.stopPrice ?? '' });
  const horizon = input({ value: r.horizon, placeholder: 'e.g. 12–18 months' });
  const chatUrl = input({ value: r.chatUrl, placeholder: 'https://claude.ai/chat/…' });
  const sources = h('textarea', { rows: 4, placeholder: 'One per line: Title | https://url' }, r.sources.map((s) => `${s.title}${s.url ? ' | ' + s.url : ''}`).join('\n'));
  const logText = h('textarea', { rows: 3, placeholder: 'Add a dated note to the research log (optional)' });
  const form = h('form', { class: 'form', onSubmit: (e) => { e.preventDefault();
    const src = sources.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [t, u] = l.split('|').map((x) => x.trim()); return u ? { title: t, url: u } : /^https?:/.test(t) ? { title: t, url: t } : { title: t, url: '' }; });
    const log = [...r.log];
    if (logText.value.trim()) log.push({ id: store.uid(), date: todayISO(), text: logText.value.trim() });
    target.research = store.normaliseResearch({ thesis: thesis.value, risks: risks.value, conviction: conviction.value, targetPrice: target_.value, stopPrice: stop.value, horizon: horizon.value, chatUrl: chatUrl.value, sources: src, log });
    persist(); m.close(); toast('Research saved'); if (after) after(); else render(); } },
    h('div', { class: 'grid3' }, field('Conviction', conviction), field('Target price', target_), field('Stop / invalidation price', stop), field('Horizon', horizon), field('Claude chat link', chatUrl)),
    field('Thesis — why this position', thesis), field('Key risks / what would change my mind', risks), field('Sources', sources), field('New log entry', logText),
    h('div', { class: 'row end gap' }, button('Cancel', () => m.close()), h('button', { type: 'submit', class: 'btn primary' }, 'Save research')));
  const m = modal(`Research — ${target.ticker || 'idea'}`, form, { wide: true });
}

const RESEARCH_PROMPT = `You are helping me document an investment idea for my personal portfolio tracker. At the end of our research, output ONE JSON object (no prose, no markdown fences) with exactly this shape:
{
  "ticker": "AAPL",            // exchange ticker as the broker shows it
  "exchange": "US",            // one of: US, LSE, AMS, KRX, KOSDAQ, OTHER
  "side": "long",              // long or short
  "research": {
    "thesis": "3–8 sentences: what the market is missing and why this is mispriced",
    "risks": "the 2–4 things that would invalidate the thesis",
    "conviction": 3,           // 1–5
    "targetPrice": 0,          // in the broker's position currency, or null
    "stopPrice": 0,            // invalidation level, or null
    "horizon": "12 months",
    "chatUrl": "",             // I will paste the link to this chat here
    "sources": [ { "title": "Q3 2026 10-Q", "url": "https://..." } ],
    "log": [ { "date": "YYYY-MM-DD", "text": "one-paragraph summary of the research done today" } ]
  }
}
Only use data you can cite. Keep every string plain text.`;

function researchView() {
  const wrap = h('section', null);
  // import box
  const ta = h('textarea', { rows: 8, placeholder: 'Paste the JSON produced by your Claude chat here (one object or an array of objects).' });
  const importBox = h('div', { class: 'card' },
    h('h3', null, 'Import research from a Claude chat'),
    h('p', { class: 'muted small' }, 'Workflow: research the stock in a Claude chat, ask it to end with the JSON below, paste the JSON here. If a position with the same ticker and exchange exists, the research attaches to it; otherwise it becomes an idea you can later open as a position. Everything is rendered as plain text.'),
    h('details', null, h('summary', null, 'Prompt to paste into your Claude chat'), h('pre', { class: 'prompt' }, RESEARCH_PROMPT), button('Copy prompt', async () => { try { await navigator.clipboard.writeText(RESEARCH_PROMPT); toast('Copied'); } catch { toast('Select and copy the text manually', 'error'); } }, 'small')),
    ta,
    h('div', { class: 'row gap' }, button('Import', () => importResearch(ta.value), 'primary'), button('New idea by hand', () => { const idea = store.newIdea(); state.ideas.push(idea); persist(); editIdea(idea); })));
  wrap.append(importBox);
  // ideas
  const ideas = state.ideas.filter((i) => i.status !== 'opened');
  wrap.append(h('div', { class: 'card' }, h('h3', null, `Ideas & watchlist (${ideas.length})`),
    ideas.length ? ideas.map((i) => h('div', { class: 'idea' },
      h('div', { class: 'row between wrap' }, h('strong', null, `${i.ticker || '(no ticker)'} · ${i.exchange} · ${i.side} · ${i.status}`),
        h('div', { class: 'row gap' }, button('Open position', () => editPosition(null, { ticker: i.ticker, exchange: i.exchange, quoteCurrency: i.quoteCurrency, currency: i.currency, side: i.side, research: JSON.parse(JSON.stringify(i.research)), ideaId: i.id }), 'primary small'),
          button('Edit', () => editIdea(i), 'small'), button(i.status === 'rejected' ? 'Un-reject' : 'Reject', () => { i.status = i.status === 'rejected' ? 'watching' : 'rejected'; persist(); render(); }, 'small'),
          button('Delete', async () => { if (await confirmDialog('Delete this idea?')) { state.ideas = state.ideas.filter((x) => x.id !== i.id); persist(); render(); } }, 'danger small'))),
      researchCard(i.research, { onEdit: () => researchForm(i) }))) : h('p', { class: 'muted' }, 'No ideas yet.')));
  // per position research
  wrap.append(h('div', { class: 'card' }, h('h3', null, 'Research on positions'),
    state.positions.length ? state.positions.map((p) => h('div', { class: 'idea' }, h('div', { class: 'row between' }, h('strong', { class: 'clickable', onClick: () => showPosition(p.id) }, `${p.ticker} · ${p.exchange} · ${p.side}`), button('Edit research', () => researchForm(p), 'small')), researchCard(p.research))) : h('p', { class: 'muted' }, 'No positions yet.')));
  return wrap;
}

function editIdea(idea) {
  const ticker = input({ value: idea.ticker });
  const ex = select(store.EXCHANGES.map((e) => ({ value: e.id, label: e.label })), idea.exchange);
  const side = select([{ value: 'long', label: 'Long' }, { value: 'short', label: 'Short' }], idea.side);
  const form = h('form', { class: 'form', onSubmit: (e) => { e.preventDefault(); idea.ticker = ticker.value.trim().toUpperCase(); idea.exchange = ex.value; idea.quoteCurrency = store.EXCHANGES.find((x) => x.id === ex.value).quoteCurrency; idea.side = side.value; persist(); m.close(); researchForm(idea); } },
    h('div', { class: 'grid3' }, field('Ticker', ticker), field('Exchange', ex), field('Direction', side)),
    h('div', { class: 'row end gap' }, button('Cancel', () => m.close()), h('button', { type: 'submit', class: 'btn primary' }, 'Next: research')));
  const m = modal('Idea', form);
}

function importResearch(text) {
  let data;
  try { data = JSON.parse(text); } catch {
    // tolerate ```json fences or surrounding prose
    const mt = text.match(/\{[\s\S]*\}/);
    try { data = JSON.parse(mt ? mt[0] : ''); } catch { return toast('Could not parse JSON', 'error'); }
  }
  const items = Array.isArray(data) ? data : [data];
  let attached = 0; let created = 0;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const ticker = String(it.ticker || '').trim().toUpperCase();
    const exchange = store.EXCHANGES.some((e) => e.id === it.exchange) ? it.exchange : 'US';
    const incoming = store.normaliseResearch(it.research || it);
    const pos = state.positions.find((p) => p.ticker === ticker && p.exchange === exchange && !calcPosition(p, {}).isClosed) || state.positions.find((p) => p.ticker === ticker && p.exchange === exchange);
    const target = pos || state.ideas.find((i) => i.ticker === ticker && i.exchange === exchange);
    if (target) {
      const cur = target.research;
      target.research = store.normaliseResearch({
        ...cur, ...Object.fromEntries(Object.entries(incoming).filter(([k, v]) => !['sources', 'log'].includes(k) && v !== '' && v !== null && v !== 0)),
        sources: [...cur.sources, ...incoming.sources.filter((s) => !cur.sources.some((c) => c.url && c.url === s.url))],
        log: [...cur.log, ...incoming.log],
      });
      attached++;
    } else {
      const idea = store.normaliseIdea({ ...store.newIdea(), ticker, exchange, side: it.side, research: incoming });
      state.ideas.push(idea);
      created++;
    }
  }
  persist(); render();
  toast(`Imported: ${attached} attached to existing, ${created} new idea(s)`);
}

// ---------------------------------------------------------------- settings

function settingsView() {
  const s = settings();
  const prov = getProvider(s.provider);
  const wrap = h('section', null);
  // provider
  const provSel = select(Object.values(PROVIDERS).map((p) => ({ value: p.id, label: p.label })), s.provider);
  const keyIn = input({ type: 'password', value: s.apiKeys[s.provider] || '', placeholder: 'API key (stored only in this browser)', autocomplete: 'off' });
  provSel.addEventListener('change', () => { keyIn.value = s.apiKeys[provSel.value] || ''; });
  const refresh = input({ type: 'number', min: 15, step: 1, value: s.refreshSeconds });
  const n = openSymbols().length;
  wrap.append(h('div', { class: 'card' }, h('h3', null, 'Price provider'),
    h('div', { class: 'grid2' }, field('Provider', provSel), field('API key', keyIn, prov.signupUrl ? h('span', null, 'Get one at ', link(prov.signupUrl, prov.signupUrl)) : null), field('Refresh every (seconds)', refresh, `Effective cycle with ${n} symbol(s): ${Math.round(minCycleMs(prov, n, s.refreshSeconds) / 1000)}s — the limit of ${prov.limits.perMinute || '∞'}/min, ${prov.limits.perDay || '∞'}/day is always respected`)),
    h('p', { class: 'muted small' }, 'Coverage: EODHD All World covers US, London, Amsterdam and Korea (about 15 min delayed). Finnhub and Twelve Data free tiers cover US only; other exchanges need a manual price. FX comes from the ECB (Frankfurter) unless EODHD is set, which provides live FX.'),
    h('div', { class: 'row gap' }, button('Save provider', () => { s.provider = provSel.value; s.apiKeys[provSel.value] = keyIn.value.trim(); s.refreshSeconds = Math.max(15, numVal(refresh, 120)); persist(); toast('Provider saved'); render(); refreshAll({ manual: true }); }, 'primary'),
      button('Test now', () => refreshAll({ manual: true })))));
  // portfolio
  const base = select(store.CURRENCIES.map((c) => ({ value: c, label: c })), s.baseCurrency);
  const maint = input({ type: 'number', step: 'any', min: 0, max: 100, value: s.maintenanceMargin });
  const cash = input({ type: 'number', step: 'any', value: s.cash });
  const bTicker = input({ value: s.benchmark.ticker });
  const bEx = select(store.EXCHANGES.map((e) => ({ value: e.id, label: e.label })), s.benchmark.exchange);
  const bManual = input({ type: 'number', step: 'any', value: s.benchmark.manualPrice ?? '', placeholder: 'if not covered by provider' });
  wrap.append(h('div', { class: 'card' }, h('h3', null, 'Portfolio'),
    h('div', { class: 'grid3' }, field('Base currency', base, 'Totals are converted with live FX'), field('Maintenance margin % of position value', maint, '0 = margin call when the whole margin is lost'), field(`Cash not in positions (${s.baseCurrency})`, cash, 'Added to equity'),
      field('Benchmark ticker', bTicker), field('Benchmark exchange', bEx), field('Benchmark manual price', bManual)),
    button('Save portfolio settings', () => { const changed = base.value !== s.baseCurrency; s.baseCurrency = base.value; s.maintenanceMargin = numVal(maint); s.cash = numVal(cash); s.benchmark = { ticker: bTicker.value.trim().toUpperCase(), exchange: bEx.value, quoteCurrency: store.EXCHANGES.find((e) => e.id === bEx.value).quoteCurrency, manualPrice: bManual.value === '' ? null : numVal(bManual) }; persist(); toast('Saved'); render(); if (changed) refreshFx(true).then(render); }, 'primary')));
  // defaults
  const d = s.defaults;
  const dCcy = select(store.CURRENCIES.map((c) => ({ value: c, label: c })), d.currency);
  const dLev = input({ type: 'number', step: 'any', min: 1, value: d.leverage });
  const dComm = input({ type: 'number', step: 'any', value: d.openCommission });
  const dMethod = select([{ value: 'borrowed', label: 'Annual % on borrowed amount' }, { value: 'notional', label: 'Annual % on full position value' }, { value: 'fixed', label: 'Fixed per night' }], d.financing.method);
  const dRate = input({ type: 'number', step: 'any', value: d.financing.rate * 100 });
  const dDay = select([{ value: 365, label: '365' }, { value: 360, label: '360' }], d.financing.dayCount);
  const dWeek = select([{ value: 'calendar', label: 'Calendar nights' }, { value: 'triple', label: 'Triple on one day' }], d.financing.weekendMode);
  const dTriple = select(WEEKDAYS.map((x, i) => ({ value: i, label: x })).filter((x) => x.value >= 1 && x.value <= 5), d.financing.tripleDay);
  wrap.append(h('div', { class: 'card' }, h('h3', null, 'Defaults for new positions (eToro-style)'),
    h('p', { class: 'muted small' }, 'eToro charges overnight fees on the full position value for leveraged and short positions, quotes everything in USD, and books the weekend as a triple charge on one weekday. Check your current rates on eToro’s fees page and adjust here; existing positions are not changed.'),
    h('div', { class: 'grid4' }, field('Position currency', dCcy), field('Leverage', dLev), field('Opening commission', dComm), field('Financing method', dMethod), field('Annual rate %', dRate), field('Day count', dDay), field('Weekends', dWeek), field('Triple day', dTriple)),
    button('Save defaults', () => { s.defaults = { currency: dCcy.value, leverage: numVal(dLev, 1), openCommission: numVal(dComm), financing: { method: dMethod.value, rate: numVal(dRate) / 100, perNight: 0, dayCount: Number(dDay.value), weekendMode: dWeek.value, tripleDay: Number(dTriple.value) } }; persist(); toast('Defaults saved'); }, 'primary')));
  // backup
  const fileIn = h('input', { type: 'file', accept: 'application/json,.json' });
  const mode = select([{ value: 'replace', label: 'Replace everything' }, { value: 'merge', label: 'Merge (keep existing, add/overwrite by id)' }], 'replace');
  const inclKeys = h('input', { type: 'checkbox' });
  wrap.append(h('div', { class: 'card' }, h('h3', null, 'Backup & restore'),
    h('p', { class: 'muted small' }, 'Your positions, ledger, research, snapshots and settings live only in this browser’s storage. Export a JSON file regularly and keep it somewhere private (never in the public repo).'),
    h('div', { class: 'row gap wrap' }, button('Export JSON', () => downloadJSON(store.exportJSON(state, { includeKeys: inclKeys.checked })), 'primary'), h('label', { class: 'row gap small' }, inclKeys, 'include API keys in export')),
    h('div', { class: 'row gap wrap' }, fileIn, mode, button('Import file', async () => {
      const f = fileIn.files && fileIn.files[0];
      if (!f) return toast('Choose a file first', 'error');
      try { const { state: ns, summary } = store.parseImport(await f.text(), state, { mode: mode.value }); if (await confirmDialog(`${summary} Continue?`)) { state = ns; persist(); applyTheme(); render(); toast('Imported'); refreshAll({ manual: true }); } } catch (e) { toast(e.message, 'error'); }
    }))));
  // danger
  wrap.append(h('div', { class: 'card' }, h('h3', null, 'Danger zone'),
    h('div', { class: 'row gap wrap' }, button('Clear price cache', () => { state.quotes = {}; persist(); render(); toast('Price cache cleared'); }),
      button('Delete snapshots', async () => { if (await confirmDialog('Delete all daily snapshots?')) { state.snapshots = []; persist(); render(); } }, 'danger'),
      button('Erase all data in this browser', async () => { if (await confirmDialog('Erase positions, research, snapshots, settings and keys from this browser? Export first!')) { store.clearAll(); state = store.defaultState(); render(); } }, 'danger'))));
  wrap.append(h('div', { class: 'card muted small' }, h('h3', null, 'About the maths'),
    h('ul', null,
      h('li', null, 'Margin = quantity × entry ÷ leverage; borrowed = notional − margin.'),
      h('li', null, 'Financing per night: borrowed × rate ÷ day count (or notional × rate ÷ day count, or a fixed amount). Nights are counted from the entry date to today; in triple mode Saturday and Sunday nights are free and the chosen weekday is charged three times.'),
      h('li', null, 'Where the ledger holds an actual charge for a night, it replaces the estimate for that night. Estimated, actual and applied totals are shown separately.'),
      h('li', null, 'Total costs = opening fees + closing fees + other fees + applied financing − dividends received (+ dividends paid). Net P&L = gross − total costs. Break-even = entry ± total costs ÷ open quantity.'),
      h('li', null, 'Partial closes realise gross P&L on the units closed, carry their pro-rata share of opening fees and of financing accrued while they were open, plus the closing costs.'),
      h('li', null, 'Margin-call price solves margin + unrealised gross = maintenance % × position value.'))));
  return wrap;
}

function downloadJSON(text) {
  const blob = new Blob([text], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `portfolio-backup-${todayISO()}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------------------------------------------------------- boot

window.addEventListener('hashchange', () => { view = location.hash.replace('#', '') || 'dashboard'; render(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(); });
setInterval(() => { if (!document.querySelector('.overlay')) render(); }, 30000);
applyTheme();
render();
refreshAll();

// expose for debugging in the console (no secrets printed)
window.__tracker = { get state() { return state; }, refreshAll, portfolio };
