# JPTI Signal Intelligence Dashboard

This application is mounted from the main JPTI shell through `src/App.jsx` and lives under `dashboard/app/`.

## Structure

- `DashboardApp.jsx` — dashboard composition and interactive views.
- `engines/signal-engine.js` — completed-candle technical analysis, evidence scoring and trade-level estimates.
- `engines/advanced-intelligence.js` — regime classification, signal collision detection and freshness-aware opportunity ranking.
- `hooks/useSignalIntelligence.js` — same-origin JPTI market-data requests, refresh lifecycle and local signal observation history.
- `styles/signal-dashboard.css` — responsive dashboard and large chart layout.
- `tests/` — deterministic engine tests.

## Data and safety

Market observations are requested through the existing same-origin JPTI API routes. The scanner excludes the forming candle from signal calculations. The score is a normalized heuristic evidence score, not a probability of profit. Entry, stop and target levels are research estimates. This dashboard does not submit orders or authorize execution. Browser history is a local observation cache; it is not represented as server-side D1 archival storage.

## Chart presentation

The existing `LiveCandlestickChart` is reused so exchange support, market selectors, chart overlays, session analysis and chart interactions remain consistent with the rest of JPTI. The signal dashboard gives its candlestick canvas a larger responsive height. There is no volume histogram pane beneath the candlesticks.
