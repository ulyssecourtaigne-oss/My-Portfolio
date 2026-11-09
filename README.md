# Portfolio Tracker

A private, browser-only tracker for leveraged stock positions (built around eToro's fee model, but configurable). Plain HTML/CSS/JS, no framework, no build step, no server. Hosted as a static site on GitHub Pages.

**Your data never leaves your browser.** Positions, ledger, research notes, daily snapshots and your API key live in `localStorage`. The repo is public and contains no personal data; back up with **Settings → Export JSON**.

## Features

- Positions: long/short, quantity, entry price/date, leverage, notes; add, edit, close and **partial close** (opening costs and accrued financing are split pro‑rata).
- Costs: opening/closing commission, FX fee, stamp duty, other one‑offs; dividends received or paid; overnight financing as **annual % on borrowed amount**, **annual % on full position value**, or **fixed per night**, with 360/365 day count, weekends as calendar nights or a **triple charge on a chosen weekday**, and rate changes from a date.
- Ledger of what the broker actually charged: an actual charge for a night **replaces the estimate** for that night; estimated, actual and applied totals are shown separately.
- Per position: current value, margin used, borrowed, gross P&L, total costs, net P&L, return on margin, return on position value, cost per night, tonight's cost, break‑even after costs, margin‑call price (maintenance margin % you set).
- Dashboard in your base currency (default GBP, live FX): equity, exposure, effective leverage, today's change, unrealised/realised P&L, costs to date, next overnight cost; sortable table; allocation by stock and currency; portfolio vs benchmark and net P&L over time from daily snapshots.
- Live prices with automatic refresh inside the provider's rate limits, per‑price timestamps, stale/failed flags, manual prices for anything not covered. Provider code is isolated in `js/provider.js`.
- Research tab: attach a thesis, conviction, target/stop, sources, a link to the Claude chat and a dated research log to each position or idea. Paste the JSON your Claude chat produces (prompt included on the page).
- JSON export/import (replace or merge). Everything you type is rendered as text, never as HTML.

## Setup

1. Open the site (or `index.html` via any static server, e.g. `python3 -m http.server`).
2. **Settings → Price provider**: pick a provider and paste your API key.
   - **EODHD** (All World plan, ~€20/month): US, London, Euronext Amsterdam, KOSPI and KOSDAQ, ~15‑min delayed, plus live FX. Recommended if you hold non‑US stocks.
   - **Finnhub** or **Twelve Data** free tiers: US stocks only; use manual prices for the rest. FX then comes from the ECB (Frankfurter, free).
   - **Manual**: no API; type prices yourself.
3. Set base currency, maintenance margin %, cash and a benchmark.
4. Add positions. eToro users: position currency is **USD** for every stock; the quote currency follows the exchange (GBX for London, EUR for Amsterdam, KRW for Korea) and is converted automatically.
5. Export a backup regularly.

## Maths (see `js/calc.js`, tests in `test/calc.test.js`)

- notional = qty × entry; margin = notional ÷ leverage; borrowed = notional − margin
- per night = borrowed × rate ÷ dayCount (or notional × rate ÷ dayCount, or fixed). Nights run from the entry date to today. Triple mode: Sat/Sun free, the chosen weekday ×3.
- total costs = opening fees + closing fees + other fees + applied financing − dividends received (+ dividends paid)
- net P&L = gross − total costs; break‑even = entry ± total costs ÷ open qty
- margin‑call price solves margin + unrealised gross = maintenance% × position value

Acceptance test: long 100 @ $50, 5×, 7.3 %/yr on borrowed, 365 days, 10 nights, $5 commission, price $55 → margin $1,000, borrowed $4,000, $0.80/night, $8 financing, gross $500, net $487, return on margin 48.7 %, break‑even $50.13.

## Development

```bash
npm test          # Node's built-in test runner
npm run serve     # http://localhost:8080
```

Files: `index.html`, `css/style.css`, `js/calc.js` (maths only), `js/provider.js` (APIs only), `js/store.js` (storage, export/import), `js/charts.js` (SVG charts), `js/ui.js` (DOM helpers), `js/app.js` (views).

## Research JSON schema

```json
{ "ticker": "AAPL", "exchange": "US", "side": "long",
  "research": { "thesis": "", "risks": "", "conviction": 3, "targetPrice": null, "stopPrice": null,
                "horizon": "", "chatUrl": "", "sources": [{ "title": "", "url": "" }],
                "log": [{ "date": "YYYY-MM-DD", "text": "" }] } }
```

MIT licence.
