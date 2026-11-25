# Live chart tools

Every candle chart in the app (the dashboard terminal chart and the shared live chart used by Market Intelligence,
Exchange Connectivity and the Alpha Signal Engine) uses one shared tool set. Rules live in pure, unit-tested modules;
`src/useChartTools.js` holds state and data loading; `src/ChartTools.jsx` renders the toolbar and the SVG overlay.

| Module | Responsibility | Tests |
| --- | --- | --- |
| `src/chart-live.js` | Live tick merge, candle countdown, pip size, pip axis | `chart-live.test.js` |
| `src/chart-tools.js` | Measure, risk/reward, ATR, Fibonacci, alerts, drawing validation, storage helpers, replay | `chart-tools.test.js` |
| `src/chart-scale.js` | Linear / log / percent scales, range lock, visible-range volume profile | `chart-scale.test.js` |
| `src/chart-market.js` | Higher-timeframe levels, order-book summary and depth buckets, funding/OI/liquidations | `chart-market.test.js` |
| `src/chart-stream.js` | WebSocket plan and decoder (reuses `api/native-stream-adapters.js`) | `chart-market.test.js` |
| `src/chart-sync.js` | Crosshair link between charts | `chart-market.test.js` |

## Tools
- **Cursor, S/R line, Trend, Fib, Measure, Long, Short, Alert.** Clicks snap to the pip. Esc cancels.
- Drawings are stored by (timestamp, price) per exchange + product + symbol in `localStorage`
  (`jpti.chart.drawings.v2:*`), so they survive zoom, resize, timeframe changes and reloads. Invalid stored data is dropped.
- **Long/Short** place entry, stop and target (stop 1.5 ATR away when enough history exists, otherwise 1%, target 2R).
  Drag the three lines. Pips, R multiple and position size come from the Risk popover (account size, risk %). Sizing is
  hypothetical; no order is placed.
- **Alerts** fire once when the live price crosses the level: in-app toast, optional browser notification and sound.
- **Scale**: Linear (every pip labelled when there is room), Log, or % from the last close. **Lock range** freezes the view.
- **Profile**: volume profile of the visible candles with POC and 70% value area.
- **HTF levels**: open and previous high/low/close of the next timeframe up (loaded from the same OHLCV endpoint).
- **Depth** and spread tag, **Replay** (step/play/seek, 1-10x), **Link** (mirrors the crosshair between charts of the same market).

## Data sources and honest limits
- **Live ticks**: public exchange WebSocket (Binance, Bybit, OKX, Bitget spot; Bitget margin and derivatives via the
  mix ticker channel). If the socket is closed or silent for 8 s the chart falls back to REST polling (4 s) and the
  toolbar says "Polling". The Bitget derivatives channel has not been exercised against the live exchange.
- **Order-book depth, funding, mark, open interest**: full JPTI API only (`/api/advanced/orderbook`, `/api/advanced/derivatives`).
  Cloudflare-edge and browser-direct modes have no depth; the toolbar says so. The spread tag still works there from the
  WebSocket top of book.
- **Liquidations**: markers appear only if the venue's `fetchLiquidations` returns data; otherwise the strip says
  "not provided by venue". The separate Chart Intelligence "Liquidations" layer is a modelled estimate and is labelled as such.
- **Symbol link across charts** is not implemented; only the crosshair is linked.
