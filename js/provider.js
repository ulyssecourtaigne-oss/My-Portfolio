// provider.js — the ONLY file that talks to price/FX APIs. Swap or add providers here.
//
// Every provider implements:
//   id, label, needsKey, signupUrl, docsUrl,
//   limits: { perMinute, perDay }            → the scheduler stays inside these
//   covers(exchange) → boolean               → which exchanges this provider can quote
//   symbol(ticker, exchange) → string         → provider-specific symbol
//   quote(ticker, exchange, key) → Promise<{ price, prevClose, time (ms), currency|null }>
//
// FX comes from Frankfurter (ECB reference rates, free, no key, CORS enabled) unless the
// chosen provider defines fx(). GBX (pence) is handled in convertPrice().

const json = async (url) => {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

export const PROVIDERS = {
  manual: {
    id: 'manual',
    label: 'Manual prices only (no API)',
    needsKey: false,
    signupUrl: '',
    docsUrl: '',
    limits: { perMinute: 0, perDay: 0 },
    covers: () => false,
    symbol: (t) => t,
    quote: async () => {
      throw new Error('Manual provider has no live quotes');
    },
  },

  eodhd: {
    id: 'eodhd',
    label: 'EODHD (All World plan: US, London, Amsterdam, Korea; ~15 min delayed)',
    needsKey: true,
    signupUrl: 'https://eodhd.com/register',
    docsUrl: 'https://eodhd.com/financial-apis/live-realtime-stocks-api',
    limits: { perMinute: 1000, perDay: 100000 },
    covers: (ex) => ['US', 'LSE', 'AMS', 'KRX', 'KOSDAQ'].includes(ex),
    symbol: (t, ex) => `${t}.${{ US: 'US', LSE: 'LSE', AMS: 'AS', KRX: 'KO', KOSDAQ: 'KQ' }[ex] || 'US'}`,
    async quote(ticker, exchange, key) {
      const d = await json(`https://eodhd.com/api/real-time/${encodeURIComponent(this.symbol(ticker, exchange))}?api_token=${encodeURIComponent(key)}&fmt=json`);
      const price = n(d.close);
      if (price == null || price === 'NA') throw new Error('No price in response');
      return { price, prevClose: n(d.previousClose), time: n(d.timestamp) ? n(d.timestamp) * 1000 : Date.now(), currency: null };
    },
    async fx(base, currencies, key) {
      const out = {};
      await Promise.all(
        currencies.filter((c) => c !== base).map(async (c) => {
          const d = await json(`https://eodhd.com/api/real-time/${c}${base}.FOREX?api_token=${encodeURIComponent(key)}&fmt=json`);
          if (n(d.close) != null) out[c] = n(d.close);
        }),
      );
      return out;
    },
  },

  finnhub: {
    id: 'finnhub',
    label: 'Finnhub (free tier: US stocks only)',
    needsKey: true,
    signupUrl: 'https://finnhub.io/register',
    docsUrl: 'https://finnhub.io/docs/api/quote',
    limits: { perMinute: 55, perDay: 0 },
    covers: (ex) => ex === 'US',
    symbol: (t, ex) => (ex === 'US' ? t : `${t}.${{ LSE: 'L', AMS: 'AS', KRX: 'KS', KOSDAQ: 'KQ' }[ex] || ''}`),
    async quote(ticker, exchange, key) {
      const d = await json(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(this.symbol(ticker, exchange))}&token=${encodeURIComponent(key)}`);
      const price = n(d.c);
      if (!price) throw new Error('No price (symbol not covered by your plan?)');
      return { price, prevClose: n(d.pc), time: n(d.t) ? n(d.t) * 1000 : Date.now(), currency: null };
    },
  },

  twelvedata: {
    id: 'twelvedata',
    label: 'Twelve Data (free tier: US only, 8/min, 800/day)',
    needsKey: true,
    signupUrl: 'https://twelvedata.com/register',
    docsUrl: 'https://twelvedata.com/docs#quote',
    limits: { perMinute: 7, perDay: 750 },
    covers: (ex) => ['US', 'LSE', 'AMS', 'KRX', 'KOSDAQ'].includes(ex),
    symbol: (t, ex) => (ex === 'US' ? t : `${t}:${{ LSE: 'LSE', AMS: 'Euronext', KRX: 'KRX', KOSDAQ: 'KOSDAQ' }[ex]}`),
    async quote(ticker, exchange, key) {
      const d = await json(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(this.symbol(ticker, exchange))}&apikey=${encodeURIComponent(key)}`);
      if (d.status === 'error') throw new Error(d.message || 'Provider error');
      const price = n(d.close);
      if (price == null) throw new Error('No price in response');
      return { price, prevClose: n(d.previous_close), time: n(d.timestamp) ? n(d.timestamp) * 1000 : Date.now(), currency: d.currency || null };
    },
  },
};

export function getProvider(id) {
  return PROVIDERS[id] || PROVIDERS.manual;
}

// ---------------------------------------------------------------- FX

/** Returns { CCY: units of base per 1 CCY }. Frankfurter = ECB daily reference rates. */
export async function fetchFxFrankfurter(base, currencies) {
  const want = [...new Set(currencies.map((c) => (c === 'GBX' ? 'GBP' : c)).filter((c) => c && c !== base))];
  if (!want.length) return {};
  const d = await json(`https://api.frankfurter.app/latest?from=${encodeURIComponent(base)}&to=${want.map(encodeURIComponent).join(',')}`);
  const out = {};
  for (const [c, r] of Object.entries(d.rates || {})) if (n(r)) out[c] = 1 / n(r);
  return out;
}

export async function fetchFx(providerId, key, base, currencies) {
  const p = getProvider(providerId);
  if (p.fx && key) {
    try {
      const r = await p.fx(base, currencies.map((c) => (c === 'GBX' ? 'GBP' : c)), key);
      if (Object.keys(r).length) return { rates: r, source: p.id };
    } catch (e) {
      console.warn('Provider FX failed, falling back to Frankfurter', e);
    }
  }
  return { rates: await fetchFxFrankfurter(base, currencies), source: 'frankfurter' };
}

/** Convert an amount quoted in `from` into `to`, using rates expressed in base units per 1 unit. */
export function convertPrice(amount, from, to, rates) {
  if (amount == null) return null;
  if (from === to) return amount;
  let a = amount;
  let f = from;
  if (f === 'GBX') {
    a = a / 100;
    f = 'GBP';
  }
  let t = to;
  let scale = 1;
  if (t === 'GBX') {
    t = 'GBP';
    scale = 100;
  }
  if (f === t) return a * scale;
  const rf = rates[f];
  const rt = rates[t];
  if (!rf || !rt) return null;
  return (a * rf) / rt * scale;
}

// ---------------------------------------------------------------- rate limiting

/** Minimum milliseconds between full refresh cycles so `count` symbols stay inside the provider's limits. */
export function minCycleMs(provider, count, userSeconds) {
  const user = Math.max(15, Number(userSeconds) || 60) * 1000;
  if (!provider || !count) return user;
  let m = user;
  if (provider.limits.perMinute > 0) m = Math.max(m, Math.ceil((count / provider.limits.perMinute) * 60000 * 1.1));
  if (provider.limits.perDay > 0) m = Math.max(m, Math.ceil((count / provider.limits.perDay) * 86400000 * 1.1));
  return m;
}

/** Spacing between individual requests inside a cycle. */
export function requestSpacingMs(provider) {
  if (!provider || !provider.limits.perMinute) return 150;
  return Math.ceil(60000 / provider.limits.perMinute) + 50;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
