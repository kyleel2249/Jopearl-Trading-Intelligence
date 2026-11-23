# JPTI Alpha Signal Engine

## Purpose and operating boundary

The Alpha Signal Engine is a deterministic, paper-first research subsystem. It converts completed OHLCV history plus a separately timestamped public quote into an explainable directional assessment, then applies data-quality and account-risk gates before a paper intent can be created.

It is not a profitability guarantee, calibrated probability model, autonomous LLM council, exchange execution adapter, or live-trading authorization service. Every API route is protected by JPTI's private API authentication policy. All engine and paper-ledger responses explicitly preserve `liveExecutionAuthorized: false`.

## Signal ensemble

The v1.0 ensemble uses five deterministic technical specialists:

| Specialist | Weight | Evidence |
|---|---:|---|
| EMA trend structure | 26% | EMA 9 vs EMA 21 and short EMA slope |
| MACD + RSI momentum | 24% | MACD line vs signal line and RSI 14 confirmation |
| 20-bar breakout | 20% | Close above/below the preceding 20-bar high/low |
| Volume participation | 12% | Volume expansion of at least 1.15x the prior 20-bar average and directional candle |
| Mean-reversion pressure | 18% | 20-bar z-score extreme at or beyond ±1.6 |

Each model emits bullish (+1), bearish (-1), or neutral (0) evidence. The weighted ensemble score is the sum of each model direction multiplied by its weight. A score of at least +0.18 produces BUY; a score of at most -0.18 produces SELL; otherwise the result is NEUTRAL.

The displayed confidence is a heuristic consensus score:

`clamp(50 + |ensembleScore| × 48 + (directionalAgreement - 0.5) × 12, 0, 95)`

It is **not a calibrated probability, win-rate estimate, or expected return**. Model agreement is the proportion of active specialists agreeing with the selected direction. Volatility regime is classified from ATR(14) as a percentage of price.

## Data integrity and reproducibility

- Accepts 80–5,000 candles for supported intervals from 1m through 1w.
- Accepts CCXT OHLCV arrays or normalized OHLCV objects.
- Rejects non-finite values, non-positive prices, invalid OHLC relationships, negative volume, duplicate timestamps and non-chronological data.
- Excludes the currently forming candle; only candles whose open timestamp plus timeframe duration is no later than the evaluation clock are considered completed.
- Blocks a last completed candle older than two timeframe intervals.
- Requires a positive quote timestamped within 15 seconds (with a small 5-second clock-skew allowance).
- Computes SHA-256 fingerprints for candle history, quote observation and canonical configuration. The signal ID is deterministic for the same market, candle set, quote and configuration.
- The signal evidence contains model outputs, indicator values, market regime, input hashes, engine version and an explicit no-lookahead statement.
- Persisted signal and replay events include the normalized candle series and the exact quote/configuration/risk assumptions needed to reproduce the evaluation. Signal fingerprints include the account/risk snapshot as well as market and quote data.
- `GET /api/alpha/history?includeSnapshot=true` and `GET /api/alpha/replays?includeSnapshot=true` recover full stored source snapshots; default responses omit bulky candle arrays while retaining hashes and metrics.

## Trade levels and sizing

- Entry reference: current separately timestamped public quote.
- Stop distance: ATR(14) × configured ATR stop multiple (default 1.5).
- TP1: configured reward multiple (default 1R).
- TP2: configured reward multiple (default 2R).
- Risk budget: account equity × configured risk percentage (default 0.5%).
- Quantity: risk budget divided by stop distance, capped by configured maximum order notional.

The account equity and all exposure market values must use the selected market's quote currency. Each existing exposure must include `symbol`, positive `marketValue`, and matching `currency`. Convert multi-currency exposure values before evaluation. The UI requires an explicit operator confirmation that the exposure inventory is complete; `[]` is appropriate only when the account is confirmed flat.

## Fail-closed eligibility gates

A signal can become paper-intent eligible only when all of the following pass:

1. At least 80 completed candles.
2. Candle history no more than two timeframe intervals stale.
3. Account equity currency equals the market quote currency.
4. Every supplied exposure declares the same quote currency.
5. A positive public quote no older than 15 seconds.
6. Direction is BUY or SELL, not neutral.
7. Heuristic confidence meets the configured minimum (default 66).
8. Active model agreement meets the configured minimum (default 0.60).
9. High-volatility regime is not active under the default policy.
10. ATR stop and both targets are positive and geometrically valid.
11. Existing JPTI pre-trade risk checks pass: equity, daily PnL, quote age, exposure inventory, per-order notional, gross exposure, protective stop, risk budget, daily loss limit and symbol concentration.

A failed check blocks paper eligibility. A paper intent is never an exchange order.

## Historical replay

The replay uses rolling completed-candle signals, enters at the next candle open, simulates long and short positions, applies configurable fees and slippage, prevents overlapping positions, and separates results using a chronological 70/30 entry-candle split.

When stop and target are both touched within the same OHLC candle, stop-loss is conservatively assumed to execute first. The replay reports overall, in-sample and out-of-sample trade count, win rate, profit factor, net PnL, expectancy and realized drawdown.

Limitations: single instrument per replay, fixed cost assumptions, no order-book queue, partial fills, market impact, funding, leverage, margin or liquidation. The out-of-sample segment is not used for parameter selection. Replay is research evidence, not proof of future profitability.

## Paper trade lifecycle

- A persisted signal can create a paper intent only if it was marked eligible and was generated within the previous 60 seconds.
- Paper intents retain signal ID, fingerprint, market, direction, entry, stop, targets, size and confidence.
- The UI can mark open paper positions using current public exchange quotes.
- A fresh quote crossing the stop or TP2 automatically records a simulated close. The monitor applies configurable defaults of 5 bps adverse slippage and 10 bps fees; these are assumptions, not actual fills.
- TP1 is displayed as a planning level but v1.0 does not partially reduce a paper position there.
- Operators may also manually record a paper exit with an observed exit price and fees.
- Open marks record mark price and unrealized PnL; closed trades record realized gross/net PnL and reason.
- Marking is user-triggered from the workspace; it is not a continuously running background monitor when the app is closed.

## Promotion evidence gate

`GET /api/alpha/promotion-readiness?quoteCurrency=USDT` evaluates a single quote-currency cohort and requires:

- At least 30 closed paper trades.
- At least 14 calendar days between the first and last closed trade.
- Profit factor of at least 1.20.
- Positive average net PnL per closed trade.
- Sequential realized drawdown no greater than 10% on a fixed 10,000 quote-currency reference book.
- Complete signal/fingerprint traceability and paper-only permissions.
- A same-currency chronological out-of-sample replay with at least 10 trades, positive net PnL and profit factor of at least 1.10.

Passing makes the system a candidate for independent human governance review only. It does not authorize production deployment, bypass strategy-registry promotion, satisfy all institutional-governance controls, or unlock live trading. Drawdown uses a fixed reference book, not the user's account equity curve.

## API

All routes require the JPTI private API authentication policy.

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/alpha/evaluate` | Evaluate one market signal and persist its evidence |
| POST | `/api/alpha/replay` | Run and persist deterministic historical replay |
| GET | `/api/alpha/history` | Retrieve recent signal evaluations (optional full source snapshots) |
| GET | `/api/alpha/replays` | Retrieve replay reports (optional full source snapshots) |
| POST | `/api/alpha/paper/intent` | Create an eligible paper-only intent |
| POST | `/api/alpha/paper/mark` | Mark a paper position from a fresh quote and simulate stop/TP2 exit |
| POST | `/api/alpha/paper/close` | Manually record a paper exit |
| GET | `/api/alpha/paper/ledger` | Retrieve paper trades, marks and realized metrics |
| GET | `/api/alpha/promotion-readiness?quoteCurrency=USDT` | Evaluate paper-to-governance evidence |

### Example evaluation request

```json
{
  "exchange": "binance",
  "symbol": "BTC/USDT",
  "timeframe": "1h",
  "candles": [[1700000000000, 35000, 35200, 34900, 35100, 120]],
  "quote": { "last": 35105, "timestamp": "2026-11-21T11:00:00.000Z" },
  "account": {
    "equity": 10000,
    "currency": "USDT",
    "dailyPnl": 0,
    "exposures": [
      { "symbol": "ETH/USDT", "marketValue": 500, "currency": "USDT" }
    ]
  },
  "limits": {
    "maxDailyLoss": 250,
    "maxOrderNotional": 2000,
    "maxGrossExposure": 5000,
    "maxRiskPercent": 1,
    "maxSymbolConcentrationPercent": 25,
    "maxQuoteAgeMs": 15000
  },
  "config": {
    "minimumConfidence": 66,
    "minimumAgreement": 0.6,
    "atrStopMultiple": 1.5,
    "targetOneR": 1,
    "targetTwoR": 2,
    "riskPercent": 0.5
  }
}
```

The example candle is illustrative; production evaluation must supply at least 80 completed candles and a quote timestamp that is fresh at request time.

## Test coverage

The Alpha-specific test suite covers candle normalization, deterministic fingerprints, stale quote blocking, quote-currency and exposure inventory failures, reproducible replay, zero-fee handling, promotion evidence thresholds and stop/TP2 paper-exit logic. The repository CI additionally runs all existing tests and the production Vite build.
