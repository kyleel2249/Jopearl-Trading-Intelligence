# JPTI Multi-Asset Intelligence 3.0

## Scope and operating boundary
This release adds six normalised asset-class modules (crypto/perpetual futures, equities, commodities, indices, FX and on-chain/DeFi), four named specialist squads, a shared SMC/liquidity strategy catalogue, event-time ordering, cross-venue net-edge research, adaptive portfolio risk budgeting, strategy lifecycle review and execution-ledger reconciliation.

All agent permissions are `none`. Outputs are research findings or paper candidates. No component in this release submits exchange orders or authorises live execution. Weekend trading is disabled at the policy layer.

## Specialist divisions
- **SCALP STRIKE DIVISION:** Nyx (microstructure), Vega (liquidity sweeps), Cipher (FVG/displacement), Razor (execution costs).
- **INTRADAY TACTICAL DIVISION:** Atlas (multi-timeframe structure), Lyra (sessions/opening range), Kestrel (momentum/VWAP), Morpheus (reversals).
- **CROSS-MARKET INTELLIGENCE DIVISION:** Echo (cross-venue price discovery), Orion (macro/intermarket), Satoshi (on-chain/DeFi), Meridian (equities/indices/commodities).
- **CAPITAL PRESERVATION COMMAND:** Aegis (portfolio risk), Sentinel (data/event safety), Quanta (strategy validation and decay).

## Six market modules and data prerequisites
The crypto module reuses the existing Binance/Bybit/OKX/Bitget market-stream, D1 observations and replay infrastructure. Stocks, commodities, indices, forex and on-chain modules define canonical asset-class contracts and provider capabilities. They remain `provider-required` until a compatible feed is configured and verified. This prevents synthetic or guessed market data from being presented as live.

Provider adapters must implement canonical instruments, venue calendars, event timestamps, sequence/cursor pagination, data-quality flags, OHLCV/quotes and relevant asset-specific features. Additional capabilities include equity corporate actions/fundamentals, commodity inventories/curves/seasonality, index breadth/constituents, FX rates/calendars/currency strength and chain finality/wallet/DEX data. Credentials and data licences are provider-specific; none are invented or embedded.

## Strategy and agent intelligence
The shared catalogue covers SMC market structure (BOS/CHOCH), liquidity sweeps, fair-value gaps, displacement/mitigation, premium/discount, order-flow imbalance, session/opening-range, trend/momentum and cross-market relative value. Evidence is passed explicitly. Missing, stale, unverified or unordered evidence must result in abstention. Strategy labels alone do not create a signal.

The named specialist squad evaluations are deterministic, explainable rule modules. The existing agent fleet, SMC engine, market-regime/risk-gate engine and multi-agent debate engine are invoked as shared components; they do not represent fifteen separately trained foundation models. The existing crypto futures paper scheduler now runs this specialist evaluation after position sizing and requires both the existing independent risk gate and the new multi-asset gate to pass before opening a new paper position. It records specialist assessments and abstains when the live order book, event-time freshness, spread, liquidity, SMC context or portfolio risk inputs are insufficient.

## Autonomous Trading Intelligence 3.0 capabilities
- D1 cursor checkpoint table supports resumable provider backfills. A provider worker must persist a cursor only after a page is durably committed.
- Event-time replay orders events by event timestamp, then sequence, with stable input order as final tie-breaker.
- Cross-venue price comparison subtracts fee, slippage and transfer-cost estimates. It is a research alert, not executable arbitrage; settlement, latency, inventory and borrow constraints need separate validation.
- Strategy lifecycle gates forward sample size, expectancy, profit factor, drawdown, data integrity, decay and risk breaches. Quarantine/requalification requires fresh out-of-sample evidence and human review.
- Adaptive allocator scales risk with drawdown and losing streaks and imposes per-agent and portfolio risk caps.
- Reconciliation compares backtest, paper and actual execution IDs and net PnL. Missing/mismatched records are surfaced, not silently reconciled away.

## API
All endpoints require the configured JPTI private API token and D1 migration 0019:
- `GET /api/multi-asset`: module, squad and persisted-state overview.
- `POST /api/multi-asset` with `action=evaluate`: evaluate and persist timestamped evidence. Client-submitted fixtures are forcibly marked unverified and cannot qualify for a paper candidate. The scheduler derives evidence from its live market and portfolio context rather than accepting these manual fixture values.
- `action=backfill-stream-history`: page retained crypto Durable Object events into D1 with a cursor advanced only after each D1 batch commits.
- `action=backfill-checkpoint`: upsert a provider/asset/symbol cursor after a successful ingest page.
- `action=allocate`: persist a paper risk allocation.
- `action=strategy-review`: record a quarantine/requalification assessment.
- `action=reconcile`: persist three-ledger reconciliation findings.
- `action=replay-order`: stable event-time/sequence ordering for replay batches.

## Important limitations
This release does not silently claim complete instrument coverage. “All pairs” means all instruments supplied by a verified provider catalogue, not an invented finite list. Full production market acquisition for the five provider-required classes depends on selecting and configuring data sources with the required entitlements. Exchange-specific futures contract specifications, equity corporate actions, FX calendars, commodity delivery rules, and chain finality must be supplied by adapters before those instruments can be enabled. The stream-history recovery endpoint pages the existing retained Durable Object log into D1 for Binance, Bybit, OKX and Bitget crypto streams. It cannot fetch exchange history older than the collector's retention window. Provider-specific historical REST backfills and ingest workers for deeper crypto history and the five provider-required non-crypto classes remain an integration step per provider. Replay ordering is implemented; full venue-specific L2 state reconstruction must use the existing sequence-aware stream engine for supported crypto venues and adapter-specific sequencing for other markets.

The weekday scheduler policy prevents weekend paper candidates. Session-open flags must come from the relevant exchange calendar; UTC weekday alone is not a substitute for local exchange hours. Cross-venue arb remains paper research until transfer/settlement and inventory constraints are independently modelled.

## Deployment
1. Apply `migrations/d1/0019_multi_asset_intelligence_3.sql` to the production D1 database.
2. Deploy Pages with the existing workflow.
3. Open **Multi-Asset Intelligence** in the sidebar and provide the existing private JPTI API token to load persisted records.
4. Configure verified data providers and licensed instrument universes before enabling a module for paper evaluation.
5. Keep live execution locked until independent broker/exchange execution testing and explicit operator approval.
