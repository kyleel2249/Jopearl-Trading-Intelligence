# JPTI Continuous Market Data Replication

## What it does

The Cloudflare Pages API now has a durable replication endpoint for public market observations. It uses the same direct public exchange adapter as the chart API and writes normalized, immutable observations into Cloudflare D1.

Supported public acquisition sources:

- Binance spot
- Bybit spot
- OKX spot
- Bitget spot, margin, USDT-margined, coin-margined and USDC-margined products

Each cycle discovers active instruments from the selected exchange/category, filters them against a bounded symbol allowlist, then acquires timestamped tickers and closed/open OHLCV observations for the configured timeframes. Invalid timestamps, non-positive prices, malformed OHLCV ranges and negative volumes are rejected. Exchange identity, product category, original observation time and edge receipt time are retained.

The replication layer is public-data-only. It does not request private account access, store exchange credentials, submit orders or authorize trading.

## Cloudflare endpoints

- `GET /api/replication` — latest runs, total observations and exchange/category coverage.
- `GET /api/replication?exchange=bitget&symbol=BTC%2FUSDT%3AUSDT&kind=ohlcv&timeframe=1m&marketType=usdt-m&limit=200` — durable historical observations.
- `GET /api/replication?exchange=binance&symbol=BTC%2FUSDT&kind=ticker&limit=100` — persisted ticker observations.
- `POST /api/replication` — run an authenticated acquisition/replication cycle. Send `x-jpti-api-token` or `Authorization: Bearer <token>`.

Example request:

```json
{
  "exchanges": ["binance", "bybit", "okx", "bitget"],
  "symbols": ["BTC/USDT", "ETH/USDT", "SOL/USDT"],
  "marketTypes": ["spot", "margin", "usdt-m", "coin-m", "usdc-m"],
  "timeframes": ["1m", "5m", "1h"],
  "marketLimit": 3,
  "candleLimit": 80,
  "includeCandles": true
}
```

The API enforces caps on exchange count, category count, symbols, timeframes, market count, candle history and request body size. Unsupported categories are not silently routed to another exchange. It also calculates a per-cycle upstream subrequest budget (45 by default), automatically trims the requested timeframe set and market count when necessary, and reports the effective budget in each run plan. This protects the Cloudflare runtime from exceeding its subrequest allowance when all exchange categories are enabled.

## Durable storage

Migration `0014_market_data_replication.sql` creates:

- `jpti_market_observations` — immutable, idempotently keyed ticker and OHLCV observations.
- `jpti_market_replication_runs` — run status, duration, plan, counts and bounded error summaries.
- `jpti_market_replication_cursors` — latest successful cycle reference.

Duplicate observations are ignored through a deterministic composite key. Existing `jpti_events` market snapshots remain intact; the new tables provide a time-series history rather than overwriting the latest snapshot.

The existing Cloudflare chart API now falls back to replicated D1 OHLCV history when a live OHLCV request fails. It marks the result as stale and identifies `cloudflare-d1-replicated-history` as its source. Existing live data remains preferred whenever available.

## Continuous scheduling

Cloudflare Pages Functions do not provide a native scheduled-event handler. This build therefore uses a GitHub Actions scheduled caller while keeping the application API, acquisition and storage on Cloudflare Pages/D1.

Configure these GitHub repository settings:

1. Add repository variable `JPTI_REPLICATION_URL` with the deployed Pages endpoint, for example `https://YOUR-PAGES-DOMAIN/api/replication`.
2. Add repository secret `JPTI_API_TOKEN` with the same token configured as a Cloudflare Pages secret (`JPTI_API_TOKEN` or the supported `JPTI_JOURNAL_TOKEN` fallback).
3. Confirm migration `0014_market_data_replication` has been applied to the production D1 database.
4. Enable the workflow `JPTI Continuous Market Data Replication`.

The workflow runs every five minutes and can also be started manually. It uses bounded batches and retries transient HTTP failures. GitHub Actions scheduling is best-effort and can be delayed by GitHub; it is not a tick-level feed or a hard real-time SLA.

## Optional Cloudflare Pages variables

- `JPTI_REPLICATION_EXCHANGES` — comma-separated subset of `binance,bybit,okx,bitget`.
- `JPTI_REPLICATION_SYMBOLS` — comma-separated normalized symbols; default: BTC/USDT, ETH/USDT, SOL/USDT, XRP/USDT, BNB/USDT, DOGE/USDT, BTC/USD:BTC, BTC/USDC:USDC.
- `JPTI_REPLICATION_MARKET_TYPES` — Bitget categories; default: spot, margin, usdt-m, coin-m, usdc-m.
- `JPTI_REPLICATION_TIMEFRAMES` — default: 1m, 5m, 15m, 1h.
- `JPTI_REPLICATION_MARKET_LIMIT` — per exchange/category cap; maximum 20.
- `JPTI_REPLICATION_CANDLE_LIMIT` — candles fetched per timeframe; maximum 200.

## Operational interpretation and limitations

- A completed run means the configured acquisition requests were processed; inspect the per-stage errors and coverage rather than assuming every venue/category succeeded.
- A partial run preserves successful observations and reports failed sources separately.
- D1 idempotency prevents duplicate rows for the same exchange, category, symbol, observation kind, timeframe and exchange timestamp.
- This initial replication stores ticker snapshots and OHLCV candles. It does not yet persist full order-book deltas, every public trade, liquidation events, private fills, account positions or funding history.
- The existing native WebSocket ticker stream remains a separate local/desktop gateway capability. The scheduled Pages replication path is REST-based and deliberately bounded.
- Replicated candles are historical evidence, not a guarantee that the exchange is currently reachable or that a stale candle is executable.
- Public exchange APIs impose rate limits, product availability restrictions and occasional data corrections. Source timestamps and quality flags must remain attached to observations.
- This layer is a data pipeline, not a profitable-trading guarantee. Strategy qualification, backtesting, forward paper testing, execution controls and capital-protection gates remain separate requirements.
