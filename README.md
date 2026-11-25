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
- Global Institutional Intelligence chart integration: the existing exchange/global context feed now enters the canonical closed-candle chart engine as a timestamp-gated, source-attributed factor. Global crypto risk, local momentum, order-book pressure, funding crowding and context MTF evidence contribute to chart directional confluence (12% reserved base weight, renormalised over available factors). Stale/missing feeds are excluded; opposing high-confidence institutional evidence adds an explicit chart conflict and lowers setup quality. The chart, Alpha evidence mapper and multi-chart workstation consume the same canonical result; no parallel BUY/SELL engine is introduced.
- Dedicated multi-market Opportunity Radar that ranks eight liquid USDT spot pairs using explainable technical evidence, relative-volume participation, volatility and conflict penalties, plus timestamp-aligned cross-market return correlations. The 0–100 score is an ordinal research ranking, not a probability or order instruction; missing market context remains visible.
- Deterministic multi-agent debate for every radar candidate: six named specialist roles publish weighted votes, evidence reasons, dissent, data availability and risk vetoes. Only a risk-cleared, direction-aligned consensus is labelled a paper-review candidate; this is never an order instruction or live-trading authorization.
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
- The institutional chart factor consumes exchange momentum, live order-book depth/funding where supported, CoinGecko global crypto breadth, CFTC TFF trader cohorts, selected FRED bank/macro series, Treasury Fiscal Data, ECB reference rates, retail Fear & Greed, GDELT event headlines and EIA weekly inventory context for energy symbols. Private bank/prime-broker flows, BIS cross-border banking series, paid satellite/shipping/credit-card datasets and wallet-attributed institutional flows remain provider-dependent and are not fabricated.
- Financial and on-chain coverage is provider-dependent: CoinGecko, DexScreener and GeckoTerminal public endpoints may rate-limit; FRED, Alchemy and Helius require user-created server-side API keys. Confirmed DEX swaps from sampled pools now enter chart confluence and are persisted in D1, but this is not a complete chain archive. Wallet-specific transfer histories remain indexed/provider-limited; wallet ownership and intent are not inferred, and those wallet histories are not yet automatically attributed to exchange netflows. The confluence score is not a validated backtested strategy, calibrated probability or order trigger. Equities, bonds and FX are not yet connected as complete live tradable feeds; selected macro and EIA inventory series are context only.
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


## Unified Institutional, Blockchain, DEX and Chart Intelligence

The chart's canonical closed-candle engine now consumes independently sourced institutional, retail, exchange, on-chain and session evidence. These sources affect confluence, conflict detection, setup quality and chart liquidity overlays. GainzAlpha remains the sole BUY/SELL signal authority.

### Connected sources

- **Exchange and derivatives:** closed-candle OHLCV, top-20 order-book depth and perpetual funding where supported for Bitget, Binance, Bybit and OKX, plus 15m/1h/4h/1d/1w multi-timeframe context where the venue exposes those intervals.
- **Global market breadth:** CoinGecko global market-cap change, total market capitalisation, 24h volume and BTC dominance.
- **Retail sentiment:** Alternative.me Crypto Fear & Greed index.
- **CFTC positioning:** Traders in Financial Futures, Futures Only dataset for Bitcoin/Ether dealer/intermediary, asset-manager, leveraged-fund, other-reportable and non-reportable positioning cohorts (the last is a smaller-trader proxy, not a pure retail measure). This is a weekly report with a publication lag, not live dealer flow.
- **Federal Reserve:** optional FRED series for 10-year Treasury yields, broad trade-weighted dollar, effective fed funds rate, Federal Reserve assets, commercial-bank deposits, commercial and industrial loans, and total commercial-bank assets. Configure the server-side `FRED_API_KEY` Cloudflare Pages secret; the browser never receives the key.
- **U.S. Treasury:** public Fiscal Data average-interest-rate observations.
- **European Central Bank:** daily EUR/USD reference exchange-rate observations through the ECB SDMX API.
- **Federal Reserve releases:** official press-release RSS headlines are surfaced as event context only; headline text is not automatically assigned a bullish/bearish score.
- **Geopolitical and financial news:** GDELT DOC 2.0 headlines are monitored for recent high-impact event terms. Event risk raises chart conflicts and reduces entry quality; it does not guess a directional trade.
- **Energy inventory context:** FRED-hosted EIA weekly crude, gasoline and distillate inventory series are available when FRED is configured. Crude inventory bias is applied only to recognised energy symbols, not indiscriminately to crypto charts.
- **DEX / on-chain swaps:** DexScreener multi-chain pool discovery and 24-hour liquidity/volume/transaction aggregates, with GeckoTerminal confirmed swap samples from up to two highest-liquidity supported chains per token refresh.

### Chart integration and controls

- The canonical confluence model now includes linked FVG + Liquidity evidence (8%), cross-exchange public depth/funding/taker-flow pressure (5%), explicitly verified wallet swap flow (5%) and correlated-market SMT divergence (4%). Existing components are proportionally rescaled to keep the model at 100%; missing or stale sources are excluded and available weights are renormalised. BIS banking statistics and event-impact context are risk/macro context, not directional BUY/SELL generators.
- High-confidence opposing institutional or DEX evidence creates an explicit chart conflict. Severe institutional conflict withholds the proposed plan.
- SMC liquidity sweeps are quality-scored from pool hierarchy, wick penetration, reclaim distance and relative volume. Order blocks are quality-scored from displacement-body strength, relative volume and subsequent mitigation depth/touches.
- Mitigated FVGs remain represented in chart history rather than disappearing when later candles fill them.
- Rolling 24-hour observed highs/lows and four session forecast high/low bands are plotted in the chart liquidity layer. Session forecasts use historical session ranges, volatility scaling, directional skew and a visible sample-confidence grade.
- FVG + Liquidity analysis correlates a confirmed sweep with subsequent displacement, BOS/CHoCH/MSS and a same-direction FVG. It scores sweep quality, displacement, gap size, freshness, structure and age; tracks fresh/partial/full mitigation and expiry; groups liquidity clusters; and maps opposing-side liquidity targets. The Live Candlestick panel exposes linked setup state and score. FVG evidence enriches the canonical engine and chart overlays; it does not create a second signal engine.
- Entry assessment requires a confirmed GainzAlpha signal plus a nearby directional zone, liquidity sweep, structure break, displacement and retest. A linked sweep-to-FVG setup increases the checklist score; absence of a linked setup is disclosed. The status is a checklist, not a probability or an order. Existing open trades are labelled for position management instead of fresh entry.
- Confirmed DEX swaps are persisted idempotently in the existing `jpti_events` D1 table. Chart context includes recent swap samples and durable per-symbol history; `GET /api/chain-dex/transactions/:symbol` exposes the stored records.

### Additional institutional and event context

- **Cross-exchange aggregation:** JPTI samples public top-20 order-book depth and perpetual funding from Binance, Bybit, OKX and Bitget, normalises fresh venue observations and calculates a dispersion-aware consensus. This is a public market-pressure proxy, not a verified view of institution-owned trades or positions.
- **BIS full-catalogue monitoring:** discovers the complete official BIS SDMX dataflow catalogue from `stats.bis.org`, classifies financially relevant flows, and rotates through every relevant dataflow. Each flow is queried for its latest observation across its available series; the complete catalogue and scan cursor are cached in KV, and per-flow observations are cached separately. The Live Candlestick panel reports total catalogue size, financial dataflow count, series scanned and scan coverage. Because BIS cubes vary greatly in size and publication frequency, the crawler uses bounded batches and rotates across all financial flows rather than downloading every historical observation on every candle refresh. BIS remains low-frequency macro context, not tick-level flow. Official API: https://stats.bis.org/api-doc/v1/.
- **Multi-source wallet attribution:** manual proof-backed entries from `JPTI_VERIFIED_WALLET_REGISTRY` remain distinct from third-party provider labels. When `BITQUERY_ACCESS_TOKEN` is configured, JPTI batches observed swap-trader addresses (up to 100 per GraphQL request) against Bitquery's multi-chain Address Labels API, covering supported EVM chains, Solana and other provider-supported networks. Provider labels are explicitly marked `provider-attributed`, never upgraded to cryptographic verification. Unknown addresses remain unattributed. The source only enriches addresses actually observed in the sampled DEX trade stream; it does not enumerate every address on every chain. API documentation: https://docs.bitquery.io/docs/labels/address-labels-api/.
- **Event-impact engine and official calendars:** combines public financial/geopolitical headlines, optional verified `JPTI_EVENT_CALENDAR_JSON` entries, the Federal Reserve FOMC calendar, ECB Governing Council calendar, Bank of England MPC dates, Bank of Japan policy meeting dates, EIA weekly petroleum release schedule, U.S. Treasury upcoming auctions, and FRED economic release dates when `FRED_API_KEY` is configured. Events carry source URL, region, affected assets, importance and scheduled time; source failures are reported rather than silently replaced. It returns a direction-neutral volatility-risk score, event window and source coverage. This is a transparent heuristic, not a trained or calibrated forecast model.
- **SMT divergence:** compares confirmed swing highs/lows on the selected market against a correlated market (BTC/ETH for BTC, BTC for other symbols). A divergence is added as a low-weight confluence input and chart evidence; it does not create a second signal engine.

### Data coverage and limitations

DEX discovery is symbol-based and ranks returned pools by liquidity. It is not a guarantee that every contract with the same ticker is the intended asset. Review the chain, token contract, pool and liquidity before relying on a pool. The current feed samples up to two highest-liquidity supported chains for confirmed swaps and aggregates the top discovered pools; it does **not** claim to capture every swap on every chain or every historical transaction. The D1 history contains only swaps observed by this JPTI feed after it is deployed.

CFTC positioning is weekly and delayed. Treasury, ECB, FRED and EIA series follow their own release calendars. GDELT headlines are event-risk context, not directional instructions. BIS scans cover the complete discovered catalogue in rotating batches; full historical extraction of every dimension/value combination is intentionally not performed on each chart refresh. Cross-exchange depth/funding is a public proxy, not private institutional flow. Wallet attribution is limited to addresses observed in sampled DEX pools and returned by the configured Bitquery provider and/or manual evidence registry; it is not an exhaustive chain archive or proof of beneficial ownership for provider labels. Private bank/prime-broker client flows, proprietary dealer inventory, paid shipping/satellite datasets and provider-authenticated full-chain transfer streams still require licensed access and/or additional provider credentials. Missing feeds are marked unavailable and are not fabricated.

### FRED secret configuration

For local Pages development, copy `.dev.vars.example` to `.dev.vars`. Set `FRED_API_KEY` for FRED release dates and Federal Reserve series, `BITQUERY_ACCESS_TOKEN` for dynamic multi-chain wallet-label enrichment, `JPTI_VERIFIED_WALLET_REGISTRY` for manually proof-checked wallet records, and `JPTI_EVENT_CALENDAR_JSON` for additional verified scheduled events. BIS discovery is automatic and does not require a dataset URL or API key. Each wallet record has `chain`, `address` and `claims`; a claim needs an allowed `type`, `verified: true`, a trusted `source`, an HTTPS `sourceUrl`, and the matching proof field (`registryRecordId` for official registry, `attestationId` plus `signatureVerified: true` for a signed attestation, `providerLabelId` for a provider label, or `proofId` for an exchange-published proof). JPTI validates the supplied evidence fields but does not cryptographically validate signatures or independently browse the registry; an operator must verify the proof before adding it. Do not claim verification for a label you have not independently checked. Calendar entries must include `verified: true`, `title`, `time` or `scheduledAt`, `importance`, `source` and an HTTPS `sourceUrl`; `actual` and `forecast` are optional. In production, add each value as a Cloudflare Pages secret/variable, for example `npx wrangler pages secret put FRED_API_KEY --project-name jpti`. Do not place secrets in client-side code or commit them.
