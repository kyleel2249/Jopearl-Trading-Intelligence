# Multi-Agent Debate and Decision Audit

The Opportunity Radar now runs a deterministic specialist debate for every market with validated IMI evidence.

## Specialist roles
- Atlas — EMA structure bias
- Pulse — momentum evidence score
- Oracle — candle-direction volume participation proxy
- Hawk — confirmed recent sweep or range location
- Weaver — volatility regime and trend context
- Fox — visible order-book depth imbalance when the existing market-context response supplies it

Each vote includes its evidence reason, direction, weight and availability. Missing domains are not silently converted into bullish or bearish votes. The debate is attached to the market ranking and shown in the Opportunity Radar.

## Decision policy
- NO_EDGE: insufficient evidence or no weighted directional consensus
- WATCH_ONLY: directional consensus exists but one or more risk vetoes apply, or the fused IMI direction does not agree
- PAPER_REVIEW_CANDIDATE: at least three specialists are available, weighted directional consensus is at least 35%, no configured veto applies, and the debate direction agrees with the IMI directional bias

A paper-review candidate is a research label only. It does not open, approve or submit an order and does not promote an agent to live execution.

## Vetoes
High volatility, unverified participation, multiple evidence conflicts, insufficient specialist coverage, agent disagreement and explicitly stale context can restrict a candidate to watch-only or no-edge.

## Model and data limitations
The specialists are deterministic rule modules, not separate AI models. Most technical evidence shares the same OHLCV feed and is therefore correlated rather than statistically independent. The visible-depth vote is a snapshot, not a persistent order-flow feed. Candle-direction volume is not exchange aggressor delta or CVD. The debate output is not a probability, forecast guarantee or investment instruction.
