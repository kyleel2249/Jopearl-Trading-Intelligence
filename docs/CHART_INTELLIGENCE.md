# JPTI Chart Intelligence

One closed-candle analysis (`src/chart-intelligence/engine.js`) feeds every live chart, so all charts show the same levels and signals.

## Principles
- **One signal source.** BUY/SELL come from the GainzAlpha engine. This layer never mints a competing signal; it adds levels, a graded confluence score, conflict detection and the trade plan.
- **No repainting.** Only closed candles are analysed. Swing-based items are confirmed before they are drawn; sweeps use only swings confirmed before the bar being judged. Signals are frozen in a ledger on first computation (`createStorageLedger`).
- **No look-ahead.** Backtest/replay use `walkForwardSignals` / `analyzeAt`. Test `no look-ahead leakage` asserts ~0R expectancy on driftless random walks.
- **Traceable.** Every item has `source { module, method, basis, inputs }`; hover a level for its tooltip, or open **Details** for the data basis per layer.
- **Honest data basis.** `ohlcv` / `ohlcv-distributed` = computed from candles. `ohlcv-estimate` (order flow) and `estimated-model` (liquidation) are modelled, labelled "est." in the UI. `measured-aggressor` / `measured-feed` are used automatically when real per-candle aggressor volume (`flow`) or a liquidation feed (`liquidationFeed`) is supplied.

## Layers
| Layer | Contents | Method |
|---|---|---|
| signals | BUY/SELL arrows, confidence, outcome | Gainz engine + ledger |
| plan | entry zone, ENTRY, SL, TP1..n (RR), trailing stop, invalidation | Gainz risk plan + level-derived targets; chandelier trail (2.5 ATR, armed at +1R, only tightens) |
| profile | POC (composite/session/daily/developing/anchored), VAH/VAL, PDH/PDL, day range, opening range and visible 64-bin distribution | Candle volume spread over its high–low bins; 70% value area |
| volumeNodes | HVN / LVN local nodes | Local maxima/minima ranked against the 25th/75th volume quantiles |
| smc additions | Displacement and bullish/bearish OTE zones | Closed impulse body, close location, relative volume; 62–79% dealing-range retracement zones |
| vwap | session VWAP ±1σ, anchored VWAPs | Volume-weighted typical price |
| sr | multi-strength zones | Clustered swings (0.35 ATR); strength from touches, measured hold-rate, recency |
| structure | BOS, CHoCH, MSS (CHoCH with ≥1 ATR displacement) | Close beyond confirmed swing |
| orderBlocks | OB, breaker, mitigation block | Last opposite candle before a structure break; status from later price action |
| fvg | FVG, IFVG | 3-candle imbalance; IFVG = closed through |
| liquidity / sweeps | equal highs/lows, internal/external pools, magnets, sweeps | Pools from confirmed swings; sweep = wick beyond pool, close back |
| smc | premium/discount/EQ, inducement | Dealing range from last major swings |
| orderflow | delta, imbalance, absorption, exhaustion, divergence | Close-location estimate (or measured) |
| liquidation | long/short clusters, heatmap, cascade risk | Isolated-margin maths `P(1−1/L+mmr)` on likely entries; levels already traded through are removed |

## Intelligence
Regime (efficiency ratio + ATR vs own median) → adaptive minimum score and weights; MTF bias from fetched higher timeframes; confluence score from 8 traceable components; level strength shrunk toward measured reaction rate; conflict detection (confluence, MTF, flow, location, Alpha Signal Engine levels); grade A+…D (confluence quality, **not** a win probability); expectancy from recorded outcomes; severe conflicts withhold the plan and show `CONFLICT`.

## Live candlestick integration
`TerminalChart.jsx` now consumes `useChartIntelligence` directly. The same closed-candle result drives on-chart BOS/CHoCH/MSS, order blocks, breakers, FVG/IFVG, liquidity pools and sweeps, premium/discount and OTE zones, volume-profile histogram/POC/VAH/VAL, HVN/LVN, VWAP, Alpha signal markers, trade-plan entry/stop/targets, order-flow markers and liquidation clusters. Each layer has an independent visibility control. The chart panel reports regime, confluence, grade, MTF freshness, evidence count and whether order-flow/liquidation inputs are estimated.

## Integration
- `toChartEvidence(result)` — evidence for Alpha, scanner and risk consumers.
- `analyzeAt(candles, i, opts)` — replay as displayed after bar *i*.
- `runChartIntelligenceBacktest(candles, opts)` — walk-forward evaluation.
- Legacy FVG/OB/structure/sweep/VWAP drawings and Gainz risk/signal overlays are suppressed while this layer is active, so nothing is drawn twice.

## Limits
Order flow and liquidation are estimates unless a measured feed is wired in. Signals are research output and never authorise orders.

## Android
The existing `.github/workflows/mobile-android.yml` builds a debug APK on pushes to `main` that touch `src/**`, `api/**`, etc. An upgraded version (validates first, Gradle cache, concurrency, versioned APK name, rolling `android-latest` GitHub Release) is provided at `docs/ci/mobile-android.release.yml`; the integration token cannot write to `.github/workflows`, so install it with:

    git mv docs/ci/mobile-android.release.yml .github/workflows/mobile-android.yml

Debug-signed; a release-signed build needs a keystore secret.
