# JPTI AI Agent Fleet

## What is included
The AI Agent Command Center adds ten deterministic specialist evaluators: trend, volume participation, visible order-book pressure, derivatives positioning, macro regime, liquidity/volatility risk, liquidity conditions, momentum/reversal, cross-asset context, and event risk.

The council reports each specialist's status, missing evidence, score, confidence, and rationale. It also reports directional disagreement, an explainable challenge, evidence freshness, and a risk veto. Missing values are never filled with fabricated market data.

## Runtime surfaces
- Node API: `GET /api/agents/catalog`, `POST /api/agents/evaluate`, `GET /api/agents/history`, `POST /api/agents/feedback`.
- Cloudflare Pages API: the same routes, using the `JPTI_DB` D1 binding and the existing `JPTI_JOURNAL_TOKEN` / `JPTI_API_TOKEN` private authorization.
- UI: **AI Agent Command Center** in the JPTI navigation. **Trading Bots** currently opens the same control surface while the dedicated strategy runners are integrated in later stages.

## Evidence contract
The evaluator accepts an evidence object with an ISO timestamp and optional fields:
`momentumPct`, `timeframeAlignment` (-1..1), `relativeVolume`, `depthImbalance` (-1..1), `fundingRate`, `openInterestChangePct`, `volatilityPct`, `liquidityUsd`, `correlationBias` (-1..1), `macroBias` (`risk-on` or `risk-off`), `highImpactEvent` (boolean), and `sources`.

Evidence older than the freshness policy is blocked. A required failed/stale source, insufficient directional coverage, or a severe combined risk vote blocks the recommendation. The UI's initial form is operator-supplied evidence; it is not presented as an exchange feed.

## Memory and learning boundary
Evaluations and outcome feedback are append-only events. Feedback is observational: it is available for later performance analysis but does not rewrite strategies, weights, thresholds, or historical evaluations.

## Execution boundary
This agent fleet is research-only. It does not submit orders, reserve balances, alter stops, or authorize paper/live execution. Existing pre-trade, strategy-promotion, governance, and exchange execution controls remain separate gates. Live trading stays locked unless separately configured and explicitly authorized.
