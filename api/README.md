# JPTI Exchange Gateway

The gateway is a Node.js server-side integration layer built on CCXT. It provides real public exchange market data and private account reads for configured exchanges. It also contains a deliberately locked spot-order endpoint.

## Supported adapter catalog

The runtime catalog is generated dynamically from all exchange adapter IDs shipped in the installed CCXT version (100+ exchange APIs). JPTI reports the actual capabilities detected for each adapter. The market endpoint loads all active instruments exposed by the selected exchange and classifies spot, futures, perpetual swaps, margin-enabled spot, CFDs and options when the exchange metadata explicitly identifies them. Product availability, geographic restrictions, and metadata quality vary by provider; live order execution remains restricted to active spot markets with USDT quote currency in this initial gateway.

## Endpoints

- `GET /api/health` — gateway status and mode.
- `GET /api/exchanges` — supported exchange adapters and configured status.
- `GET /api/exchanges/:id/status` — credential presence (never returns secrets).
- `GET /api/exchanges/:id/markets?type=all&search=BTC` — active exchange market catalog with type filters (`spot`, `futures`, `perpetual`, `margin`, `cfd`, `options`), search, product counts, settlement/contract metadata, adapter capabilities and supported OHLCV timeframes.
- `GET /api/exchanges/:id/ticker/:symbol` — live ticker, e.g. `/api/exchanges/binance/ticker/BTC-USDT`.
- `GET /api/exchanges/:id/ohlcv/:symbol?timeframe=1h&limit=120` — live OHLCV candle history.
- `GET /api/exchanges/:id/balance` — private account balances; requires server-side credentials and the `x-jpti-api-token` header.
- `POST /api/exchanges/:id/orders` — locked live spot order endpoint.

Order JSON: `{"symbol":"BTC/USDT","side":"buy","type":"limit","amount":0.001,"price":60000}`.

## Run locally

1. Copy `.env.example` to `.env`.
2. Generate a long random value for `JPTI_API_TOKEN`.
3. Add API keys only for the exchanges you want to connect.
4. Use read-only keys for account visibility first. If later enabling orders, use trade permission only, disable withdrawals, and use IP restrictions where supported.
5. Run `npm install`, then `npm run dev:all`.
6. Open `http://localhost:5173`; gateway health is at `http://127.0.0.1:8787/api/health`.

## Live order lock

Live orders are rejected unless all of these are true:
- `JPTI_TRADING_MODE=live`
- `JPTI_ENABLE_LIVE_TRADING=true`
- The request contains a matching `x-jpti-api-token` header.
- The request contains `x-jpti-live-confirmation: I_ACKNOWLEDGE_LIVE_TRADING`.
- The market is active spot, quote currency is USDT, and the adapter supports order creation.
- The estimated order notional does not exceed `JPTI_MAX_ORDER_NOTIONAL_USDT` (default 100 USDT).

These checks are a starter policy gate, not a complete institutional risk engine. They do not replace account-level permissions, exchange-side limits, authentication, audit storage, monitoring, kill switches or independent security review. Keep this gateway bound to localhost during development. Do not expose it directly to the public internet. Cloud deployment requires TLS, strong user authentication, secret management, network controls, persistent audit records and a hardened execution service.

CCXT is a unified adapter, not a guarantee that every exchange exposes identical products or order parameters. Validate each exchange's API documentation and test with read-only credentials before enabling any trade permission.


## Financial and on-chain intelligence

- `GET /api/intelligence/overview` — pulls CoinGecko global crypto market data and DeFiLlama chain TVL, stablecoin supply and protocol fees. Responses include provider status and fetch timestamps. Public providers can rate-limit or change availability.
- `GET /api/intelligence/macro/:seriesId?limit=120` — FRED observations. Configure `JPTI_FRED_API_KEY`. Example series include `FEDFUNDS`, `CPIAUCSL`, `UNRATE`, `DGS10` and `DTWEXBGS`. These are published observations with differing release lags, not streaming quotes.
- `GET /api/intelligence/onchain/evm/:chain/:address/transfers?limit=25` — indexed external, internal and ERC-20 transfers for Ethereum, Base, Polygon, Arbitrum and Optimism. Configure `JPTI_ALCHEMY_API_KEY`.
- `GET /api/intelligence/onchain/solana/:address/transactions?limit=25` — indexed Solana address transaction history. Configure `JPTI_HELIUS_API_KEY`.
- `POST /api/intelligence/score` — accepts optional `priceChangePct`, `volumeChangePct`, `netExchangeFlow`, `stablecoinSupplyChangePct` and `macroBias` (`risk-on`, `risk-off`, `neutral`). It returns the contribution from each supplied factor, a coarse directional bias and evidence-count confidence tier. It does not create or submit orders.

All provider keys belong in the server-side `.env`, never in browser code or Git. Wallet transaction history is subject to indexer coverage and query limits. A wallet address does not establish a person's identity or intent. Exchange inflow/outflow interpretation requires known exchange-labeled wallets and validated attribution; raw transfers must not be mislabeled as exchange flows. No provider result should be treated as a complete record of all chain activity.

This integration is a data foundation, not a complete institutional financial-data terminal. Live equity, bond, FX and commodity market feeds, earnings/fundamental datasets, a durable normalized time-series store, cross-provider entity resolution, validated strategy backtests, and production-grade wallet labeling remain future work.

- `GET /api/intelligence/market/:exchange/:symbol/context?timeframe=1h` — explainable multi-source pair context: closed OHLCV momentum and relative volume, 15m/1h/4h/1d trend alignment where supported, top-20 order-book notional imbalance, perpetual funding where supported, CoinGecko aggregate crypto risk context and DeFiLlama chain TVL leaders. Missing exchange capabilities are omitted rather than fabricated. A 30-second HTTP cache limits repeated broad-provider calls.


## Multi-provider financial data gateway (new integration layer)

JPTI exposes a provider registry at `GET /api/providers` and interval configuration at `GET /api/providers/intervals`. These routes report which credentials are present, the data categories available through adapters, documentation links and polling configuration. Credential presence is not a successful connection; each provider request must succeed to verify access and subscription entitlement.

Implemented read-oriented adapters:
- **Alpaca**: stock historical bars, crypto bars, paper-account read and paper-account activity history. Configure `JPTI_ALPACA_API_KEY` and `JPTI_ALPACA_API_SECRET`. Stock bars: `GET /api/providers/alpaca/bars?symbol=AAPL&timeframe=1Day&feed=iex&limit=100`. Crypto bars: `GET /api/providers/alpaca/crypto-bars?symbol=BTC/USD&timeframe=1Day&limit=100`. Private paper account: `GET /api/providers/alpaca/account` with `x-jpti-api-token`. Private activity history: `GET /api/providers/alpaca/activities?activity_type=FILL&limit=50` with the same token. Account and activity reads are pinned to paper API; they do not place orders.
- **Quiver Quantitative**: congressional trade history for a requested US ticker. Configure `JPTI_QUIVER_API_KEY`. `GET /api/providers/quiver/congress/NVDA`. The adapter uses the documented historical congressional-trading endpoint and Bearer authentication. Dataset access depends on subscription; Quiver's public pricing currently lists Hobbyist from $30/month and Trader from $75/month, with commercial rights reserved for eligible Startup/Enterprise plans.
- **Finnhub**: `GET /api/providers/finnhub/quote/:symbol`, `GET /api/providers/finnhub/candles/:symbol?resolution=D&from=UNIX_SECONDS`, and `GET /api/providers/finnhub/news?category=general|forex|crypto|merger`.
- **Alpha Vantage**: `GET /api/providers/alphavantage/quote/:symbol`, `GET /api/providers/alphavantage/daily/:symbol?outputsize=compact|full`, and `GET /api/providers/alphavantage/news?tickers=AAPL&limit=50`. The free service currently documents 25 requests/day for most datasets; realtime and 15-minute delayed US equity data are premium/licensed.
- **Twelve Data**: `GET /api/providers/twelvedata/quote/:symbol` and `GET /api/providers/twelvedata/time-series/:symbol?interval=1day&outputsize=100`. The current Basic tier documents 8 API credits/minute and 800/day; websocket entitlements and market coverage depend on plan.
- **Infura**: `POST /api/providers/infura/:network/rpc` with a JSON body containing an allowlisted read-only JSON-RPC method and params. Supported network labels: mainnet, sepolia, arbitrum-mainnet, base-mainnet, optimism-mainnet, polygon-mainnet. Write methods are not exposed. Infura is blockchain RPC infrastructure, not a market-price feed.
- **GDELT**: `GET /api/providers/news/search?q=central%20bank` for global news discovery without a key.
- **Liquid legacy exchange adapter**: `GET /api/providers/liquid/markets`. This is a compatibility probe only. The old Liquid/Quoine endpoint may be unavailable or the venue may not provide active trading services; do not assume liquidity or account execution support. It is not included in JPTI's active trading venue list.
- Existing CoinGecko, DeFiLlama, FRED, Alchemy and Helius integrations remain available through the intelligence routes. Existing CCXT exchange adapters remain separate.

All API credentials are server-side only. Never use Vite `VITE_*` variables for secrets, commit credentials, or paste keys into chat. Start with read-only keys. Alpaca account read is pinned to its paper API host; this implementation does not submit Alpaca orders. Infura RPC methods are read-only allowlisted. The Liquid adapter is not wired to the live-order execution gateway.

### Operational intervals (seconds)

Set these values in the server `.env`:
- `JPTI_MM_INTERVAL_SECONDS=5` — market-maker quote-cycle target cadence (not an active order loop until a separately approved market-making worker is deployed).
- `JPTI_MARKET_MONITOR_INTERVAL_SECONDS=5` — market-monitor sampling cadence.
- `JPTI_MARKET_DATA_REFRESH_INTERVAL_SECONDS=5` — intended market-data refresh cadence.
- `JPTI_RECONCILE_INTERVAL_SECONDS=30` — portfolio/order/transaction reconciliation cadence target.
- `JPTI_INVESTOR_MONITOR_INTERVAL_SECONDS=60` — investor/watchlist monitoring cadence target.
- `JPTI_PROVIDER_HEALTH_INTERVAL_SECONDS=300` — provider health check cadence target.
- `JPTI_NEWS_REFRESH_INTERVAL_SECONDS=60` — news polling cadence target.
- `JPTI_ONCHAIN_REFRESH_INTERVAL_SECONDS=30` — on-chain refresh cadence target.
- `JPTI_SCHEDULER_ENABLED=true` — master scheduler policy flag.

Read effective validated values from `GET /api/providers/intervals`. Bounds are enforced in seconds to prevent zero/negative or extreme polling values. Important: the scheduler now includes real market monitoring and optional private fill-history polling when JPTI_FILL_SYNC_MARKETS is configured. Portfolio accounting and current balance snapshots are available from the authenticated advanced endpoint, but a fully automated balance reconciliation still requires verified opening balances and complete external cash-flow history. Investor monitoring and market-making remain prerequisite-gated; a displayed interval is not proof that those workers are active.


## Operations scheduler, live monitor and durable transaction ledger

The futuristic command-center dashboard reads actual API health, provider registry, scheduler state, recent audit events and transaction-event counts. It deliberately does not invent balances, PnL, positions or strategy performance.

The API starts a server-side operations scheduler when the server starts (unless `JPTI_SCHEDULER_ENABLED=false`):
- Market monitor: samples live CCXT tickers for the server-side watchlist configured with `JPTI_MONITOR_MARKETS=binance:BTC/USDT,bitget:ETH/USDT`. It reports per-market errors and last successful snapshots.
- Provider registry monitor: checks credential/public-provider configuration. This is a configuration check, not a full authenticated connectivity test.
- Reconciliation, investor, market-making, news and on-chain jobs expose explicit prerequisite/disabled states. They do not fabricate activity or submit orders.
- Market ticker sampling and durable snapshot persistence are separate: snapshots default to a 60-second write cadence to limit local disk growth.

### Operational endpoints
- `GET /api/operations/overview` — scheduler uptime, job status, last-run timestamps, intervals and market snapshots.
- `GET /api/operations/events?limit=100` — recent persisted operational events (private ledger transaction details are excluded).
- `GET /api/operations/ledger/events?limit=100` — private transaction history; requires `x-jpti-api-token`.
- `GET /api/operations/ledger/summary` — transaction event counts by type; not a balance or PnL calculation.
- `GET /api/operations/reconciliation` — authenticated latest 50 balance-reconciliation snapshots.
- `POST /api/operations/reconciliation/run` — authenticated on-demand reconciliation against current private exchange balances; returns per-currency expected/actual totals, differences, unresolved event counts and account errors. Concurrent manual/scheduled runs share one in-flight reconciliation to avoid duplicate exchange polling.
- `POST /api/operations/ledger/events` — authenticated append-only transaction-event ingestion.

Transaction ingestion requires `x-jpti-api-token` matching the server-side `JPTI_API_TOKEN`. Example body:
```json
{
  "source": "alpaca",
  "eventType": "fill",
  "externalId": "provider-fill-id-123",
  "accountId": "paper-account-01",
  "symbol": "AAPL",
  "side": "buy",
  "quantity": 2,
  "price": 190.25,
  "fee": 0.01,
  "feeCurrency": "USD",
  "occurredAt": "2026-11-19T12:00:00.000Z"
}
```
The source/account/external-ID tuple is used for duplicate detection. The local JSONL event store is written under `JPTI_DATA_DIR` (default `data/`) and excluded from Git. Back it up and protect the host filesystem. This is an initial single-process local persistence implementation, not yet a multi-user database, distributed queue or institutional reconciliation ledger.


### On-demand balance reconciliation

The Portfolio & Ledger workspace includes a **Run balance reconciliation now** action. It uses the same read-only exchange balance adapter and ledger calculation as the scheduled reconciliation worker; it does not place orders or move funds. Configure the server-side exchange read-only API credentials and, where known, opening balances:

```env
JPTI_RECONCILE_EXCHANGES=binance,bitget
JPTI_RECONCILE_OPENING_BALANCES_JSON={"binance":{"BTC":0,"USDT":1000},"bitget":{"BTC":0,"USDT":500}}
```

The JSON keys are exchange IDs, then currency codes. Set opening balances to the account's actual starting balances at the beginning of the ledger coverage period; do not use zero unless zero is verified. If no baseline is configured, the report returns `baseline_missing` and `complete=false`. A mismatch is the exchange's current total minus (opening balance plus supported ledger movements). Unsupported or malformed cash-flow events are counted as unresolved. The calculation does not claim full reconciliation of derivatives liabilities, transfers not present in the ledger, funding/interest types without a supported direction, third-currency fee conversion, or history that the exchange API does not return. Use read-only keys; never enable withdrawals for reconciliation.

### Watchlist and interval configuration
```env
JPTI_SCHEDULER_ENABLED=true
JPTI_MONITOR_MARKETS=binance:BTC/USDT,bitget:ETH/USDT
JPTI_MM_INTERVAL_SECONDS=5
JPTI_MARKET_MONITOR_INTERVAL_SECONDS=5
JPTI_RECONCILE_INTERVAL_SECONDS=30
JPTI_INVESTOR_MONITOR_INTERVAL_SECONDS=60
JPTI_PROVIDER_HEALTH_INTERVAL_SECONDS=300
JPTI_MARKET_DATA_REFRESH_INTERVAL_SECONDS=5
JPTI_NEWS_REFRESH_INTERVAL_SECONDS=60
JPTI_ONCHAIN_REFRESH_INTERVAL_SECONDS=30
JPTI_MONITOR_PERSIST_INTERVAL_SECONDS=60
JPTI_DATA_DIR=data
```

MM interval is a target cadence only; the market-making worker remains disabled. Reconciliation and investor monitoring report waiting states until real account-fill ingestion and investor/watchlist sources are connected. Do not expose the local API directly to the internet; production deployment requires managed database storage, authentication, TLS, secret management, audit retention and operational monitoring.


Provider limitations: Finnhub, Alpha Vantage and Twelve Data have symbol coverage, market-hours, exchange licensing, per-minute quota and plan restrictions. Do not merge quotes without preserving provider timestamp, venue, currency and entitlement metadata. Quiver datasets are primarily US-company alternative data and may update after public filings/disclosures; they are not tick-level signals. Twelve Data websocket access requires eligible plans; the current Basic/Grow trial is restricted. Alpaca's Basic equities feed is IEX rather than consolidated all-venue coverage; paid market-data tiers change that coverage. Validate account eligibility and local regulatory/tax requirements before using any broker account from Ghana.


## Advanced cross-provider quote intelligence

- `GET /api/providers/consensus/quote/:symbol` queries only configured quote providers (Finnhub, Twelve Data, Alpaca, and optionally Alpha Vantage) and normalizes their observations into a common response.
- The response preserves each provider's timestamp, currency, venue, raw provider status and price. It calculates a median cross-source reference only when currency metadata does not conflict.
- With at least three observations, sources whose price differs from the median by more than `JPTI_QUOTE_OUTLIER_THRESHOLD_PERCENT` are flagged for manual review. Stale observations are marked using `JPTI_QUOTE_STALE_AFTER_SECONDS`.
- The endpoint caches each symbol for `JPTI_QUOTE_CACHE_TTL_MS` (default 30 seconds) and enforces provider-specific minimum request spacing to reduce quota exhaustion. Alpha Vantage is excluded from consensus by default; set `JPTI_ENABLE_ALPHAVANTAGE_CONSENSUS=true` only if your plan and quota support it.
- The Overview dashboard includes a read-only cross-source quote panel. It does not submit orders and does not claim to provide a consolidated NBBO or guaranteed executable price.

A cross-provider median is only a sanity check: feeds may differ by venue, session, delay, currency, corporate-action adjustment and licensing entitlement. A flagged outlier is not proof that a provider is wrong. Review source timestamps and market status before relying on the result.


## Cross-exchange spread scanner

- `GET /api/exchanges/compare/ticker?symbol=BTC%2FUSDT&exchanges=binance,bitget,bybit,okx` requests public tickers from up to six supported CCXT venues.
- Returns per-venue last/bid/ask/volume/timestamp, median last price, last-price dispersion and an indicative best-ask/best-bid gross edge when two different venues provide valid top-of-book quotes.
- A five-second per-symbol/venue-set cache limits repeated calls. Failed or unlisted markets remain visible in the per-venue result list.
- The scanner is read-only and does not submit arbitrage orders. Gross edge excludes trading fees, funding, market depth, slippage, latency, withdrawal/deposit delays, counterparty risk and venue restrictions. Do not interpret a positive edge as executable profit.


## Advanced forecasting and institutional intelligence

These read-oriented endpoints are mounted under \`/api/advanced\`:

- \`GET /advanced/forecast/:exchange/:symbol?timeframe=1h&limit=500\` — rolling statistical 24-hour and 1/4/12-hour range forecasts from exchange OHLCV. Returns expected midpoint, high/low envelopes, ATR, volatility, momentum and conservative/base/aggressive scenarios. The baseline uses historical log-return volatility and ATR; it is not an ML-trained model and its nominal interval is not calibrated probability until walk-forward validation is performed.
- \`GET /advanced/orderbook/:exchange/:symbol?limit=50\` — visible bid/ask notional depth, imbalance, spread and large displayed liquidity levels. Consecutive snapshots are compared in process memory. A large order is not proof of spoofing; reliable spoofing detection requires order-level add/cancel/replace feeds and venue surveillance.
- \`GET /advanced/derivatives/:exchange/:symbol\` — funding rate, open interest and ticker/index basis where CCXT and the venue expose them. Liquidation clusters explicitly report unavailable until a venue-specific liquidation stream/history is integrated.
- \`POST /advanced/council\` — deterministic specialist evidence agents for trend, volume, microstructure, derivatives and risk. Returns evidence, disagreement and conservative confidence; these are not autonomous LLM traders.
- \`POST /advanced/backtest/ema\` — simple EMA long/flat research baseline with configurable periods and fee assumption. It is not a complete strategy laboratory.
- \`POST /advanced/monte-carlo\` — seeded bootstrap scenarios from supplied returns. This is a distributional stress tool, not a return guarantee.
- \`POST /advanced/portfolio/reconcile\` — authenticated balance-versus-fill arithmetic check. Requires \`x-jpti-api-token\` and supplied balances/fills; it does not yet automatically ingest every exchange fill, account for opening inventory/transfers/fee currencies, or calculate realized/unrealized PnL.
- \`POST /advanced/execution/estimate\` — walks a supplied order book to estimate average fill, visible depth shortfall, fees and slippage. It is indicative and does not route orders.

### Institutional implementation boundaries

The current implementation now includes rolling walk-forward validation for an EMA baseline, configurable scheduled exchange trade-history polling, authenticated weighted-average cost-basis accounting, ledger cash-flow movements, current private balance snapshots, and a server-sent event stream that polls exchange order-book and supported derivatives endpoints. The stream is polling-based, not a native exchange WebSocket. It does not claim calibrated forecast probabilities, trained ML models, proven spoofing identification, complete liquidation maps across venues, broad multi-strategy parameter optimization, institutional-grade database durability, full tax-lot/corporate-action accounting, autonomous AI agents, or live smart-order routing. Those require additional venue coverage, durable storage, market-impact/funding models, and independent validation. Walk-forward results remain a research baseline, not evidence of future profitability.

Public market-data routes are read-only. Authenticated fill synchronization and ledger ingestion append normalized records to the local journal; portfolio accounting reads that journal and current exchange balances. Existing live-order controls remain separate and disabled by default. Keep API credentials server-side.



### Advanced historical fill synchronization

The fill-ingestion worker uses bounded pagination rather than a single fixed 100-trade request. It imports up to `JPTI_FILL_SYNC_MAX_PAGES` pages per market/run, records fetched/unique/normalized/inserted/duplicate counts, and reports when the page cap leaves history incomplete. The next scheduled pass resumes from the persisted cursor with a configurable overlap to recover late-arriving fills. Ledger uniqueness constraints make overlapping imports replay-safe.

Configuration (all optional):

- `JPTI_FILL_SYNC_LOOKBACK_DAYS=7` — initial history window when a market has no saved cursor.
- `JPTI_FILL_SYNC_PAGE_SIZE=250` — requested trades per exchange page (clamped to 10–1000).
- `JPTI_FILL_SYNC_MAX_PAGES=20` — maximum pages per market/run (clamped to 1–100).
- `JPTI_FILL_SYNC_OVERLAP_MINUTES=3` — look-back overlap on each sync to catch delayed fills.

An authenticated manual backfill endpoint is available:

```http
POST /api/operations/fills/backfill
x-jpti-api-token: <JPTI_API_TOKEN>
Content-Type: application/json

{"since":"2026-01-01T00:00:00.000Z","until":"2026-01-31T23:59:59.999Z","pageSize":250,"maxPages":20}
```

The request uses the configured `JPTI_FILL_SYNC_MARKETS` list unless a `markets` array is supplied (format: `exchange:symbol`). A single request is limited to 20 markets and a 10-year date range. Backfill uses its own cursor namespace and does not move the scheduled-sync cursor. If the response reports `pageLimitReached`, run another backfill for the remaining time range or increase the bounded page limit. Repeated imports are safe because ledger events are deduplicated by exchange/account/trade ID/market.

Exchange adapters differ: some impose their own history limits, omit older records, or cannot provide a stable cursor for trades sharing the same millisecond timestamp. The overlap and dedupe strategy reduces missed/duplicate imports but cannot guarantee completeness where the exchange API itself does not expose complete history. Unsupported records and provider failures are reported rather than silently treated as imported. Use read-only keys only.

## Walk-forward research, automatic fill ingestion and portfolio accounting

The advanced laboratory is exposed through `api/advanced-lab.js`:

- `GET /api/advanced/lab/walk-forward/:exchange/:symbol?timeframe=1h&limit=1000&trainBars=300&testBars=100&stepBars=100&feeBps=10` — retrieves historical OHLCV server-side and runs rolling walk-forward EMA research. The `POST /api/advanced/lab/walk-forward` variant accepts supplied candles for research/import workflows. Choose `strategy=ema`, `strategy=rsi` or `strategy=donchian`. The parameter grid is optimized independently inside each training window; each fold then evaluates the selected parameters on a later out-of-sample window. The response separates fold-level training and OOS results and aggregates OOS returns. This is a research baseline, not proof of future profitability.
- `POST /api/advanced/fills/sync/:exchange` — authenticated, read-only on-demand import of private exchange trade history using CCXT `fetchMyTrades`. Requires `x-jpti-api-token`; optional body: `{"symbol":"BTC/USDT","since":1795000000000}`. Trades are normalized into the existing append-only ledger and deduplicated by exchange/account/trade ID. Venue history limits and pagination vary; use time cursors to backfill older records.
- The operations scheduler also runs automatic private fill polling when `JPTI_FILL_SYNC_MARKETS=binance:BTC/USDT,bitget:ETH/USDT` is configured. It uses read-only trade-history access, a rolling in-memory cursor and ledger idempotency. On restart it rechecks the prior 24 hours, relying on deduplication. Monitor the `fill-ingestion` job in `GET /api/operations/overview`; a configured key is not proof that the exchange granted the required permission.
- `GET /api/advanced/portfolio/accounting` — authenticated weighted-average cost-basis accounting from ingested fills, segregated by exchange/account/symbol. It reports realized PnL in each quote currency, remaining position quantity/cost basis, fee totals and unrealized PnL only when a current mark is available from the originating exchange. It is not FIFO or a tax statement. Deposits, withdrawals, transfers, funding, borrow interest, rebates and FX translation are not yet fully journaled.
- `GET /api/advanced/stream/:exchange/:symbol?intervalMs=2000` — Server-Sent Events stream for live order-book, ticker and supported funding/open-interest snapshots. It polls the exchange through CCXT and emits `intelligence` events; it is not a native venue WebSocket subscription. Disconnect the client to stop polling. Sampling is bounded to 1–15 seconds.

Example walk-forward body:
```json
{
  "candles": [[1795000000000, 100, 102, 99, 101, 1200]],
  "trainBars": 500,
  "testBars": 100,
  "stepBars": 100,
  "fastPeriods": [5, 9, 12],
  "slowPeriods": [21, 30, 50],
  "feeBps": 10
}
```

Private exchange keys must be configured server-side with trade-history read permission only where possible; withdrawal permissions should remain disabled. Do not expose the API publicly without TLS, strong authentication, durable database storage, audit controls and rate limiting. The current ledger remains a single-process local JSONL store. Walk-forward output supports EMA crossover, RSI mean-reversion and Donchian breakout long/flat research baselines; spread, slippage, funding, borrow, market impact, partial fills, taxes and venue-specific execution constraints are not included in its returns. Portfolio VaR and stress calculations are historical/parallel-shock estimates, not maximum-loss guarantees; derivatives Greeks, leverage, liquidation, cross-currency FX and correlated liquidity shocks are not modeled.


The ledger schema also accepts `funding`, `interest`, `borrow` and `rebate` event types. For signed cash flows, provide `currency`, `quantity` and `metadata.signedAmount` (positive for a credit, negative for a debit). A `transfer` event should include `metadata.fromCurrency`, `metadata.fromAmount`, `metadata.toCurrency` and `metadata.toAmount`. The accounting response exposes net movements by exchange/account/currency; these are not absolute balances unless a verified opening balance and complete history are supplied. Sells exceeding the known inventory are flagged as unmatched rather than assigned an invented cost basis.


### Portfolio risk diagnostics extension

The authenticated `GET /api/advanced/portfolio/risk` response now includes additional historical diagnostics for each quote-currency portfolio:
- Annualized realized historical volatility, using daily observations and 365 crypto-market days.
- Annualized Sharpe ratio with an explicitly assumed zero risk-free rate, and annualized Sortino ratio using downside deviation.
- Maximum drawdown of the reconstructed historical weighted portfolio equity curve.
- Best and worst observed portfolio days, plus the worst rolling 20-observation compounded return.
- A coverage warning when fewer than 20 aligned observations are available.

These statistics use current-notional weights and aligned daily close-to-close returns from the available exchange candles. They are backward-looking estimates; the zero-rate Sharpe, 365-day annualization, survivorship/coverage limitations, missing histories, and lack of FX conversion can materially affect interpretation. They do not model leverage, derivatives liquidation, intraday gaps, funding, fees or liquidity shocks. They are not forecasts or a guarantee of maximum loss.


## T-Bots integration and shared intelligence bridge

The original T-Bots application is preserved under `integrations/t-bots/` and served at `/t-bots/`. It retains the six cooperating agents and all original strategy/risk configuration. T-Bots' original executor is a simulator; its live DEX feed never sends wallet transactions.

Authenticated bridge routes (use `x-jpti-api-token`):
- `GET /api/integrations/tbots/status` — integration mode and safety boundary.
- `GET /api/integrations/tbots/context?exchange=binance&symbol=BTC%2FUSDT` — JPTI market-regime context from hourly candles, top-10 order-book imbalance and funding where supported.
- `POST /api/integrations/tbots/events` — idempotent bot telemetry append into the shared JPTI ledger. Supported event types: `bot_signal`, `bot_decision`, `bot_trade`, `bot_filter`, `bot_session`. Use a stable `externalId`.
- `GET /api/integrations/tbots/memory?limit=50` — recent T-Bots events from the shared ledger.

The embedded browser client publishes paper entries/exits, closed-trade summaries, filters and system decisions. It periodically reads JPTI BTC market context. A fresh `risk_off` score below 35 blocks new T-Bots entries only; the existing exit manager continues to operate. This is a coarse cross-market risk gate, not token-level analysis. Risk context uses a simple heuristic and should be treated as a conservative advisory filter, not a predictive model. Memory is a shared event journal, not an LLM memory or shared mutable strategy state.

Run the T-Bots terminal at `http://localhost:8787/t-bots/` while the JPTI API is running. Paste the local `JPTI_API_TOKEN` into the T-Bots compose screen to connect. Do not expose this token in a public deployment or commit it. The integration remains paper-only; no Solana wallet signing or swap execution is implemented.


## T-Bots unified multi-asset integration

T-Bots is embedded at `/t-bots/` and remains a six-agent paper engine. Its live discovery feed now consumes DexScreener latest token profiles across chain IDs, groups candidates by chain, and loads chain-specific pair data. Solana security enrichment uses RugCheck; selected EVM chains use GoPlus token-security data. Unknown chains and incomplete security results fail closed in the Rug Check agent.

Supported GoPlus mappings in this integration: Ethereum, BNB Chain, Polygon, Arbitrum, Optimism, Base, Avalanche, Linea and Blast. Solana uses RugCheck. The discovery feed is based on a provider's latest token-profile feed, not every token pair on every chain. Security provider coverage differs by chain, and missing LP-lock duration or holder data cannot be treated as a pass.

Authenticated endpoints:
- `GET /api/integrations/tbots/universe?q=token-or-project` — search multi-chain DEX pairs with a heuristic evidence score.
- `GET /api/integrations/tbots/risk` — closed paper-trade memory, recent loss streak and shared new-entry gate.
- `GET /api/integrations/tbots/memory?limit=50` — recent shared ledger events.
- `GET /api/integrations/tbots/context?exchange=binance&symbol=BTC%2FUSDT` — selected CEX benchmark context.

The shared risk gate pauses new T-Bots entries after three consecutive losing closed paper trades. If its state cannot be retrieved, new entries are blocked; existing positions continue through their normal exit logic. This is not a fully consolidated JPTI + T-Bots portfolio equity calculation. DEX execution remains simulated; no wallet signing or live swap execution is implemented.


## Universal cross-asset engine

Routes are mounted under `/api/universal`:
- `GET /profiles` — strategy profiles and asset-class coverage.

- `GET /api/universal/coverage` — public configuration/catalog coverage matrix for asset classes and providers. Reports configured sources, supported CCXT venue counts and configured watchlist sizes; it does not run provider health checks or guarantee a symbol is entitled/live.
- `POST /strategy/evaluate` — evidence-based deterministic profile evaluation.
- `GET /market/:exchange/:symbol?timeframe=1h` — public CEX ticker, OHLCV, 15m/1h/4h/1d trend alignment where supported, RSI, visible book depth, funding/open interest where supported and deterministic evidence council.
- `GET /cex-watchlist` — private-token authenticated read-only active spot watchlist configured with `JPTI_TBOTS_CEX_MARKETS`.
- `POST /asset-evidence` — private-token authenticated batch per-asset heuristic evidence score. This is not a safety check.
- `GET /asset/:chain/:address` — private-token authenticated DEX pair plus RugCheck (Solana) or GoPlus (selected EVM) security observations. Security output is review-required/fail-closed, not an approval.
- `GET /dex/search?q=...` — private-token authenticated multi-chain pair search.
- `GET /dex-watchlist` — private-token authenticated configured chain:contract watchlist for established DEX assets.
- `GET /macro` — CoinGecko global crypto metrics, DeFiLlama chain TVL, and FRED FEDFUNDS when configured.
- `GET /news?q=...` — GDELT article discovery.
- `GET /risk` — private-token authenticated shared entry gate and realized loss state.
- `GET /performance` — private-token authenticated paper-trade and exchange-fill attribution.

T-Bots can merge its multi-chain DEX feed with a configured CEX spot watchlist. Example server-side settings:

```env
JPTI_TBOTS_DEX_WATCHLIST=solana:YourSolanaMint,base:0xYourTokenContract
JPTI_TBOTS_CEX_MARKETS=binance:BTC/USDT,binance:ETH/USDT,binance:SOL/USDT,bitget:BTC/USDT
JPTI_TBOTS_MAX_CONSECUTIVE_LOSSES=3
JPTI_TBOTS_DAILY_LOSS_LIMIT_USD=100
```

The CEX watchlist is limited to active USD/stablecoin-quoted spot markets and checks 24h quote volume, visible order-book depth and spread before T-Bots can consider a paper entry. The optional DEX watchlist accepts up to 60 chain:contract entries and resolves the most liquid provider pair for each address. No private exchange credentials are required for this read-only feed.

Unified realized PnL is computed from recorded exchange fills with weighted-average cost and reported per quote currency. USD, USDT, USDC, DAI and FDUSD are treated as approximate USD equivalents for the daily loss guard; other currencies are not FX-converted. T-Bots paper PnL is separately denominated in USD. This is not full account equity reconciliation: unrealized positions, complete cashflows, transfers, funding, borrow, third-token fees and missing opening inventory remain limitations.


- `POST /universal/control` — private-token authenticated persisted pause/resume of T-Bots new entries. JSON body: `{"action":"pause_new_entries","reason":"operator request"}` or `{"action":"resume_new_entries"}`. Existing positions keep their normal exit handling; this is not a force-close or exchange cancellation command.


### Automated exchange balance reconciliation

The scheduler now performs read-only balance snapshots for configured CCXT venues (up to 10 per process) using the exchange private fetchBalance endpoint. Set JPTI_RECONCILE_EXCHANGES=binance,bitget to restrict venues; if omitted, all configured exchange adapters are considered.

Provide verified opening balances before expecting a true matched/mismatch result:

```env
JPTI_RECONCILE_EXCHANGES=binance,bitget
JPTI_RECONCILE_OPENING_BALANCES_JSON={"binance":{"BTC":0.25,"USDT":500},"bitget":{"USDT":100}}
```

The JSON map is keyed by exchange ID, then uppercase currency. The authenticated GET /api/operations/reconciliation endpoint returns up to 50 recent snapshots. Use the x-jpti-api-token header. Each currency row shows exchange-reported total, supported ledger movement, configured opening balance, expected total and difference. If an opening baseline is absent, the system reports baseline_missing and an implied opening balance; it never assumes the baseline is zero.

Supported movements include recorded spot fills (including base-, quote- and third-currency fees), deposits, withdrawals and explicitly directed cash-flow events. Transfers and other cash-flow events without a recognized metadata.direction are counted as unresolved. A snapshot is not marked complete when unresolved events or missing baselines remain. This is a reconciliation aid, not a complete statement: it does not yet normalize margin liabilities, derivative positions/funding, cross-venue transfers, third-party custody, or unrecorded activity. Use read-only exchange API keys.


## Durable storage and recovery

JPTI supports two storage backends:

- `JPTI_STORAGE_BACKEND=file` (default): local append-only `data/jpti-events.jsonl` plus atomic `data/jpti-cursors.json`. This is suitable for local development and single-process use; it is not a multi-instance production database.
- `JPTI_STORAGE_BACKEND=postgres`: PostgreSQL-backed JSONB event storage with a database-enforced unique ledger identity and durable exchange fill-sync cursors. The API applies the initial schema at startup and fails startup if the database cannot be initialized. Configure `DATABASE_URL`; managed databases should normally use `JPTI_DATABASE_SSL=true` with certificate verification enabled.

Example production environment:

```env
JPTI_STORAGE_BACKEND=postgres
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
JPTI_DATABASE_SSL=true
JPTI_DATABASE_SSL_REJECT_UNAUTHORIZED=true
JPTI_DATABASE_POOL_MAX=10
```

The database schema is also versioned in `migrations/001_initial_durable_storage.sql`. Ledger ingestion uses a unique database index across source, account, external trade ID and symbol, so duplicate polls across process restarts or multiple API instances are rejected by PostgreSQL rather than an in-memory check. Sync cursors are persisted per exchange/market and updated monotonically. Operational event reads, ledger history, reconciliation snapshots and monitor snapshots use the configured storage adapter.

This stage makes event persistence and sync cursors durable; scheduler leadership/leases, transactional outbox delivery, historical JSONL backfill tooling, multi-region failover, backup/restore automation and complete paginated exchange-history ingestion remain separate production-hardening tasks. Keep API instances restricted to trusted networks and use a dedicated database role with only the required table permissions.


## Multi-instance scheduler leadership

When `JPTI_STORAGE_BACKEND=postgres`, JPTI uses a PostgreSQL-backed lease (`jpti_scheduler_leases`) so only one API instance starts the periodic operations workers at a time. The leader renews its lease on a heartbeat; a standby instance takes over after the lease expires or the current owner releases it. If lease verification fails, the scheduler pauses rather than continuing to run uncoordinated jobs. The lease table is created automatically at startup and is also documented in `migrations/002_scheduler_leases.sql`.

Tune the lease with `JPTI_SCHEDULER_LEASE_MS` (15–120 seconds, default 30 seconds) and `JPTI_SCHEDULER_HEARTBEAT_MS` (at least 3 seconds and no more than half the lease, default 10 seconds). Set `JPTI_SCHEDULER_INSTANCE_ID` to a stable deployment instance label if useful; a random owner ID is generated otherwise. Use the same PostgreSQL database and compatible lease settings for every instance. The `/api/operations/overview` response exposes coordination mode, owner, leadership and running state.

File storage remains single-process only: its lease is an in-process guard, not a cross-process distributed lock. Run one API process when using the file backend. The lease prevents duplicate scheduler startup, but it is not a transactional job queue: a worker already in flight when leadership is lost may finish, so durable job-level idempotency and transactional outbox processing remain follow-up hardening. No trading orders are placed by scheduler coordination.


## Transactional ledger ingestion and outbox

Automatic exchange fill polling now commits each market's normalized ledger batch and its sync cursor in one PostgreSQL transaction. A crash cannot advance the cursor without committing the corresponding fill rows; duplicate trade identities remain protected by the database unique index. Each newly inserted ledger fill also creates a `ledger.transaction.recorded` outbox message in the same transaction. Replays do not create duplicate ledger rows or duplicate outbox records.

Authenticated outbox routes (send `x-jpti-api-token`):
- `GET /api/operations/outbox/status` — pending, processing and delivered counts.
- `POST /api/operations/outbox/claim` — claim up to 100 messages using `{ "workerId": "consumer-name", "limit": 25, "leaseMs": 30000 }`. Claims use PostgreSQL `FOR UPDATE SKIP LOCKED`; expired processing leases can be reclaimed.
- `POST /api/operations/outbox/:id/ack` — acknowledge a message with `{ "workerId": "consumer-name" }`. Only its current lease owner can acknowledge it.
- `POST /api/operations/outbox/:id/retry` — release a failed message for retry with optional `error` and `delayMs` fields. The retry delay is bounded.

Outbox consumers must be idempotent: delivery is at-least-once, not exactly-once. If a consumer completes its side effect and crashes before acknowledgement, the message may be delivered again after its lease expires. Use the stable `event_id` as the consumer's deduplication key. PostgreSQL is required for transactional outbox claiming and acknowledgement. File mode retains replay-safe ledger insertion followed by cursor advancement, but those two writes are not a single crash-atomic transaction and no distributed outbox is available; use PostgreSQL for multi-instance production operation. No live orders or transfers are executed by this feature.
\n\n## Universal futures cross-exchange intelligence (Phase 11)\n\n- `GET /api/futures/catalog` — derivative-capable CCXT venue catalog and public capabilities.
- `GET /api/futures/universe?kind=perpetual&search=BTC&limit=500` — discover matching active perpetual/dated derivative contracts across the full CCXT venue catalog (cached; metadata discovery only).\n- `GET /api/futures/compare?symbol=BTC/USDT:USDT&kind=perpetual&exchanges=binance,bybit,okx,bitget&depth=20&amount=0.01&takerFeeBps=6` — compares compatible perpetual or dated contracts, ticker last/mark/index/bid/ask, order-book depth, funding and cross-venue net-spread estimates.\n- `GET /api/futures/funding?symbol=BTC/USDT:USDT&exchanges=binance,bybit,okx,bitget` — funding-rate and next-payment comparison.\n\nThe engine resolves derivative markets by base, quote, settlement and contract type. It does not assume that similarly named contracts are identical. Fee rates are estimates unless verified against the user's account fee tier. Depth-aware prices are estimates from a sampled book and do not model queue position, latency or partial execution. Funding is reported separately from spread. Initial support is public real-time market intelligence plus paper research; no live futures order endpoint is introduced. REST polling and a short cache are used in the initial market-intelligence phase; exchange-native WebSocket streaming remains follow-on work. Persistent paired-leg paper execution is added in Phase 11B and documented below.\n

## Cross-exchange futures paper lifecycle (Phase 11B)

The futures paper lifecycle is an event-sourced, persistent simulation layer. It is mounted under `/api/futures` and does not call exchange order APIs.

- `GET /api/futures/paper/positions` — list persisted paired positions and their current lifecycle state.
- `POST /api/futures/paper/positions` — open a paired simulated buy/sell position. Requires two different exchanges, matching base/quote/settlement, and compatible linear contract metadata. Body fields: `symbol`, `quantityBase`, `feeBps`, and `buy`/`sell` objects containing `exchange`, `symbol`, `contract` and `entryPrice`.
- `POST /api/futures/paper/positions/:id/mark` — append a mark-to-market event with `buyPrice` and `sellPrice`.
- `POST /api/futures/paper/positions/:id/close` — close both simulated legs together using `buyPrice` and `sellPrice`.

Write and read endpoints use the existing private API authorization policy. The paper-entry kill switch is checked before a new position is opened. Per-leg notional is capped by `JPTI_FUTURES_PAPER_MAX_NOTIONAL_USD` (default 1,000 USD). Events are stored using the configured JPTI event store, so file storage is local and PostgreSQL storage is durable when configured.

**Model limitations:** the first lifecycle supports linear contracts only and rejects inverse contracts. PnL is based on base quantity and exchange-reported contract size, with estimated entry/exit taker fees. Funding, slippage, market impact, partial fills, margin, liquidation and exchange-specific fee tiers are not included. Marks and exits are user-supplied observations, not authenticated live fill records. This is a research/paper ledger, not an arbitrage guarantee or live execution system.


## Phase 12 — Universal asset intelligence and evidence quality

- `GET /api/assets/universe?exchanges=binance,bybit,okx,bitget&assetClass=all&search=BTC&limit=200` — discover active CCXT instruments and normalize spot, perpetual, dated futures, options and margin metadata into a common schema. At most eight venues are queried per request with bounded concurrency; the default venue set is Binance, Bybit, OKX and Bitget.
- `POST /api/assets/quote-consensus` — assess up to 30 timestamped provider observations. The quality gate rejects invalid prices, missing timestamps/currencies, future timestamps and stale observations; a median anchor flags outliers and refuses to combine different currencies.

The Asset Intelligence workspace exposes the normalized venue universe and reports provider failures and result truncation. Exchange catalog metadata is not proof of account entitlement, liquidity, legal availability or execution support. The quote-consensus helper is a research reference and does not replace executable bid/ask depth checks. Non-CCXT asset classes remain dependent on their provider-specific endpoints and credentials.


## Phase 13 — Explainable multi-agent research council

Private authenticated endpoints:
- `POST /api/council/evaluate` — evaluates timestamped instrument evidence through six deterministic specialist engines (trend, participation, microstructure, derivatives positioning, macro regime, liquidity/volatility risk), then reports weighted consensus, agreement, dissent, missing evidence and freshness.
- `GET /api/council/history?limit=25` — reads recent persisted council evaluations from the append-only event store.

The council blocks directional consensus when evidence is stale/missing or fewer than three directional specialists can evaluate. Its permissions are hard-coded research-only: paperEntryEligible=false, liveExecutionAuthorized=false and ordersCreated=0. This phase uses deterministic, explainable specialist logic; it does not claim to invoke external LLMs or train a machine-learning model. See the AI Intelligence workspace for evidence submission and history.


## Phase 14 — Portfolio construction and risk parity

- `POST /api/portfolio/allocation/risk-parity` — authenticated long-only covariance-aware equal-risk-contribution allocation. The request contains 2–20 assets with unique symbols, one common explicit quote currency, and at least 30 aligned finite return observations per asset. Optional `minWeight`/`maxWeight` constraints are applied through bounded-simplex projection.
- The result includes per-asset weights and risk contributions, portfolio volatility, diversification ratio and concentration. Each calculation is persisted as a portfolio-allocation recommendation event.
- No order is submitted and execution authorization remains false. Returns are assumed to share one sampling interval; annualization depends on the supplied `periodsPerYear`. Shorting, leverage, FX conversion, transaction costs, liquidity constraints and market impact are excluded.


## Phase 15 — Market stream transport gateway

- `GET /api/stream/status` — reports transport type, active client count and capacity.
- `GET /api/stream/market?exchange=binance&symbol=BTC/USDT&intervalMs=5000` — bounded Server-Sent Events quote stream. Native public spot ticker WebSocket adapters are used for Binance, Bybit, OKX and Bitget; unsupported venues or unavailable native sockets fall back to CCXT REST polling. Default capacity is 25 clients; REST fallback interval is 3–60 seconds; per-client exchange and socket resources close when the response disconnects.
- This streams ticker observations, not full order-book delta depth. Native WebSocket health is monitored and the REST fallback is fail-safe for quote continuity.

## Phase 16 — Portfolio stress and historical risk

- `POST /api/portfolio/risk/stress` — authenticated historical VaR/expected shortfall, max drawdown and deterministic scenario shocks from aligned simple-return observations. One explicit quote currency is required; each asset must have at least 30 aligned observations. The result is persisted as an audit event.
- Historical risk is descriptive and cannot model derivatives margin/liquidation, funding, FX conversion or liquidity impact.

## Phase 17 — Fail-closed pre-trade risk preflight

- `POST /api/risk/preflight` — authenticated assessment of account equity, daily realized PnL, a fresh timestamped quote, position size, protective stop, order notional, gross exposure, symbol concentration and risk budget. The caller must explicitly provide an existing-exposure array (an empty array is valid); missing or malformed exposure inventory blocks the intent.
- A passing result only marks a paper intent eligible. It does not reserve capital, verify the account balance with an exchange, or create an exchange order. Live execution remains unauthorized.

## Phase 18 — Immutable strategy registry and paper promotion review

- `POST /api/strategies/registry` — publish an immutable semantic-versioned strategy definition with asset classes, timeframes, rules, risk policy and SHA-256 checksum. Duplicate strategy/version pairs are rejected.
- `GET /api/strategies/registry` — list persisted immutable versions.
- `POST /api/strategies/promotion-review` — review minimum sample size, profit factor, drawdown, positive out-of-sample return, walk-forward consistency, data quality and risk-control evidence. A pass is a paper-trial candidate only; live promotion is always false.

## Phase 19 — Deterministic market replay

- `POST /api/research/replay` — authenticated replay of 60–20,000 chronological OHLCV candles using `ema_cross` or `breakout`, next-candle-open fills, fixed fee/slippage assumptions, long-only position sizing, equity/drawdown, trades and chronological 70/30 reporting split.
- The JSON body parser is bounded at 4 MB. The replay does not optimize parameters, guarantee fills, or model intrabar queue position, partial fills, funding, margin or liquidation.

## Phase 20 — Operational observability

- `GET /api/observability/diagnostics` — authenticated request counts, 5xx counts, route latency aggregates, event-loop delay, process memory, uptime, storage and scheduler state, configured exchange count and non-secret readiness checks.
- Telemetry stores only bounded route/method aggregates; it does not capture request bodies, API keys or order payloads.

## Phase 21 — Production readiness gate

- `GET /api/governance/readiness` — authenticated read-only assessment of API binding, API token strength, durable PostgreSQL storage, distributed scheduler, CORS allowlist, order-notional cap, exchange credential configuration and explicit operator acknowledgement.
- Passing the configuration checks only means the listed gates are configured. The endpoint never authorizes live execution, changes environment flags or submits orders. Security review, venue permission review, legal/regulatory assessment and operator approval remain separate requirements.


## Phase 22 — Institutional Market Intelligence

- `GET /api/institutional/context/:exchange/:symbol?timeframe=1h` — selected-exchange OHLCV and order-book liquidity pools, equal highs/lows, visible depth walls, sweep proxies, funding/open interest when supported, FRED macro observations, Forex Factory economic events, official Federal Reserve communications, GDELT news, optional Finnhub earnings and dynamic event-volatility risk.
- `GET /api/institutional/calendar?symbol=BTC/USDT` — normalized economic calendar and central-bank communication items with timestamps, currency, impact, actual, forecast, previous and surprise where numeric values are available.
- `GET /api/institutional/news?symbol=BTC/USDT` — instrument-related and macro news discovery from GDELT.
- `GET /api/institutional/earnings?symbol=AAPL/USD` — selected-equity earnings events when Finnhub credentials are configured.
- `GET /api/institutional/history` — persisted intelligence snapshots.
- `GET /api/institutional/sources` — source registry, configuration state and limitations.

The Institutional Market Intelligence dashboard is linked to the embedded live candlestick chart. The chart's exchange selector, pair selector and timeframe drive the intelligence request key; the panel refreshes every 45 seconds. Selected-venue book walls, funding and open interest are only returned when the adapter supports them. The macro snapshot reads FRED series when `JPTI_FRED_API_KEY` is configured. Finnhub earnings data requires `JPTI_FINNHUB_API_KEY` and is omitted for crypto/FX pairs.

Live order submission now runs an institutional event/volatility preflight. A high-impact event inside the restricted window or severe live volatility expansion blocks new live entries. By default, a missing Forex Factory calendar feed also blocks live orders (`JPTI_EVENT_RISK_FAIL_CLOSED=true`); an operator may explicitly set it to false to accept this data gap. The policy does not close existing positions or replace protective exits.

The Forex Factory JSON feed is third-party data, not an official government release. Federal Reserve RSS feeds provide official published communications but are not a complete forward calendar or transcript-based stance model. FRED and Finnhub are optional credentialed sources. GDELT is a news discovery index, not a verification service. Confirm high-impact releases with the issuing agency.

Liquidity pools from candle structure are technical estimates. Order-book depth is venue-specific and can be cancelled, replenished or spoofed; it does not establish institutional ownership. FX spot has no consolidated public order book. Event-risk policy is only as reliable as its source coverage and timestamps. Full speaker transcript stance-change detection, licensed institutional news, complete global central-bank calendars, and historical event-reaction backtesting remain separate provider/data projects.

See [Institutional Market Intelligence documentation](../docs/INSTITUTIONAL_MARKET_INTELLIGENCE.md).


## Bitget public intelligence and unified exchange access


Bitget is available through the dynamic CCXT exchange catalog (public market catalog, ticker, OHLCV, order book, and configured private read endpoints where the adapter supports them). Optional credentials are managed server-side as `JPTI_BITGET_API_KEY`, `JPTI_BITGET_API_SECRET`, and `JPTI_BITGET_PASSWORD`; keep withdrawal permissions disabled and use read-only permissions for initial connection testing.


Public, credential-free Bitget market intelligence endpoint:

- `GET /api/providers/bitget/market-intelligence/:symbol` — cached read-only snapshot of ticker, top-20 order book, recent trades, funding rate and open interest when supported; each component reports its own availability, with latency and coverage metrics. Cache defaults to 5 seconds and can be configured with `JPTI_BITGET_SNAPSHOT_CACHE_MS` (1–15 seconds).
- `GET /api/providers/consensus/quote/:symbol` — Bitget public ticker is included in multi-provider consensus unless `JPTI_ENABLE_BITGET_CONSENSUS=false`.
