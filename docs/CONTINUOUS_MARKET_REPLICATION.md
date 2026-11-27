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

The Cloudflare Pages API now has bounded outage fallbacks for replicated D1 ticker and OHLCV observations. A replicated ticker is served only when its edge receipt time is within 15 minutes; it is always marked `stale: true`, includes its observation/receipt timestamps and identifies `cloudflare-d1-replicated-history` as its source. Replicated candles are also explicitly marked stale. Live exchange data remains preferred whenever available. The fallback is a continuity aid for chart inspection, not a live quote or an execution price. Authenticated runner ingestion revalidates every row, stamps its own D1 receipt time, rejects invalid/future timestamps and malformed OHLCV, and writes observations idempotently.

## Continuous scheduling

Cloudflare Pages Functions do not provide a native scheduled-event handler. This build therefore uses GitHub Actions as the scheduled acquisition runner while keeping the authenticated ingestion API and durable storage on Cloudflare Pages/D1. The runner fetches Bitget public market data directly from GitHub-hosted infrastructure and pushes normalized observations to D1. This avoids relying on Cloudflare Worker outbound IP access to Bitget, which has returned HTTP 403. It is a direct exchange connection, not a third-party proxy.

Configure these GitHub repository settings:

1. The scheduled workflow is pinned to `https://jopearl-trading-intelligence.pages.dev/api/replication`; no endpoint variable is required. If the production domain changes, update the workflow endpoint and its trusted-host allowlist together.
2. Add repository secret `JPTI_JOURNAL_TOKEN` (preferred) or `JPTI_API_TOKEN` with the same value configured as the Cloudflare Pages secret. The manual production run verified that a configured GitHub Actions secret authenticated successfully against the canonical Pages endpoint.
3. Confirm migration `0014_market_data_replication` has been applied to the production D1 database.
4. Enable the workflow `JPTI Continuous Market Data Replication`.

The workflow runs every five minutes and can also be started manually. It checks out the repository, runs the direct Bitget acquisition client on the GitHub runner, and pushes normalized observations in bounded authenticated batches. It then runs the existing order-book/trade/funding/open-interest/liquidation acquisition cycle. Missing endpoint/secret configuration fails visibly instead of producing a successful no-op. A run with zero valid ticker/candle observations fails; partial source coverage is surfaced as a warning. GitHub Actions scheduling is best-effort and can be delayed by GitHub; it is not a tick-level feed or a hard real-time SLA.

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
