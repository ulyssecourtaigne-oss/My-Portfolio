import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calcPosition,
  calcPortfolio,
  nightsBetween,
  nightMultiplier,
  addDays,
  weekdayOf,
} from '../js/calc.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

function basePosition(overrides = {}) {
  return {
    id: 'p1',
    ticker: 'TEST',
    exchange: 'US',
    currency: 'USD',
    side: 'long',
    quantity: 100,
    entryPrice: 50,
    entryDate: '2026-01-05',
    leverage: 5,
    costs: { openCommission: 5, fxFee: 0, stampDuty: 0, other: 0 },
    financing: {
      method: 'borrowed',
      rate: 0.073,
      perNight: 0,
      dayCount: 365,
      weekendMode: 'calendar',
      tripleDay: 3,
      rateChanges: [],
    },
    ledger: [],
    closes: [],
    ...overrides,
  };
}

// ---------- date helpers ----------

test('nightsBetween counts calendar nights', () => {
  assert.equal(nightsBetween('2026-01-05', '2026-01-15'), 10);
  assert.equal(nightsBetween('2026-01-05', '2026-01-05'), 0);
  assert.equal(nightsBetween('2026-01-05', '2026-01-01'), 0); // never negative
});

test('weekdayOf and addDays use UTC dates', () => {
  assert.equal(weekdayOf('2026-01-05'), 1); // Monday
  assert.equal(weekdayOf('2026-01-10'), 6); // Saturday
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
});

test('nightMultiplier: calendar mode charges every night once', () => {
  for (const d of ['2026-01-09', '2026-01-10', '2026-01-11', '2026-01-07']) {
    assert.equal(nightMultiplier(d, { weekendMode: 'calendar', tripleDay: 3 }), 1);
  }
});

test('nightMultiplier: triple mode skips Sat/Sun and triples the chosen day', () => {
  const f = { weekendMode: 'triple', tripleDay: 3 }; // Wednesday
  assert.equal(nightMultiplier('2026-01-10', f), 0); // Sat
  assert.equal(nightMultiplier('2026-01-11', f), 0); // Sun
  assert.equal(nightMultiplier('2026-01-07', f), 3); // Wed
  assert.equal(nightMultiplier('2026-01-09', f), 1); // Fri
});

// ---------- the user's acceptance test ----------

test('acceptance: long 100 @ $50, 5x, 7.3% on borrowed, 365, 10 nights, $5 commission, price $55', () => {
  const pos = basePosition();
  const r = calcPosition(pos, { price: 55, asOf: '2026-01-15', maintenanceMargin: 0.5 });
  close(r.margin, 1000);
  close(r.borrowed, 4000);
  close(r.perNight, 0.8);
  assert.equal(r.nights, 10);
  close(r.financing.estimated, 8);
  close(r.financing.applied, 8);
  close(r.grossUnrealised, 500);
  close(r.totalCostsUnrealised, 13);
  close(r.netUnrealised, 487);
  close(r.returnOnMargin, 0.487);
  close(r.returnOnNotional, 487 / 5000);
  close(r.breakEven, 50.13);
  close(r.currentValue, 5500);
});

test('margin-call price: long, maintenance margin as % of position value', () => {
  const pos = basePosition();
  // equity = margin + (P-entry)*qty = m * qty * P  =>  P = (qty*entry - margin) / (qty*(1-m))
  const r = calcPosition(pos, { price: 55, asOf: '2026-01-15', maintenanceMargin: 0.1 });
  close(r.marginCallPrice, (100 * 50 - 1000) / (100 * 0.9));
  // with 0% maintenance the call price is where all margin is lost
  const r0 = calcPosition(pos, { price: 55, asOf: '2026-01-15', maintenanceMargin: 0 });
  close(r0.marginCallPrice, 40);
});

// ---------- shorts ----------

test('short position: P&L sign, break-even and margin call', () => {
  const pos = basePosition({ side: 'short' });
  const r = calcPosition(pos, { price: 45, asOf: '2026-01-15', maintenanceMargin: 0 });
  close(r.grossUnrealised, 500); // (50-45)*100
  close(r.netUnrealised, 487);
  close(r.breakEven, 50 - 0.13); // short break-even is below entry
  // short margin call with m=0: margin + (entry-P)*qty = 0 => P = entry + margin/qty = 60
  close(r.marginCallPrice, 60);
  const rLoss = calcPosition(pos, { price: 55, asOf: '2026-01-15', maintenanceMargin: 0 });
  close(rLoss.grossUnrealised, -500);
});

test('short with 10% maintenance: P = (margin + qty*entry) / (qty*(1+m))', () => {
  const pos = basePosition({ side: 'short' });
  const r = calcPosition(pos, { price: 50, asOf: '2026-01-15', maintenanceMargin: 0.1 });
  close(r.marginCallPrice, (1000 + 5000) / (100 * 1.1));
});

// ---------- financing methods ----------

test('financing on full position value (notional)', () => {
  const pos = basePosition({ financing: { ...basePosition().financing, method: 'notional' } });
  const r = calcPosition(pos, { price: 55, asOf: '2026-01-15' });
  close(r.perNight, 5000 * 0.073 / 365); // 1.0
  close(r.financing.estimated, 10);
});

test('fixed amount per night', () => {
  const pos = basePosition({ financing: { ...basePosition().financing, method: 'fixed', perNight: 1.25 } });
  const r = calcPosition(pos, { price: 55, asOf: '2026-01-15' });
  close(r.perNight, 1.25);
  close(r.financing.estimated, 12.5);
});

test('360-day count', () => {
  const pos = basePosition({ financing: { ...basePosition().financing, dayCount: 360 } });
  const r = calcPosition(pos, { price: 55, asOf: '2026-01-15' });
  close(r.perNight, 4000 * 0.073 / 360);
});

test('no financing when leverage is 1 and method is borrowed', () => {
  const pos = basePosition({ leverage: 1 });
  const r = calcPosition(pos, { price: 55, asOf: '2026-01-15' });
  close(r.borrowed, 0);
  close(r.margin, 5000);
  close(r.financing.estimated, 0);
});

test('triple-charge weekend mode: Fri->Mon is one night, a full week equals calendar', () => {
  const triple = { ...basePosition().financing, weekendMode: 'triple', tripleDay: 3 };
  const friToMon = calcPosition(basePosition({ entryDate: '2026-01-09', financing: triple }), { price: 50, asOf: '2026-01-12' });
  close(friToMon.financing.estimated, 0.8); // only Friday night charged
  const fullWeek = calcPosition(basePosition({ entryDate: '2026-01-05', financing: triple }), { price: 50, asOf: '2026-01-12' });
  close(fullWeek.financing.estimated, 7 * 0.8); // Mon,Tue,Wed×3,Thu,Fri = 7 charges
  assert.equal(fullWeek.nights, 7);
});

test('rate changes apply from their start date', () => {
  const fin = { ...basePosition().financing, rateChanges: [{ from: '2026-01-10', rate: 0.146 }] };
  const r = calcPosition(basePosition({ financing: fin }), { price: 50, asOf: '2026-01-15' });
  // 5 nights at 0.80 + 5 nights at 1.60
  close(r.financing.estimated, 5 * 0.8 + 5 * 1.6);
  close(r.perNight, 1.6); // current rate
});

test('next-night cost honours the triple multiplier for tonight', () => {
  const triple = { ...basePosition().financing, weekendMode: 'triple', tripleDay: 3 };
  const wed = calcPosition(basePosition({ financing: triple }), { price: 50, asOf: '2026-01-07' });
  close(wed.nextNightCost, 2.4);
  const sat = calcPosition(basePosition({ financing: triple }), { price: 50, asOf: '2026-01-10' });
  close(sat.nextNightCost, 0);
});

// ---------- actual charges replace estimates ----------

test('ledger: actual financing for a night replaces the estimate for that night only', () => {
  const pos = basePosition({
    ledger: [
      { id: 'l1', date: '2026-01-06', type: 'financing', amount: 1.1 },
      { id: 'l2', date: '2026-01-07', type: 'financing', amount: 0.9 },
    ],
  });
  const r = calcPosition(pos, { price: 55, asOf: '2026-01-15' });
  close(r.financing.estimated, 8); // pure estimate, all 10 nights
  close(r.financing.actual, 2.0); // what the broker charged
  close(r.financing.applied, 8 - 1.6 + 2.0); // 8 nights estimated + 2 nights actual
  assert.equal(r.financing.nightsWithActual, 2);
  close(r.netUnrealised, 500 - 5 - r.financing.applied);
  const row = r.nightly.find((n) => n.date === '2026-01-06');
  close(row.estimated, 0.8);
  close(row.actual, 1.1);
  close(row.applied, 1.1);
});

test('ledger: two actual entries on the same night are summed', () => {
  const pos = basePosition({
    ledger: [
      { id: 'l1', date: '2026-01-06', type: 'financing', amount: 0.5 },
      { id: 'l2', date: '2026-01-06', type: 'financing', amount: 0.4 },
    ],
  });
  const r = calcPosition(pos, { price: 55, asOf: '2026-01-15' });
  close(r.financing.applied, 8 - 0.8 + 0.9);
});

test('ledger: dividends received reduce costs, dividends paid increase them; fees add', () => {
  const pos = basePosition({
    ledger: [
      { id: 'd1', date: '2026-01-08', type: 'dividend', amount: 20 }, // received
      { id: 'd2', date: '2026-01-09', type: 'dividend', amount: -5 }, // paid
      { id: 'f1', date: '2026-01-09', type: 'fee', amount: 2, note: 'adjustment' },
    ],
  });
  const r = calcPosition(pos, { price: 55, asOf: '2026-01-15' });
  close(r.dividends.total, 15);
  close(r.fees.ledger, 2);
  close(r.totalCostsUnrealised, 5 + 8 + 2 - 15);
  close(r.netUnrealised, 500 - 0);
});

// ---------- partial and full closes ----------

test('partial close: realised P&L, pro-rata opening costs, financing follows open quantity', () => {
  const pos = basePosition({
    closes: [{ id: 'c1', date: '2026-01-10', quantity: 40, price: 52, commission: 2, fxFee: 0, other: 0 }],
  });
  const r = calcPosition(pos, { price: 55, asOf: '2026-01-15' });
  assert.equal(r.qtyOpen, 60);
  assert.equal(r.qtyClosed, 40);
  close(r.margin, 600);
  close(r.borrowed, 2400);
  close(r.notionalOpen, 3000);
  close(r.currentValue, 3300);
  close(r.realised.gross, 80); // (52-50)*40
  // financing: 5 nights on 100 units @0.80 = 4.00 -> 0.04/unit ; then 5 nights on 60 units @0.48 = 2.40 -> 0.04/unit
  close(r.financing.estimated, 6.4);
  close(r.financing.realised, 40 * 0.04); // 1.60 accrued by the closed units before 2026-01-10
  close(r.financing.unrealised, 60 * 0.08); // 4.80
  close(r.fees.openRealised, 2); // 40% of $5
  close(r.fees.openUnrealised, 3);
  close(r.fees.close, 2);
  close(r.realised.costs, 2 + 2 + 1.6);
  close(r.realised.net, 80 - 5.6);
  close(r.grossUnrealised, 300); // (55-50)*60
  close(r.totalCostsUnrealised, 3 + 4.8);
  close(r.netUnrealised, 300 - 7.8);
  close(r.perNight, 0.48); // tonight's estimate on the remaining 60 units
  close(r.breakEven, 50 + 7.8 / 60);
  close(r.returnOnMargin, (300 - 7.8) / 600);
});

test('partial close on a short realises (entry - close) * qty', () => {
  const pos = basePosition({
    side: 'short',
    closes: [{ id: 'c1', date: '2026-01-10', quantity: 50, price: 48, commission: 0, fxFee: 0, other: 0 }],
  });
  const r = calcPosition(pos, { price: 48, asOf: '2026-01-15' });
  close(r.realised.gross, 100);
  close(r.grossUnrealised, 100);
});

test('full close: position is closed, nothing unrealised, financing stops', () => {
  const pos = basePosition({
    closes: [
      { id: 'c1', date: '2026-01-08', quantity: 50, price: 52, commission: 0, fxFee: 0, other: 0 },
      { id: 'c2', date: '2026-01-10', quantity: 50, price: 54, commission: 1, fxFee: 0, other: 0 },
    ],
  });
  const r = calcPosition(pos, { price: 99, asOf: '2026-03-01' });
  assert.equal(r.isClosed, true);
  assert.equal(r.qtyOpen, 0);
  close(r.grossUnrealised, 0);
  close(r.netUnrealised, 0);
  close(r.margin, 0);
  close(r.realised.gross, 100 + 200);
  // financing: 3 nights × 0.80 on 100 units = 2.40, then 2 nights × 0.40 on 50 units = 0.80; none after 01-10
  close(r.financing.estimated, 3.2);
  close(r.financing.realised, 3.2);
  close(r.financing.unrealised, 0);
  close(r.realised.costs, 5 + 1 + 3.2);
  close(r.realised.net, 300 - 9.2);
  assert.equal(r.breakEven, null);
  assert.equal(r.marginCallPrice, null);
  close(r.nextNightCost, 0);
});

test('a ledger item dated after a full close is attributed to realised', () => {
  const pos = basePosition({
    closes: [{ id: 'c1', date: '2026-01-08', quantity: 100, price: 52, commission: 0, fxFee: 0, other: 0 }],
    ledger: [{ id: 'd1', date: '2026-01-20', type: 'dividend', amount: 10 }],
  });
  const r = calcPosition(pos, { price: 52, asOf: '2026-02-01' });
  close(r.dividends.realised, 10);
  close(r.dividends.unrealised, 0);
});

test('missing price: value metrics are null but costs still compute', () => {
  const r = calcPosition(basePosition(), { price: null, asOf: '2026-01-15' });
  assert.equal(r.grossUnrealised, null);
  assert.equal(r.netUnrealised, null);
  close(r.financing.estimated, 8);
  close(r.margin, 1000);
});

// ---------- portfolio ----------

test('portfolio totals convert to base currency with FX and aggregate', () => {
  const usd = basePosition({ id: 'a' });
  const gbp = basePosition({
    id: 'b',
    ticker: 'LLOY',
    exchange: 'LSE',
    currency: 'GBP',
    quantity: 1000,
    entryPrice: 0.5,
    leverage: 1,
    costs: { openCommission: 0, fxFee: 0, stampDuty: 2.5, other: 0 },
  });
  const res = calcPortfolio([usd, gbp], {
    asOf: '2026-01-15',
    baseCurrency: 'GBP',
    fx: { USD: 0.8, GBP: 1 }, // 1 USD = 0.80 GBP
    prices: { a: { price: 55, prevClose: 54 }, b: { price: 0.55, prevClose: 0.55 } },
    maintenanceMargin: 0.5,
    cash: 100,
  });
  close(res.totals.exposure, 5500 * 0.8 + 550);
  close(res.totals.unrealised, 487 * 0.8 + (50 - 2.5));
  close(res.totals.marginUsed, 1000 * 0.8 + 500);
  close(res.totals.equity, 100 + 800 + 487 * 0.8 + 500 + 47.5);
  close(res.totals.effectiveLeverage, res.totals.exposure / res.totals.equity);
  close(res.totals.todayChange, 100 * 1 * 0.8);
  close(res.totals.nextNightCost, 0.8 * 0.8);
  close(res.totals.costsToDate, 13 * 0.8 + 2.5);
  close(res.totals.realised, 0);
  assert.equal(res.rows.length, 2);
  close(res.allocation.byCurrency.USD, 4400);
  close(res.allocation.byCurrency.GBP, 550);
  close(res.allocation.byPosition.find((x) => x.id === 'b').value, 550);
});

test('portfolio: a short reduces net exposure but adds to gross exposure and today change flips sign', () => {
  const s = basePosition({ id: 's', side: 'short' });
  const res = calcPortfolio([s], {
    asOf: '2026-01-15',
    baseCurrency: 'USD',
    fx: { USD: 1 },
    prices: { s: { price: 55, prevClose: 54 } },
  });
  close(res.totals.exposure, 5500);
  close(res.totals.netExposure, -5500);
  close(res.totals.todayChange, -100);
});

test('portfolio: missing FX rate marks the row and excludes it from base totals', () => {
  const k = basePosition({ id: 'k', currency: 'KRW', entryPrice: 70000, quantity: 10 });
  const res = calcPortfolio([k], {
    asOf: '2026-01-15',
    baseCurrency: 'GBP',
    fx: { GBP: 1 },
    prices: { k: { price: 71000 } },
  });
  assert.equal(res.rows[0].fxMissing, true);
  close(res.totals.exposure, 0);
  assert.ok(res.warnings.some((w) => w.includes('KRW')));
});
