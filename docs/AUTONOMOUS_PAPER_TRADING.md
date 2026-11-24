# Autonomous paper trading and KPI governance

The paper fleet consumes public Bitget market data and writes simulated positions to Cloudflare D1. The paper path has no Bitget private credentials, no exchange order submission method, and no live execution permission.

## Promotion policy
98% win rate is a strict target, never a forecast or promise. Promotion requires at least 200 closed trades, 90 observation days, 50 out-of-sample trades, 30 trades in each observed regime, profit factor >= 1.5, expectancy >= 0.15R, Sharpe >= 0.8 and maximum drawdown <= 5%. Missing evidence fails closed. A strategy cannot promote on win rate alone.

## Capital controls
Each research agent starts with a separate $10,000 virtual ledger. Per-trade risk is capped at 0.25% of virtual equity, daily loss at 2%, maximum portfolio drawdown at 5%, leverage at 1x and concurrent open positions at three. Fill simulation includes maker/taker fee assumptions, spread and slippage. These are conservative estimates, not guaranteed fills.

## Daily review
Daily review snapshots closed-trade metrics, risk breaches, market-regime coverage, data freshness and KPI gate status. Review rows are unique per UTC date. The UI can request a review. A dedicated Cloudflare Worker runs the watchlist every minute and records a UTC daily review at 00:05. GitHub Actions deploys that Worker after the Pages deployment and D1 migration complete successfully. Agents are promoted during a cycle or daily review only after all KPI gates pass.

## Data integrity
Signals use closed candles only. Current incomplete candle is excluded. Market feed failure, insufficient history, invalid prices, stale quotes or missing D1 prevent new entries. Paper trades are labeled and stored separately from the real portfolio ledger.
