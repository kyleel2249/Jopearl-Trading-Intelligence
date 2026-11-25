# JOPEARL TRADING INTELLIGENCE (JPTI)

JPTI is a React/Vite trading-intelligence workspace hosted on **Cloudflare Pages only**. The web application and its Cloudflare Pages Functions share one origin. Public market catalog, ticker, cross-venue ticker comparison and OHLCV candlestick requests are served from Cloudflare edge functions; the web build does not require a separately hosted API gateway URL, Render service, or exchange API keys for public market data.

The repository retains the legacy Node/Express + CCXT service for desktop packaging and local development. It is not a web host and is not deployed to production; the public web application uses Cloudflare Pages Functions, D1, KV and the optional Workers AI binding. Node/PostgreSQL adapters remain isolated to local/desktop workflows and must never be treated as production Cloudflare services.

**Cloudflare production scope:** the current Pages runtime serves public spot markets, tickers and OHLCV candlesticks for Binance, Bybit, OKX and Bitget. Bitget's public market adapter also supports Margin, USDT-M, Coin-M and USDC-M catalogs, tickers and candles. Cross-venue ticker comparison and a limited single-timeframe chart-context score are available. The deployment workflow applies pending D1 migrations and then runs live post-deploy checks for all five Bitget categories. The remaining legacy server routes are not yet Cloudflare-native; they return an explicit unsupported response instead of silently calling another host. Private exchange accounts, order execution, a persistent trading ledger, scheduled engines and server-backed portfolio/intelligence services must not be treated as live until ported and verified on Cloudflare.

## Implementation status

**Implemented in this build**
- Selectable local JSONL or PostgreSQL event storage; PostgreSQL mode uses JSONB event records, database-enforced ledger idempotency, durable per-market exchange fill-sync cursors and startup schema initialization. Local-file mode remains the default for development.
- Responsive React dashboard for desktop and mobile browsers.
- Node.js API gateway with live public ticker and market-catalog endpoints.
- Multi-exchange CCXT adapter catalog (availability is detected from the installed CCXT version).
- Server-side private account-balance endpoint for exchanges with configured credentials.
- Locked live spot-order endpoint with explicit environment flags, API-token confirmation, active-market checks, USDT quote restriction and per-order notional cap.
- Exchange selector with dynamic, searchable market discovery across spot, futures, perpetual swaps, margin-enabled instruments, CFDs and options where the selected exchange exposes those products.
- Market type filters, per-exchange product counts and adapter capability metadata; the catalog refreshes every five minutes to discover newly listed and delisted instruments.
- Advanced chart tools: VWAP overlay, Stoch RSI, OBV, price trend bias, horizontal support/resistance levels and two-click trend lines.
- Live OHLCV candlestick chart with selectable exchange-supported timeframes (1m through 1M where supported), zoom controls, fit-to-view and crosshair OHLCV inspection. Candle density/spacing, candle-body width and volume-column height are independently adjustable with sliders and reset controls.
- Optional EMA 20, EMA 50 and Bollinger Band overlays; RSI(14), ATR(14), MACD histogram and volume analytics.

- Financial intelligence workspace: CoinGecko global crypto market statistics; DeFiLlama chain TVL, stablecoin supply and protocol-fee leaders; FRED macroeconomic observations when a server-side API key is configured.
- Address-level blockchain history lookups: Alchemy indexed EVM asset transfers (Ethereum, Base, Polygon, Arbitrum and Optimism) and Helius enhanced Solana transactions when provider keys are configured.
- Explainable market-context scoring endpoint that combines closed-candle momentum, relative volume, multi-timeframe alignment (15m/1h/4h/1d where supported), top-20 order-book depth imbalance, perpetual funding when available, CoinGecko aggregate crypto risk context and DeFiLlama chain TVL context. Each factor contribution, source status, timestamp and limitations are exposed; the score is a research heuristic, not an autonomous trading instruction.
- Dedicated multi-market Opportunity Radar that ranks eight liquid USDT spot pairs using explainable technical evidence, relative-volume participation, volatility and conflict penalties, plus timestamp-aligned cross-market return correlations. The 0–100 score is an ordinal research ranking, not a probability or order instruction; missing market context remains visible.
- Smart Money Concepts (SMC) analysis calculated from closed OHLCV candles: three-candle Fair Value Gaps, confirmed swing-high/low liquidity sweeps, close-confirmed BOS/CHoCH structure breaks, and heuristic last-opposing-candle order-block zones.
- Independent visibility controls for FVG, liquidity sweeps, BOS/CHoCH and order blocks, configurable swing sensitivity (2/3/5/8 bars), chart overlays and an SMC event summary.

**Phase 9 — Institutional terminal and operator experience**
- Dedicated institutional command terminal with a safe allowlisted command parser (`HELP`, `STATUS`, `REFRESH`, `OPEN`, `SYMBOL`, `WATCH`, `UNWATCH`, `RISK`); no shell, arbitrary code execution or direct order command is exposed.
- Multi-venue public ticker watchlist across Binance, Bitget, Bybit and OKX, with local non-sensitive watchlist persistence, source/dispersion context and explicit indicative-data caveats.
- Live service telemetry, paper-mode status, quick workspace routing and authenticated ledger-backed portfolio risk snapshot in one responsive terminal.
- Institutional visual system: layered navy surfaces, restrained blue/cyan/emerald/violet/amber status colors, refined typography, responsive operator panels and reduced-motion support.

**Phase 8 — Unified strategy intelligence and T-Bots paper-entry controls**
- Authenticated strategy scorecards by strategy profile, calculated from persisted T-Bots paper-closed events only, including expectancy, win rate, profit factor, drawdown, sample-size quality, and venue/asset-class breakdowns.
- Authenticated paper-entry preflight combining required strategy evidence, server-enforced evidence freshness, persisted global pause state, consecutive-loss limits, daily realized-loss guard and token-security status.
- T-Bots calls the shared JPTI preflight after its own rug check and before sizing/entry when the authenticated bridge is configured. Failed or unavailable preflight blocks new paper entries; open positions retain their exit logic.
- New configuration: `JPTI_TBOTS_PREFLIGHT_MAX_EVIDENCE_AGE_SECONDS=90`. See `docs/PHASE_8_STRATEGY_INTELLIGENCE.md`.

**Not yet implemented / not to be mistaken for complete functionality**
- PostgreSQL-backed persistence requires `JPTI_STORAGE_BACKEND=postgres`, a reachable `DATABASE_URL`, and the documented TLS settings. Local JSONL mode is intended for single-process development; scheduler leader election and multi-instance coordination are not yet implemented.
- The main candlestick chart and top market strip use live OHLCV/ticker data from the selected exchange. Product availability and market classification are exchange-specific; an instrument is only shown when its adapter reports it in the public catalog. Portfolio balances, PnL, scanner, autonomous-agent status and watchlist sample values remain illustrative until their services are implemented.
- SMC markings are rule-based technical interpretations, not proof of institutional activity. Order blocks are candidate zones, and all signals require trader validation. Multi-timeframe confluence, advanced alerts and SMC-based strategy backtesting are not yet implemented. FVGs are marked filled after a full traversal of the gap, and order-block zones are marked invalidated after a close through the far boundary.
- Financial and on-chain coverage is provider-dependent: CoinGecko/DeFiLlama endpoints are public and may rate-limit; FRED, Alchemy and Helius require user-created server-side API keys. Wallet history is indexed/provider-limited, not a complete chain archive, and wallet ownership/intent is not inferred. The confluence scoring endpoint is not yet a validated backtested strategy or an order trigger; on-chain wallet histories are currently available through separate read-only address lookups and are not automatically attributed to exchange netflows or fed into pair scores. Equities, bonds, FX and commodity feeds are not yet connected as live tradable market feeds; FRED provides selected macroeconomic time series only.
- No persistent multi-user account system, Redis cache/queue, general-purpose production WebSocket streaming, private futures/margin account access and execution, copy-trading engine or institution-grade portfolio accounting yet. The Reflective Trade Journal, session outcome memory, GainzAlpha learning outcomes and optional Workers AI mentor review use authenticated same-origin Cloudflare Pages Functions and D1. GainzAlpha adaptation is guarded heuristic learning from recorded outcomes; it is not a calibrated probability or an order-execution engine. Android debug APK builds are produced by CI and the current debug APK is published under `android/app/downloads`; a signed production APK/AAB requires the Android signing secrets documented in the build workflow. PostgreSQL durable event storage and scheduler leases are implemented when configured.
- A configured exchange key does not mean an exchange account has been authenticated until a private endpoint succeeds.
- No exchange is connected until you configure your own credentials and verify the connection.

## Requirements

- Node.js 22 LTS (npm included)
- Git
- Internet access to download packages and reach exchange APIs

## Local development

Requirements: Node.js 22 and npm.

```bash
npm install
cp .env.example .env
npm run dev
```

For Cloudflare Pages Functions locally:

```bash
cp .dev.vars.example .dev.vars
npm run dev:pages
```

For legacy Node API development only, use `npm run dev:api` or `npm run dev:all`. This local API is not the Cloudflare production runtime. Keep paper mode enabled; do not add secrets to Vite variables.

See [Cloudflare Pages deployment](docs/CLOUDFLARE-PAGES.md) for production configuration.
