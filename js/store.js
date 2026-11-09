// store.js — browser-only persistence (localStorage), JSON export/import, schema defaults.
// Nothing here ever leaves the browser.

export const STORAGE_KEY = 'portfolio-tracker.v1';
export const SCHEMA_VERSION = 1;

export const EXCHANGES = [
  { id: 'US', label: 'US (NYSE / Nasdaq)', quoteCurrency: 'USD' },
  { id: 'LSE', label: 'London (LSE)', quoteCurrency: 'GBX' },
  { id: 'AMS', label: 'Euronext Amsterdam', quoteCurrency: 'EUR' },
  { id: 'KRX', label: 'Korea (KOSPI)', quoteCurrency: 'KRW' },
  { id: 'KOSDAQ', label: 'Korea (KOSDAQ)', quoteCurrency: 'KRW' },
  { id: 'OTHER', label: 'Other / manual', quoteCurrency: 'USD' },
];

export const CURRENCIES = ['USD', 'GBP', 'EUR', 'KRW', 'CHF', 'JPY', 'CAD', 'AUD', 'HKD', 'SEK', 'DKK', 'NOK'];

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function defaultSettings() {
  return {
    baseCurrency: 'GBP',
    maintenanceMargin: 0, // % of position value; 0 = call when all margin is lost
    cash: 0,
    provider: 'manual',
    apiKeys: {}, // { providerId: key } — stays in this browser
    refreshSeconds: 120,
    benchmark: { ticker: 'SPY', exchange: 'US', quoteCurrency: 'USD', manualPrice: null },
    theme: 'auto',
    broker: 'etoro',
    defaults: {
      currency: 'USD',
      leverage: 1,
      openCommission: 1,
      financing: { method: 'notional', rate: 0.1, perNight: 0, dayCount: 365, weekendMode: 'triple', tripleDay: 3 },
    },
  };
}

export function defaultState() {
  return {
    version: SCHEMA_VERSION,
    settings: defaultSettings(),
    positions: [],
    ideas: [],
    snapshots: [], // { date, equity, exposure, unrealised, realised, costs, benchmarkPrice }
    quotes: {}, // { [key]: { price, prevClose, time, currency, source, error } } key = exchange:ticker
    fx: { rates: {}, time: null, base: null }, // rates: 1 unit of CCY in base currency
  };
}

export function newPosition(settings) {
  const d = (settings && settings.defaults) || defaultSettings().defaults;
  return {
    id: uid(),
    ticker: '',
    exchange: 'US',
    quoteCurrency: 'USD',
    currency: d.currency || 'USD',
    side: 'long',
    quantity: 0,
    entryPrice: 0,
    entryDate: new Date().toISOString().slice(0, 10),
    leverage: d.leverage || 1,
    notes: '',
    costs: { openCommission: d.openCommission || 0, fxFee: 0, stampDuty: 0, other: 0 },
    financing: { ...(d.financing || {}), rateChanges: [] },
    ledger: [],
    closes: [],
    manualPrice: null, // { price, date } in position currency
    priceMode: 'auto', // 'auto' | 'manual'
    research: newResearch(),
    createdAt: new Date().toISOString(),
  };
}

export function newResearch() {
  return { thesis: '', conviction: 0, targetPrice: null, stopPrice: null, horizon: '', chatUrl: '', sources: [], log: [], risks: '' };
}

export function newIdea() {
  return { id: uid(), ticker: '', exchange: 'US', quoteCurrency: 'USD', currency: 'USD', side: 'long', status: 'watching', createdAt: new Date().toISOString(), research: newResearch() };
}

// ---------------------------------------------------------------- load / save

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function load() {
  const s = storage();
  if (!s) return defaultState();
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    return normalise(JSON.parse(raw));
  } catch (e) {
    console.error('Could not read saved data', e);
    return defaultState();
  }
}

export function save(state) {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (e) {
    console.error('Could not save', e);
    return false;
  }
}

export function clearAll() {
  const s = storage();
  if (s) s.removeItem(STORAGE_KEY);
}

// ---------------------------------------------------------------- export / import

export function exportJSON(state, { includeKeys = false } = {}) {
  const copy = JSON.parse(JSON.stringify(state));
  if (!includeKeys) copy.settings.apiKeys = {};
  copy.exportedAt = new Date().toISOString();
  copy.app = 'portfolio-tracker';
  return JSON.stringify(copy, null, 2);
}

/** Parse and validate an import. Returns { state, summary } or throws with a readable message. */
export function parseImport(text, current, { mode = 'replace' } = {}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.positions)) {
    throw new Error('That file does not look like a portfolio export (no positions list).');
  }
  const incoming = normalise(data);
  if (mode === 'merge' && current) {
    const merged = JSON.parse(JSON.stringify(current));
    const byId = new Map(merged.positions.map((p) => [p.id, p]));
    for (const p of incoming.positions) byId.set(p.id, p);
    merged.positions = [...byId.values()];
    const ideaIds = new Map(merged.ideas.map((p) => [p.id, p]));
    for (const p of incoming.ideas) ideaIds.set(p.id, p);
    merged.ideas = [...ideaIds.values()];
    const snapByDate = new Map(merged.snapshots.map((s) => [s.date, s]));
    for (const s of incoming.snapshots) if (!snapByDate.has(s.date)) snapByDate.set(s.date, s);
    merged.snapshots = [...snapByDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    return { state: merged, summary: `Merged ${incoming.positions.length} positions, ${incoming.ideas.length} ideas, ${incoming.snapshots.length} snapshots.` };
  }
  // replace: keep current API keys unless the import carries some
  if (current && (!incoming.settings.apiKeys || !Object.keys(incoming.settings.apiKeys).length)) {
    incoming.settings.apiKeys = current.settings.apiKeys || {};
  }
  return { state: incoming, summary: `Loaded ${incoming.positions.length} positions, ${incoming.ideas.length} ideas, ${incoming.snapshots.length} snapshots.` };
}

// ---------------------------------------------------------------- normalise

const str = (v, d = '') => (typeof v === 'string' ? v : v == null ? d : String(v));
const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export function normaliseResearch(r) {
  const base = newResearch();
  if (!r || typeof r !== 'object') return base;
  return {
    thesis: str(r.thesis),
    conviction: Math.min(5, Math.max(0, Math.round(num(r.conviction)))),
    targetPrice: numOrNull(r.targetPrice),
    stopPrice: numOrNull(r.stopPrice),
    horizon: str(r.horizon),
    chatUrl: str(r.chatUrl),
    risks: str(r.risks),
    sources: (Array.isArray(r.sources) ? r.sources : []).map((s) => ({ title: str(s && s.title), url: str(s && s.url) })).filter((s) => s.title || s.url),
    log: (Array.isArray(r.log) ? r.log : []).map((l) => ({ id: str(l && l.id) || uid(), date: str(l && l.date), text: str(l && l.text) })).filter((l) => l.text),
  };
}

export function normalisePosition(p, settings) {
  const base = newPosition(settings);
  if (!p || typeof p !== 'object') return base;
  const ex = EXCHANGES.find((e) => e.id === p.exchange) || EXCHANGES[0];
  const f = p.financing || {};
  return {
    ...base,
    id: str(p.id) || base.id,
    ticker: str(p.ticker).trim().toUpperCase(),
    exchange: ex.id,
    quoteCurrency: str(p.quoteCurrency) || ex.quoteCurrency,
    currency: str(p.currency) || base.currency,
    side: p.side === 'short' ? 'short' : 'long',
    quantity: num(p.quantity),
    entryPrice: num(p.entryPrice),
    entryDate: str(p.entryDate) || base.entryDate,
    leverage: Math.max(1, num(p.leverage, 1)),
    notes: str(p.notes),
    costs: {
      openCommission: num(p.costs && p.costs.openCommission),
      fxFee: num(p.costs && p.costs.fxFee),
      stampDuty: num(p.costs && p.costs.stampDuty),
      other: num(p.costs && p.costs.other),
    },
    financing: {
      method: ['borrowed', 'notional', 'fixed'].includes(f.method) ? f.method : 'borrowed',
      rate: num(f.rate),
      perNight: num(f.perNight),
      dayCount: num(f.dayCount, 365) === 360 ? 360 : 365,
      weekendMode: f.weekendMode === 'triple' ? 'triple' : 'calendar',
      tripleDay: Number.isInteger(f.tripleDay) ? f.tripleDay : 3,
      rateChanges: (Array.isArray(f.rateChanges) ? f.rateChanges : []).map((c) => ({ from: str(c && c.from), rate: num(c && c.rate) })).filter((c) => c.from),
    },
    ledger: (Array.isArray(p.ledger) ? p.ledger : [])
      .map((l) => ({ id: str(l && l.id) || uid(), date: str(l && l.date), type: ['financing', 'dividend', 'fee'].includes(l && l.type) ? l.type : 'fee', amount: num(l && l.amount), note: str(l && l.note) }))
      .filter((l) => l.date),
    closes: (Array.isArray(p.closes) ? p.closes : [])
      .map((c) => ({ id: str(c && c.id) || uid(), date: str(c && c.date), quantity: num(c && c.quantity), price: num(c && c.price), commission: num(c && c.commission), fxFee: num(c && c.fxFee), other: num(c && c.other), note: str(c && c.note) }))
      .filter((c) => c.date && c.quantity > 0),
    manualPrice: p.manualPrice && Number.isFinite(Number(p.manualPrice.price)) ? { price: Number(p.manualPrice.price), date: str(p.manualPrice.date) } : null,
    priceMode: p.priceMode === 'manual' ? 'manual' : 'auto',
    research: normaliseResearch(p.research),
    createdAt: str(p.createdAt) || base.createdAt,
  };
}

export function normaliseIdea(i) {
  const base = newIdea();
  if (!i || typeof i !== 'object') return base;
  const ex = EXCHANGES.find((e) => e.id === i.exchange) || EXCHANGES[0];
  return {
    ...base,
    id: str(i.id) || base.id,
    ticker: str(i.ticker).trim().toUpperCase(),
    exchange: ex.id,
    quoteCurrency: str(i.quoteCurrency) || ex.quoteCurrency,
    currency: str(i.currency) || 'USD',
    side: i.side === 'short' ? 'short' : 'long',
    status: ['watching', 'opened', 'rejected'].includes(i.status) ? i.status : 'watching',
    positionId: str(i.positionId) || '',
    createdAt: str(i.createdAt) || base.createdAt,
    research: normaliseResearch(i.research),
  };
}

export function normalise(data) {
  const d = defaultState();
  const s = (data && data.settings) || {};
  const ds = d.settings;
  const settings = {
    ...ds,
    ...s,
    baseCurrency: str(s.baseCurrency) || ds.baseCurrency,
    maintenanceMargin: num(s.maintenanceMargin),
    cash: num(s.cash),
    provider: str(s.provider) || 'manual',
    apiKeys: s.apiKeys && typeof s.apiKeys === 'object' ? { ...s.apiKeys } : {},
    refreshSeconds: Math.max(15, num(s.refreshSeconds, ds.refreshSeconds)),
    benchmark: { ...ds.benchmark, ...(s.benchmark || {}) },
    defaults: { ...ds.defaults, ...(s.defaults || {}), financing: { ...ds.defaults.financing, ...((s.defaults && s.defaults.financing) || {}) } },
  };
  return {
    version: SCHEMA_VERSION,
    settings,
    positions: (Array.isArray(data && data.positions) ? data.positions : []).map((p) => normalisePosition(p, settings)),
    ideas: (Array.isArray(data && data.ideas) ? data.ideas : []).map(normaliseIdea),
    snapshots: (Array.isArray(data && data.snapshots) ? data.snapshots : []).filter((x) => x && x.date),
    quotes: data && data.quotes && typeof data.quotes === 'object' ? data.quotes : {},
    fx: data && data.fx && typeof data.fx === 'object' ? { rates: data.fx.rates || {}, time: data.fx.time || null, base: data.fx.base || null } : d.fx,
  };
}
