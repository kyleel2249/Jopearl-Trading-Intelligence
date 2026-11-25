# Autonomous paper trading, agent succession and live-readiness governance

## Capital and execution boundary
Every newly created research agent starts with an independent **$1.00 virtual account**. The ledger permits fractional simulated quantities so the research fleet can test small-account economics. This does not imply that an exchange accepts a $1 order: exchange minimum notional, quantity precision, margin and fee checks are mandatory during any later live-readiness review.

The paper engine consumes public Bitget market data and writes simulated positions to Cloudflare D1. It has no private Bitget credentials, no exchange order submission method, and no live execution permission. A LIVE_READY label means only that the research gates passed. It is not an API permission, an order switch or an instruction to trade live. Human approval, exchange-specific preflight, key isolation, a small canary, kill switch and monitoring are separate requirements.

## Agent implementation model
The first ten specialists use deterministic, explainable strategy rules over public Bitget data. They are autonomous paper-trading bots, not LLM inference sessions. This keeps signal generation reproducible and auditable. Any later model-assisted research layer must remain advisory and cannot override capital limits, data-freshness gates or the paper/live execution boundary.

## Named roles and responsibilities
- **Atlas — Trend Structure Analyst:** multi-timeframe alignment, continuation and invalidation.
- **Pulse — Momentum Analyst:** acceleration, exhaustion and momentum reversal.
- **Revert — Mean-Reversion Specialist:** range extension and reversion confirmation; rejects runaway trends.
- **Sentinel — Breakout Specialist:** closed-candle range expansion and participation confirmation.
- **Oracle — Volume & Participation Analyst:** relative volume, participation quality and failed breakouts.
- **Hawk — Session & Liquidity Analyst:** session behaviour and thin-liquidity avoidance.
- **Warden — Capital Protection Officer:** risk veto, drawdown, exposure, spread and volatility checks.
- **Fox — Microstructure Analyst:** quote spread and executable-liquidity filter.
- **Weaver — Market Regime Analyst:** trend, range and high-volatility classification.
- **Prime — Multi-Agent Strategy Chair:** combines independent signals and records disagreement.

Each profile has a strategy identifier, role description, independent virtual ledger and access to market replay, public data, fee/slippage modelling, risk analytics, trade forensics and daily reviews. A role does not get permission to alter global risk limits.

## KPI gates for LIVE_READY qualification
All gates must pass on persisted trade records:
- Observed win rate at least 98%.
- At least 200 closed trades and 90 observation days.
- Profit factor at least 1.5 and expectancy at least 0.15R.
- Positive net P&L, maximum drawdown strictly below 5%, Sharpe at least 0.8.
- No recorded risk breaches and no more than five consecutive losses.
- At least 50 forward-validation trades and at least 30 trades in each defined market regime.

The forward-validation phase begins after the initial 150 closed trades. Results are historical measurements, not a claim that future trades will win. The 98% target is intentionally demanding; no strategy can guarantee every trade will be profitable.

## Automatic succession and lifecycle
When an agent passes every gate, its tier changes to **LIVE_READY**. A successor research agent is automatically created from the same strategy lineage with a fresh $1 virtual account. The qualified agent remains in paper/shadow monitoring; live execution remains disabled.

An agent reaching the maximum drawdown is suspended from opening new paper positions. An agent with at least 100 closed trades, negative net P&L, profit factor below 0.8 and negative expectancy is retired. A successor is created after retirement. Retired and suspended records are retained for audit; no history is deleted.

## Capital controls and simulation
Per-trade risk is capped at 0.25% of virtual equity, daily loss at 2%, maximum drawdown at 5%, leverage at 1x and concurrent positions at one per agent. Fleet-wide controls cap total open positions at 10, positions per symbol at 2 and same-direction positions at 6. These concentration limits are checked against the persisted D1 open-position ledger and released as soon as a paper position closes. Paper fills model fees, adverse half-spread and slippage on both entry and exit; quantity sizing includes the full round-trip execution-cost estimate. Closed-candle signals exclude the currently forming candle. Stale ticker data, missing quotes, invalid candles or D1 failure pause new entries.

## Daily performance review
The Cloudflare Worker scans BTC, ETH, SOL, XRP, SOPH, BNB, DOGE, ADA, LINK and SUI USDT perpetual markets each minute and stores a UTC daily review at 00:05. Reviews cover each agent's equity, net P&L, win rate, profit factor, expectancy, drawdown, consecutive losses, forward-validation count, regime coverage, risk breaches, status changes and successor creation. The performance ledger also calculates average win/loss, payoff ratio, expectancy per trade in USD, total fees, best/worst trade, recovery factor and average holding time. Sharpe uses calendar-day returns, including zero-trade days, rather than sampling only days with closed trades. Reviews are retained in D1.

## Important limitations
A high win rate can still lose money if average losses exceed average wins. KPI qualification therefore includes net profit, profit factor, expectancy, drawdown and risk-breach checks. Simulated fills cannot reproduce every queue position, funding payment, partial fill, latency spike or exchange rejection. Live readiness is a research milestone, not a profitability guarantee.
