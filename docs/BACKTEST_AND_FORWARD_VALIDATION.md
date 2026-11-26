# JPTI Backtest, Forward Validation and Market Stream Recovery

## Market-data stream service
Deploy the dedicated Worker with `npx wrangler deploy --config workers/market-stream-collector.wrangler.toml`. It runs one Durable Object per exchange / product / symbol stream and stores normalized event history in D1. The default scheduled universe starts BTC/USDT spot and USDT-M streams on Binance, Bybit, OKX and Bitget. Override it with `JPTI_STREAMS_CONFIG` (JSON array).

The collector persists every public trade, ticker, order-book update, funding / open-interest update and supported liquidation event in each Durable Object's SQLite event log (one-year rolling retention). D1 receives rate-limited event indexes and materialized book/state summaries; this avoids sending every 100 ms depth delta through the D1 write path. The private Worker `GET /history` endpoint reads the complete Durable Object log. The Pages Worker has a direct `JPTI_MARKET_STREAM` service binding to the collector, so no URL variable is needed in production. The Pages and collector services share the existing `JPTI_API_TOKEN` secret. `JPTI_MARKET_STREAM_URL` remains an optional fallback for preview environments where the service binding is not configured. Binance depth is seeded from a REST snapshot and reconciled against the first diff update; Binance update ranges and venue-provided previous sequence IDs are checked. A detected gap invalidates the local book, records a durable gap row, closes the socket and reconnects for a fresh snapshot. Sequence IDs are never fabricated. Venues that provide monotonic rather than contiguous IDs are labelled accordingly in the event quality metadata.

D1 migration `0017_market_stream_recovery.sql` creates the event index, reconstructed-book cache, state and gap tables. Durable Object SQLite retains the full event log and reconnect state. Stream completeness is bounded by upstream exchange channel semantics, Cloudflare availability and public rate limits; this is not an exchange-certified tick archive.

## Strategy replay and validation
`src/strategy-replay-engine.js` reuses `derivePaperSignal`, `simulatePaperFill` and `settlePaperTrade` from the paper decision engine. It uses chronological closed candles and timestamp-bounded order-book / trade-flow events, passes the same multi-timeframe and microstructure context into `derivePaperSignal`, and uses the same `adaptivePositionSize` and `evaluateRiskGate` modules as the live paper cycle. Entries occur on the following bar. Fees, spread and slippage are charged; stop distance, 3R target and risk budget follow the live paper rules. If a candle touches stop and target, stop is assumed first. The strategy stops taking new entries after the configured drawdown cap. The final chronological slice is held out from training. Monte Carlo resamples realized net trade outcomes. The current replay models full stop / target / time exits; dynamic-stop updates and staged partial exits remain separate follow-on execution-model work and are not silently represented as completed.

The private endpoint is `POST /api/paper/validation`. Submit only strategy and data selectors; the server loads stored candles and forward paper trades, runs the replay, computes the validation verdict and optionally persists it. A client-supplied `passed`, metrics object or LIVE_READY label is ignored. `GET /api/paper/validation?strategyId=...` returns the latest server-computed record. If migration 0016 is missing, the endpoint returns a storage error and promotion remains blocked.

The gate checks historical sample size, net profit factor, expectancy, drawdown, held-out sample and expectancy, Monte-carlo 95th percentile drawdown and ruin probability, risk breaches, forward sample/duration/KPIs, evidence freshness and performance decay. LIVE_READY is a research readiness state only: `liveExecutionAuthorized=false`; a human approval process is still required.

## CLI
Set `JPTI_VALIDATION_URL` to the deployed Pages origin and `JPTI_API_TOKEN` to the existing private API token. Production Pages uses its direct Worker service binding for full WebSocket-history replay; an optional `JPTI_MARKET_STREAM_URL` can be set for preview environments.

```sh
npm run validate:strategy -- --strategy-id atlas-trend --exchange bitget --market-type usdt-m --symbol BTC/USDT --timeframe 1m
npm run validate:strategy -- --strategy-id atlas-trend --exchange bitget --market-type usdt-m --symbol BTC/USDT --timeframe 1m --submit
```

Without `--submit`, the server computes and returns a preview without storing it. With `--submit`, the server stores its own recomputed evidence. The command never authorizes exchange orders.

## Capital protection and T-Bots
Forward drawdown, loss streak, risk breaches and measured decay reduce the paper allocation or block new entries. T-Bots receives a session-loss halt and a repeated-drawdown halt in the adapter-owned overlay. A timed pause cannot reset the session peak after a repeated trigger. Existing position exits remain enabled.

## Migrations and activation
Apply D1 migrations in order using `npm run db:d1:apply` after reviewing the target database. Migration 0016 adds strategy validation evidence. Migration 0017 adds stream history and recovery state. Deploy the collector Worker separately from Pages. Configure its `JPTI_API_TOKEN` secret and optional `JPTI_STREAMS_CONFIG` JSON variable to choose the stream universe. Pages uses the `JPTI_MARKET_STREAM` service binding declared in the root Wrangler config; the deployment workflow deploys the collector before Pages. The collector stores full events in Durable Object SQLite and rate-limits D1 index writes to one sample per event kind per second; the complete stream remains available through its private history route. No migration is applied to production automatically from this implementation branch.
