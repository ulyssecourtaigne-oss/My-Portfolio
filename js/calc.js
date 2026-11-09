// calc.js — all portfolio maths. Pure functions, no DOM, no storage, no network.
// Dates are 'YYYY-MM-DD' strings interpreted in UTC. Money is in the position's own currency
// unless a function says otherwise. Rates are decimals (0.073 = 7.3 % a year).

// ---------------------------------------------------------------- dates

const DAY_MS = 86400000;

export function parseDate(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return Date.UTC(y, m - 1, d);
}

export function formatDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function todayISO(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function addDays(s, n) {
  return formatDate(parseDate(s) + n * DAY_MS);
}

/** 0 = Sunday … 6 = Saturday */
export function weekdayOf(s) {
  return new Date(parseDate(s)).getUTCDay();
}

/** Calendar nights between two dates (never negative). */
export function nightsBetween(from, to) {
  const a = parseDate(from);
  const b = parseDate(to);
  if (a == null || b == null) return 0;
  return Math.max(0, Math.round((b - a) / DAY_MS));
}

/** How many times the nightly charge applies on the night that starts on `date`. */
export function nightMultiplier(date, financing) {
  if (!financing || financing.weekendMode !== 'triple') return 1;
  const wd = weekdayOf(date);
  if (wd === 0 || wd === 6) return 0;
  const tripleDay = Number.isInteger(financing.tripleDay) ? financing.tripleDay : 3;
  return wd === tripleDay ? 3 : 1;
}

// ---------------------------------------------------------------- helpers

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const sign = (side) => (side === 'short' ? -1 : 1);

function rateOn(date, financing) {
  let rate = num(financing.rate);
  const changes = Array.isArray(financing.rateChanges) ? financing.rateChanges : [];
  const sorted = [...changes].filter((c) => c && c.from).sort((a, b) => (a.from < b.from ? -1 : 1));
  for (const c of sorted) if (c.from <= date) rate = num(c.rate);
  return rate;
}

/** Base nightly estimate (before weekend multiplier) for `qty` units open on `date`. */
export function baseNightlyCharge(pos, qty, date) {
  const f = pos.financing || {};
  const method = f.method || 'borrowed';
  const dayCount = num(f.dayCount, 365) === 360 ? 360 : 365;
  const lev = Math.max(1, num(pos.leverage, 1));
  const entry = num(pos.entryPrice);
  const notional = qty * entry;
  if (method === 'fixed') {
    const total = Math.max(0, num(pos.quantity));
    return total > 0 ? num(f.perNight) * (qty / total) : 0;
  }
  const rate = rateOn(date, f);
  if (method === 'notional') return (notional * rate) / dayCount;
  const borrowed = notional - notional / lev;
  return (borrowed * rate) / dayCount;
}

function sortedCloses(pos) {
  return (pos.closes || [])
    .filter((c) => c && c.date && num(c.quantity) > 0)
    .map((c) => ({ ...c, quantity: num(c.quantity), price: num(c.price) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Units still open at the START of `date` (closes dated before `date` removed). */
function openAtStartOf(pos, closes, date) {
  let q = num(pos.quantity);
  for (const c of closes) if (c.date < date) q -= c.quantity;
  return Math.max(0, q);
}

/** Units open during the night that starts on `date` (closes dated on or before `date` removed). */
function openDuringNight(pos, closes, date) {
  let q = num(pos.quantity);
  for (const c of closes) if (c.date <= date) q -= c.quantity;
  return Math.max(0, q);
}

// ---------------------------------------------------------------- position

/**
 * @param pos  position record (see README for the schema)
 * @param opts { price, asOf, maintenanceMargin }
 */
export function calcPosition(pos, opts = {}) {
  const asOf = opts.asOf || todayISO();
  const price = opts.price == null || opts.price === '' ? null : num(opts.price, NaN);
  const hasPrice = Number.isFinite(price);
  const maint = Math.max(0, num(opts.maintenanceMargin, 0));
  const s = sign(pos.side);
  const qtyTotal = num(pos.quantity);
  const entry = num(pos.entryPrice);
  const lev = Math.max(1, num(pos.leverage, 1));
  const closes = sortedCloses(pos);
  const qtyClosed = Math.min(qtyTotal, closes.reduce((a, c) => a + c.quantity, 0));
  const qtyOpen = Math.max(0, qtyTotal - qtyClosed);
  const isClosed = qtyOpen <= 0;
  const lastCloseDate = closes.length ? closes[closes.length - 1].date : null;
  // Financing stops when the position is fully closed.
  const financingEnd = isClosed && lastCloseDate && lastCloseDate < asOf ? lastCloseDate : asOf;

  // ---- nightly financing schedule, with actual ledger charges replacing estimates
  const ledger = (pos.ledger || []).filter((l) => l && l.date);
  const actualByNight = new Map();
  for (const l of ledger) {
    if (l.type !== 'financing') continue;
    actualByNight.set(l.date, num(actualByNight.get(l.date)) + num(l.amount));
  }
  const nightly = [];
  let estimated = 0;
  let actual = 0;
  let applied = 0;
  let nightsWithActual = 0;
  const accrualByDate = new Map(); // per-unit cumulative applied financing before a given date
  let perUnitCum = 0;
  const entryDate = pos.entryDate;
  const nights = nightsBetween(entryDate, financingEnd);
  for (let i = 0; i < nights; i++) {
    const date = addDays(entryDate, i);
    accrualByDate.set(date, perUnitCum);
    const q = openDuringNight(pos, closes, date);
    const mult = nightMultiplier(date, pos.financing);
    const est = q > 0 ? baseNightlyCharge(pos, q, date) * mult : 0;
    const hasActual = actualByNight.has(date);
    const act = hasActual ? actualByNight.get(date) : null;
    const app = hasActual ? act : est;
    estimated += est;
    if (hasActual) {
      actual += act;
      nightsWithActual++;
    }
    applied += app;
    if (q > 0) perUnitCum += app / q;
    nightly.push({ date, qtyOpen: q, multiplier: mult, estimated: est, actual: act, applied: app });
  }
  accrualByDate.set(addDays(entryDate, nights), perUnitCum);
  const accruedPerUnitAt = (date) => {
    if (accrualByDate.has(date)) return accrualByDate.get(date);
    return date <= entryDate ? 0 : perUnitCum;
  };
  // Any actual financing charge dated outside the schedule is still real money: count it as realised/unrealised extra.
  let actualOutside = 0;
  for (const [date, amt] of actualByNight) {
    if (!accrualByDate.has(date) || date === addDays(entryDate, nights)) {
      if (nightsBetween(entryDate, date) >= nights) {
        actualOutside += amt;
        actual += amt;
        applied += amt;
      }
    }
  }

  // ---- split financing into realised (closed units) and unrealised (open units)
  let financingRealised = 0;
  for (const c of closes) financingRealised += c.quantity * accruedPerUnitAt(c.date);
  let financingUnrealised = qtyOpen * perUnitCum;
  if (isClosed) financingRealised += actualOutside;
  else financingUnrealised += actualOutside;

  // ---- opening fees, pro-rata by units
  const costs = pos.costs || {};
  const feesOpen = num(costs.openCommission) + num(costs.fxFee) + num(costs.stampDuty) + num(costs.other);
  const feesOpenPerUnit = qtyTotal > 0 ? feesOpen / qtyTotal : 0;
  const feesOpenRealised = feesOpenPerUnit * qtyClosed;
  const feesOpenUnrealised = feesOpenPerUnit * qtyOpen;
  const feesClose = closes.reduce((a, c) => a + num(c.commission) + num(c.fxFee) + num(c.other), 0);

  // ---- dated ledger items (dividends +received/−paid, fees +charge) split by open units on their date
  let divTotal = 0;
  let divRealised = 0;
  let divUnrealised = 0;
  let feesLedger = 0;
  let feesLedgerRealised = 0;
  let feesLedgerUnrealised = 0;
  for (const l of ledger) {
    if (l.type !== 'dividend' && l.type !== 'fee') continue;
    const amt = num(l.amount);
    const qStart = openAtStartOf(pos, closes, l.date);
    // units that remain open now, among those open at the item's date
    const openNowShare = qStart > 0 ? Math.min(qtyOpen, qStart) / qStart : 0;
    const unreal = amt * openNowShare;
    const real = amt - unreal;
    if (l.type === 'dividend') {
      divTotal += amt;
      divRealised += real;
      divUnrealised += unreal;
    } else {
      feesLedger += amt;
      feesLedgerRealised += real;
      feesLedgerUnrealised += unreal;
    }
  }

  // ---- realised
  let realisedGross = 0;
  for (const c of closes) realisedGross += s * (c.price - entry) * c.quantity;
  const realisedCosts = feesOpenRealised + feesClose + financingRealised + feesLedgerRealised - divRealised;
  const realisedNet = realisedGross - realisedCosts;

  // ---- open side
  const notionalOpen = qtyOpen * entry;
  const margin = notionalOpen / lev;
  const borrowed = notionalOpen - margin;
  const currentValue = hasPrice && !isClosed ? qtyOpen * price : isClosed ? 0 : null;
  const grossUnrealised = isClosed ? 0 : hasPrice ? s * (price - entry) * qtyOpen : null;
  const totalCostsUnrealised = feesOpenUnrealised + financingUnrealised + feesLedgerUnrealised - divUnrealised;
  const netUnrealised = grossUnrealised == null ? null : grossUnrealised - totalCostsUnrealised;
  const returnOnMargin = netUnrealised == null || margin <= 0 ? null : netUnrealised / margin;
  const returnOnNotional = netUnrealised == null || notionalOpen <= 0 ? null : netUnrealised / notionalOpen;
  const breakEven = isClosed || qtyOpen <= 0 ? null : entry + (s * totalCostsUnrealised) / qtyOpen;

  let marginCallPrice = null;
  if (!isClosed && qtyOpen > 0) {
    if (s > 0) {
      const denom = qtyOpen * (1 - maint);
      marginCallPrice = denom > 0 ? (qtyOpen * entry - margin) / denom : null;
    } else {
      marginCallPrice = (margin + qtyOpen * entry) / (qtyOpen * (1 + maint));
    }
    if (marginCallPrice != null && marginCallPrice < 0) marginCallPrice = 0;
  }

  // ---- tonight
  const perNight = isClosed ? 0 : baseNightlyCharge(pos, qtyOpen, asOf);
  const nextNightCost = isClosed ? 0 : perNight * nightMultiplier(asOf, pos.financing);

  const totalCosts = realisedCosts + totalCostsUnrealised;
  return {
    id: pos.id,
    asOf,
    price: hasPrice ? price : null,
    isClosed,
    qtyOpen,
    qtyClosed,
    notionalOpen,
    margin,
    borrowed,
    currentValue,
    nights,
    nightly,
    perNight,
    nextNightCost,
    financing: {
      estimated,
      actual,
      applied,
      nightsWithActual,
      realised: financingRealised,
      unrealised: financingUnrealised,
    },
    fees: {
      open: feesOpen,
      openRealised: feesOpenRealised,
      openUnrealised: feesOpenUnrealised,
      close: feesClose,
      ledger: feesLedger,
    },
    dividends: { total: divTotal, realised: divRealised, unrealised: divUnrealised },
    grossUnrealised,
    totalCostsUnrealised,
    netUnrealised,
    returnOnMargin,
    returnOnNotional,
    breakEven,
    marginCallPrice,
    realised: { gross: realisedGross, costs: realisedCosts, net: realisedNet },
    totals: {
      gross: realisedGross + (grossUnrealised ?? 0),
      costs: totalCosts,
      net: realisedNet + (netUnrealised ?? 0),
    },
  };
}

// ---------------------------------------------------------------- portfolio

/**
 * @param positions array of position records
 * @param opts {
 *   asOf, baseCurrency, fx: { CCY: baseUnitsPerOneCcy }, prices: { [id]: { price, prevClose } },
 *   maintenanceMargin, cash
 * }
 */
export function calcPortfolio(positions, opts = {}) {
  const base = opts.baseCurrency || 'GBP';
  const fx = { ...(opts.fx || {}) };
  fx[base] = 1;
  const prices = opts.prices || {};
  const rows = [];
  const warnings = [];
  const t = {
    equity: 0,
    exposure: 0,
    netExposure: 0,
    marginUsed: 0,
    borrowed: 0,
    todayChange: 0,
    unrealised: 0,
    realised: 0,
    costsToDate: 0,
    nextNightCost: 0,
    effectiveLeverage: null,
    priced: 0,
    unpriced: 0,
  };
  const byCurrency = {};
  const byPosition = [];

  for (const pos of positions || []) {
    const q = prices[pos.id] || {};
    const r = calcPosition(pos, { price: q.price, asOf: opts.asOf, maintenanceMargin: opts.maintenanceMargin });
    const rate = fx[pos.currency];
    const fxMissing = !Number.isFinite(rate) || rate <= 0;
    const toBase = (v) => (v == null || fxMissing ? null : v * rate);
    const sgn = sign(pos.side);
    const prevClose = Number.isFinite(Number(q.prevClose)) ? Number(q.prevClose) : null;
    const todayChange = !r.isClosed && r.price != null && prevClose != null ? sgn * (r.price - prevClose) * r.qtyOpen : null;
    const row = {
      ...r,
      position: pos,
      fxRate: fxMissing ? null : rate,
      fxMissing,
      todayChange,
      base: {
        currentValue: toBase(r.currentValue),
        margin: toBase(r.margin),
        borrowed: toBase(r.borrowed),
        grossUnrealised: toBase(r.grossUnrealised),
        netUnrealised: toBase(r.netUnrealised),
        realisedNet: toBase(r.realised.net),
        totalCosts: toBase(r.totals.costs),
        nextNightCost: toBase(r.nextNightCost),
        todayChange: toBase(todayChange),
      },
    };
    rows.push(row);
    if (fxMissing) {
      warnings.push(`No FX rate for ${pos.currency}; ${pos.ticker} is excluded from base-currency totals.`);
      continue;
    }
    t.realised += row.base.realisedNet;
    t.costsToDate += row.base.totalCosts;
    if (r.isClosed) continue;
    t.marginUsed += row.base.margin;
    t.borrowed += row.base.borrowed;
    t.nextNightCost += row.base.nextNightCost;
    if (r.price == null) {
      t.unpriced++;
      continue;
    }
    t.priced++;
    t.exposure += row.base.currentValue;
    t.netExposure += sgn * row.base.currentValue;
    t.unrealised += row.base.netUnrealised;
    if (row.base.todayChange != null) t.todayChange += row.base.todayChange;
    byCurrency[pos.currency] = num(byCurrency[pos.currency]) + row.base.currentValue;
    byPosition.push({ id: pos.id, label: pos.ticker, value: row.base.currentValue, side: pos.side });
  }
  t.equity = num(opts.cash) + t.marginUsed + t.unrealised;
  t.effectiveLeverage = t.equity > 0 ? t.exposure / t.equity : null;
  return { totals: t, rows, warnings, allocation: { byCurrency, byPosition }, baseCurrency: base };
}

// ---------------------------------------------------------------- snapshots / benchmark

/** Build chart series from daily snapshots and benchmark closes, indexed from the first common day. */
export function benchmarkSeries(snapshots, benchmarkCloses) {
  const snaps = [...(snapshots || [])].filter((s) => s && s.date).sort((a, b) => (a.date < b.date ? -1 : 1));
  const bench = benchmarkCloses || {};
  const out = [];
  let startEquity = null;
  let startBench = null;
  for (const s of snaps) {
    const b = bench[s.date];
    if (startEquity == null && Number.isFinite(s.equity) && s.equity > 0) startEquity = s.equity;
    if (startBench == null && Number.isFinite(b) && b > 0) startBench = b;
    out.push({
      date: s.date,
      equity: s.equity,
      netPnl: num(s.unrealised) + num(s.realised),
      equityIndex: startEquity && Number.isFinite(s.equity) ? (s.equity / startEquity) * 100 : null,
      benchIndex: startBench && Number.isFinite(b) ? (b / startBench) * 100 : null,
    });
  }
  return out;
}
