# Terminal dashboard (Overview)

The Overview page is a full-bleed trading terminal: sessions strip, market intelligence, macro, calendar,
live chart with session / liquidity / SMC overlays, session analytics, volatility risk, trading controls,
insights, earnings, news and performance. The previous overview (provider consensus, cross-exchange
scanner, provider list) is preserved under **Classic overview, provider consensus & scanners**.

## Data sources (nothing is invented)
| Panel | Source |
|---|---|
| Quote, candles | `/api/exchanges/:id/ticker`, `/ohlcv` |
| Liquidity pools, imbalance, funding, OI, event risk, macro, news | `/api/institutional/context/:exchange/:symbol` |
| Economic calendar, speakers | `/api/institutional/calendar` |
| Earnings | `/api/institutional/earnings` (needs `JPTI_FINNHUB_API_KEY`) |
| Macro values | FRED (needs `JPTI_FRED_API_KEY`) |
| Performance | `/api/session/memory` (journaled outcomes, R-multiples) |
| Buy / Sell | `/api/risk/preflight` only - never creates an order |

Unavailable data renders as `—` or an explanatory note. Session windows are DST-aware and shown in UTC.
Liquidity naming follows the standard convention: buy-side liquidity rests above highs, sell-side below lows.

## Android
`.github/workflows/mobile-android.yml` builds the debug APK on every push to `main`.
