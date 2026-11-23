# Phase 11 — Universal Futures Cross-Exchange Intelligence Engine

## Scope and operating mode
Phase 11 introduces all-market crypto derivatives discovery across the CCXT exchange catalog, with real-time public market intelligence and paper-trading research as the initial operating mode. The architecture is venue-capability-driven: a catalog entry is not a promise that every venue lists every contract. It does not enable live futures order submission.

## Market discovery and contract identity
- Enumerate CCXT exchanges and their public capabilities.
- Resolve derivative contracts by base, quote, settlement currency, perpetual/dated type, linear/inverse structure and contract metadata.
- Never compare spot, dated futures and perpetual swaps as if they were identical instruments.
- Use exchange-native contract symbols and preserve contract size, settlement and precision metadata.

## Price and microstructure data
Per venue, retrieve ticker last, bid, ask, mark and index where exposed; order-book depth; funding rate, funding interval and next funding timestamp where supported. Missing fields are null/unavailable, never inferred from another price field. All observations include venue and timestamps. REST polling is bounded and cached; future streaming adapters should use exchange WebSockets with per-venue reconnect/backoff and sequence-gap detection.

## Cross-venue intelligence
- Compare only compatible contract identities.
- Compute median last/mark/index references and venue dispersion.
- Calculate buy-at-ask / sell-at-bid opportunities, with depth-weighted average prices when requested size is supplied.
- Deduct configurable estimated taker fees on both legs. Report fees as estimates until authenticated account-specific fee tiers are available.
- Show funding separately; do not add funding to net spread unless both payment timestamps, holding period and position eligibility are modeled.
- Label opportunities as top-of-book-only, depth-checked-estimate or insufficient-depth. Do not claim guaranteed arbitrage.

## Paper research and T-Bots feedback
Paper experiments must simulate both legs, asynchronous fills, partial fills, latency, fees, funding payment eligibility, margin, contract multiplier, liquidation buffer and hedge mismatch. Persist each leg separately and aggregate the pair only when both leg states are reconciled. Unhedged exposure, stale feeds, exchange disconnects, contract mismatch or risk-control failure blocks new simulated entries. Existing exit/hedge-reduction logic remains available.

## API
- GET /api/futures/catalog
- GET /api/futures/compare?symbol=BTC/USDT:USDT&kind=perpetual&exchanges=binance,bybit,okx,bitget&depth=20&amount=0.01
- GET /api/futures/funding?symbol=BTC/USDT:USDT&exchanges=binance,bybit,okx,bitget

## Safety boundary
- Initial mode is public real-time intelligence plus paper research.
- No new live futures order route, API trade permission, withdrawal permission or exchange credential is required for public market data.
- Automated live execution is a later, separately reviewed capability. It must have explicit per-venue authorization, account-specific fee/margin models, order-state reconciliation, two-leg exposure controls, durable audit logs and an independent kill switch.
- A positive cross-venue edge is not sufficient to trade. Stale data, low depth, excessive latency, unavailable funding, market status ambiguity, incompatible contract specs or uncertain fee tiers must invalidate the candidate.

## Validation
Unit tests cover net spread math, depth-aware pricing, separation of last/mark/index, and insufficient-depth labelling. Full CI must additionally validate Node syntax, root test suite, production build, Windows packaging and Android build.
