# Unified portfolio accounting and risk intelligence

This phase connects the existing Portfolio & Ledger and Risk Management workspaces to read-only server endpoints.

## Endpoints

All three endpoints require the normal JPTI private API authorization header. The packaged local desktop may use its loopback-only private-access exception.

- `GET /api/advanced/portfolio/accounting`
  - Reads persisted ledger transactions.
  - Reconstructs spot inventory using weighted-average cost per exchange, account and market.
  - Retrieves public ticker marks for open ledger positions.
  - Retrieves current balances from configured exchanges using private read-only balance calls.
  - Reports asset movements and realized PnL separately by quote currency.
- `GET /api/advanced/portfolio/performance`
  - Calculates realized exit performance from the append-only fill ledger.
  - Reports win rate, profit factor, expectancy, drawdown and attribution by quote currency, strategy, market, exchange and UTC session.
- `GET /api/advanced/portfolio/risk`
  - Marks ledger-derived spot positions using public tickers.
  - Retrieves up to 400 daily OHLCV candles per position when the venue supports it.
  - Calculates timestamp-aligned, exposure-weighted historical 95% VaR and expected shortfall when at least 30 observations exist; 99% metrics require 100 observations.
  - Reports quote-currency-separated gross exposure, position concentration, effective position count and a configurable parallel stress loss.

## Configuration

- `JPTI_PORTFOLIO_STRESS_SHOCK_PERCENT`: parallel adverse shock used for the stress scenario; defaults to 10 and is clamped to 0–100.
- Exchange credentials remain server-side. Use read-only keys with withdrawals disabled and IP restrictions where supported.
- The endpoints are authenticated and return `Cache-Control: no-store`.

## Accounting and risk boundaries

- No USD conversion or aggregation across USD, USDT, BTC or other quote currencies is inferred.
- Historical VaR is a sample estimate, not a maximum-loss guarantee or a forecast.
- If aligned history is insufficient, VaR fields are `null`; the API does not manufacture a value.
- Only ledger-derived spot positions with a valid ticker mark enter the exposure and VaR books.
- Derivatives, leverage, margin liabilities, liquidation mechanics, funding, borrow, unrecorded deposits and external wallet holdings are not included in these spot risk totals.
- Third-currency fees are not converted into quote currency.
- Missing opening fills can leave unmatched sell quantities. JPTI reports data-quality warnings rather than inventing cost basis.
- Balance snapshots are read-only and do not initiate orders, transfers or withdrawals.

These reports support operator review. They do not place orders, size trades automatically or authorize live trading.
