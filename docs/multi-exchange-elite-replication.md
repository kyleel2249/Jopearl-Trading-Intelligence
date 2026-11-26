# JPTI Multi-Exchange Elite Replication System

## Scope

This subsystem extends the existing Bitget Elite Trader Replication Division without removing or replacing it. It adds independent Bybit and Binance divisions and a shared cross-exchange intelligence layer.

Supported venue/market buckets are Bitget Spot, USDT Perpetual, Coin-M Perpetual and USDC Perpetual; Bybit Spot and USDT Perpetual; Binance Spot, USDT Perpetual and Coin-M Perpetual. The engine rejects unsupported venue/market combinations.

## Implemented capabilities

- 24 specialist agents: 12 cross-exchange agents and four venue specialists for each of Bitget, Bybit and Binance.
- Shared 100-point scoring model based on win-rate consistency, risk-adjusted returns, drawdown control, net profitability, period consistency, execution quality, history and sample size.
- Source freshness, operator attestation, 100-trade, 90-day history, positive 90-day ROI, <=25% drawdown, minimum three real rolling-window records and metric-range hard gates.
- Separate exchange and market-type leaderboards, plus a normalized research comparison across exchanges.
- Copier PnL is optional because provider disclosure differs by exchange and product.
- Duplicate trader identity removal within an exchange and market bucket.
- Strategy DNA fingerprints and clusters.
- Optional supplied position snapshots for cross-venue same-direction duplicate exposure and opposing-direction collision detection.
- A virtual score-weighted inverse-drawdown allocation simulation, with a 10% per-trader cap, explicit cash reserve and zero real capital allocation.
- Deterministic findings from all 24 specialist agents, including explicit waiting states where live quote/funding or execution-quality evidence is unavailable.
- Risk flags for leverage, drawdown, high slippage, funding costs, concentrated exposure and recovery-style trading.
- Durable D1 ranking snapshots, Shared Intelligence Memory event envelopes and Risk Command Centre review event envelopes.
- Paper-only replica selection with zero capital allocation and no order endpoint.

## Data-source truth and limitations

This release deliberately uses import-only ingestion. Official exchange copy-trading product APIs, private account endpoints and public trader leaderboard/profile data are different capabilities. A public market-data endpoint does not grant access to private lead-trader fills or copier execution.

The UI reports each venue's feed as not configured until an approved feed endpoint is supplied. No feed URL is fetched by this version; the status variable is a readiness marker only. Candidate records must be imported from an approved official export or an independently reviewed provider adapter. Do not label a trader as independently verified because sourceAttested is true: that flag records an operator attestation only.

Metric methodology can differ between venues. Cross-exchange scores are normalized research heuristics, not an assertion that provider ROI, drawdown or win-rate calculations are perfectly comparable. Each venue and market type retains its own leaderboard.

## API

- GET /api/multi-exchange-elite — public system status, supported venue/market types, policy and agent roster.
- POST /api/multi-exchange-elite — private candidate assessment and ranking.
- GET /api/multi-exchange-elite?limit=20 — private D1 ranking history.

Authenticate using x-jpti-api-token or Authorization: Bearer with the existing JPTI private token. POST accepts a JSON object with a candidates array, maximum 300 candidates and 1 MB request limit.

Each candidate requires exchange, marketType, traderId, source, retrievedAt, sourceAttested, totalTrades, historyDays and real windows data. Required window metrics are ROI, win rate and maximum drawdown for 7d, 30d, 90d and 180d; at least three complete ROI windows are required for eligibility. 90d Sharpe/Sortino/profit factor and execution/funding/position data improve analysis but are not mandatory. Copier PnL is optional.

## D1 event integration

Each successful run writes three event records into the existing jpti_events table:
1. multi-exchange-elite-ranking — complete ranking snapshot.
2. shared-intelligence-memory-event — compact selected trader and strategy identity envelope.
3. risk-command-centre-event — cross-venue collisions, risk flags, failed eligibility gates, virtual allocation targets and agent findings.

These records are published to the shared event store. A downstream consumer or scheduled process must still subscribe/query them before claiming autonomous agent-to-agent action.

## Automation and live trading

Automatic leaderboard refresh is not enabled. Cloudflare Cron triggers, official feed adapters, provider schema reconciliation, alert delivery, source-health monitoring and dead-letter/retry handling are future integration requirements. A configured environment URL alone is not evidence that a feed works.

Live trading remains disabled. Before a separate live-execution release, implement least-privilege exchange permissions, secret rotation, fixed-IP restrictions where supported, order idempotency, position/balance reconciliation, per-trader and portfolio caps, max daily loss, drawdown circuit breakers, stale-feed rejection, order/fill audit trails, kill switch and explicit operator authorization. Trader ranking must never grant execution permission.
