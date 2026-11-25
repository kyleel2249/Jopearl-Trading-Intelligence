# Multi-market Opportunity Radar

The Opportunity Radar is a read-only research workspace. It scans a fixed eight-market Bitget/Binance/Bybit/OKX spot watchlist using the existing public exchange candle and market-context routes.

## Ranking model
The score combines directional distance from neutral, trend/momentum/flow agreement, relative-volume participation, the source's heuristic confidence field, volatility-regime penalty, evidence-conflict penalty and visible-depth alignment when the context endpoint supplies it. Missing values are treated as unavailable rather than zero or positive confirmation.

Scores are ordinal research rankings from 0–100. They are not calibrated probabilities, expected returns, or instructions to enter a position. A high-priority label means only that the heuristic score crossed the configured threshold.

## Cross-market correlation
Pairwise Pearson correlations use log returns aligned on exact candle timestamps. At least 20 overlapping returns are required. The output is timeframe-dependent and can change materially across regimes; it is not a stable hedge ratio.

## Data and safety boundaries
- Four concurrent market workers limit request bursts.
- The scanner refreshes every 90 seconds and can be run manually.
- Failed market requests remain visible as data gaps.
- The scanner uses public spot OHLCV and the existing market-context endpoint; it does not infer wallet ownership, spoofing intent or actual aggressor-side delta.
- No private exchange credentials are requested and no order endpoint is called.
- Live execution remains governed by the existing separate authorization and risk controls.

## Limitations
The default universe is intentionally fixed rather than a claim to scan every listed asset. Correlation is descriptive, not predictive. Exchange outages, rate limits, stale candles and mismatched market histories can reduce coverage.