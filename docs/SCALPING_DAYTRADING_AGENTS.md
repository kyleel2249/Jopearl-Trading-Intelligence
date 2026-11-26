# Scalping and Day-Trading Specialist Desks

## Architecture

The canonical Chart Intelligence engine invokes `evaluateTradingDeskAgents` after GainzAlpha signal, regime, confluence, conflict, MTF, SMC, flow and trade-plan analysis. The module is pure and deterministic. It consumes closed-candle evidence and returns two independent profiles:

- **Scalping Desk:** 1m, 3m, 5m and 15m; requires a confirmed signal, a nearby sweep or linked FVG, a minimum 1.25R first target, configured costs and tight regime/volatility gates.
- **Day-Trading Desk:** 5m, 15m, 30m and 1h; requires a confirmed signal, fresh higher-timeframe alignment, a minimum 1.6R first target and configured costs.

Each desk has eight specialist roles: Structure & SMC, Liquidity & FVG, Momentum & Displacement, Market Regime, Multi-Timeframe, Order Flow, Execution Quality and Independent Capital Protection. Every role reports a score or abstention, vote, mandate and reason. The desk reports consensus, evidence, hard blockers and a fixed risk policy.

## Authority and safety

GainzAlpha is the sole BUY/SELL signal authority. Desk output is research/paper-review qualification only. No agent in this module can place an exchange order, change risk limits, or bypass the existing pre-trade gate. The desk's 0.25% per-trade risk cap, 1.5% daily loss stop, 1x leverage ceiling, correlated-position cap and consecutive-loss stop are policy outputs for the existing risk/execution layer; they do not replace server-side enforcement.

A profile is blocked if the signal or plan is absent, the timeframe is unsupported, spread/slippage assumptions are missing, first-target R:R is below its minimum, confidence/confluence is insufficient, severe conflict or event risk is active, or its required structure/MTF evidence is missing. Unknown evidence abstains rather than being treated as positive.

## Chart markings

The shared live candlestick component renders the same analysis in single-chart and multi-chart workstations. Liquidity levels receive narrow ATR-scaled bands; FVG/order-block areas remain native zones; the engine's entry zone remains distinct; and TP1/TP2/TP3 each receive a narrow target band and labeled target line. Stop-loss, invalidation and trailing-stop levels remain visible. Band widths are visual guides only and do not imply guaranteed execution.

## Validation

Run `npm run verify:trading-desk` for specialist roster, positive paper-review qualification, severe-conflict veto, missing-signal veto and MTF abstention checks. The standard CI `npm test` command includes this suite.
