# JPTI Microstructure Replication Layer

## Scope

The microstructure API is a separate Cloudflare Pages acquisition service alongside the original ticker/OHLCV replication API. It uses public exchange REST endpoints, validates and normalizes responses, and stores immutable event/snapshot records in Cloudflare D1.

Implemented observation kinds:

- Order-book snapshots: bounded bid/ask levels, best bid/ask, spread, spread in basis points, depth notional and bid/ask imbalance.
- Public trades: trade ID, timestamp, price, quantity, side and quote notional where the venue provides the required fields.
- Funding history: rate and funding timestamp.
- Open interest: reported open-interest value and observation timestamp.
- Liquidation events: currently enabled only for OKX's public liquidation-orders endpoint. Unsupported venues are explicitly reported, not synthesized.

Supported venues: Binance, Bybit, OKX and Bitget. Spot and derivative product routing is controlled through the `marketType` argument (`spot`, `margin`, `usdt-m`, `coin-m`, `usdc-m`). Margin uses the venue's spot public order-book and trade endpoints; margin-specific borrowing/loan metrics are not included.. Product availability differs by exchange and instrument.

## API

- `GET /api/replication/microstructure` — totals, exchange/category/kind coverage and recent runs.
- `GET /api/replication/microstructure?exchange=binance&symbol=BTC%2FUSDT&kind=trade&marketType=usdt-m&limit=100` — filtered event history.
- `POST /api/replication/microstructure` — authenticated acquisition and durable persistence. Send `x-jpti-api-token` or `Authorization: Bearer <token>`.

Example POST body:

```json
{
  "exchanges": ["binance", "bybit", "okx", "bitget"],
  "symbols": ["BTC/USDT"],
  "marketType": "usdt-m",
  "kinds": ["orderbook", "trade", "funding", "open_interest", "liquidation"],
  "maxRequests": 24,
  "depthLimit": 20,
  "tradeLimit": 50
}
```

The API bounds requests to 24 upstream calls per cycle, caps symbols, kinds, depth and trade limits, uses a short upstream timeout and three concurrent fetch workers, and stores a run summary even when individual venues fail. The request plan is ordered to distribute a limited batch across kinds and exchanges instead of exhausting the budget on one venue.

## Persistence

Migration `0015_microstructure_replication.sql` creates:

- `jpti_microstructure_observations` — idempotently keyed order-book, trade, funding, open-interest and liquidation observations.
- `jpti_microstructure_runs` — status, duration, requested plan and coverage/analytics summary.

Each record stores exchange, product category, symbol, event identifier, source observation time (or receipt-time fallback), edge receipt time, normalized payload and quality metadata. Quality metadata distinguishes exchange-supplied timestamps from receipt-time fallbacks. Duplicate event identifiers are ignored. The original `jpti_market_observations` ticker/OHLCV history is not changed.

## Derived intelligence

The acquisition response includes derived analytics for the current cycle:

- Top-of-book spread and spread basis points.
- Bid/ask quantity and notional imbalance.
- Aggressor buy/sell notional and net flow.
- Mean funding rate for the returned samples.
- Latest open-interest values.
- Buy-side/sell-side liquidation notional where liquidation records are available; position direction is not inferred from order side.

These are descriptive data features, not directional trade signals. A single REST snapshot cannot reconstruct a full order-book event sequence or guarantee an accurate cumulative delta book. A WebSocket sequence-aware collector is required for that.

## Continuous scheduling

The existing GitHub Actions workflow now runs the microstructure endpoint after the ticker/OHLCV replication cycle, using the same `JPTI_REPLICATION_URL` variable and `JPTI_API_TOKEN` secret. The scheduled microstructure batch uses BTC/USDT on USDT-M products and asks all four venues for all five observation kinds. Unsupported combinations are reported as coverage limitations. The schedule runs every five minutes and is best-effort, not a real-time feed SLA.

## Explicit limitations and next engineering layer

- The current order-book records are REST snapshots. They are not full depth-delta streams and must not be presented as a sequence-reconstructed live book.
- Public trade REST endpoints return a bounded recent window; they are not guaranteed to provide every trade between scheduled cycles.
- Funding and open-interest endpoints have venue-specific availability, units and retention. The original exchange units are retained where exposed; normalize units before cross-venue numeric comparisons.
- OKX is currently the only configured REST liquidation-history source. Binance/Bybit/Bitget liquidation WebSocket collectors require persistent WebSocket infrastructure and reconnect/sequence management; unsupported results are explicit.
- The scheduled workflow uses GitHub Actions as the caller. Cloudflare Pages/D1 remain the API and storage plane. Workflow scheduling can be delayed.
- No private account credentials, order placement, position management or live-trading authorization are included.

The next layer should add persistent WebSocket collectors for order-book deltas, public trades and liquidation streams; sequence-gap recovery; replayable event logs; historical backfill cursors; and freshness/latency SLAs.
