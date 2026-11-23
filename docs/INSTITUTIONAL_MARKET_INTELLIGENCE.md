# Institutional Market Intelligence Engine

The Institutional Market Intelligence workspace is driven from the same exchange, pair and timeframe as its embedded live candlestick chart. Changing any of those chart inputs refreshes the linked liquidity, macro, calendar, news, positioning and volatility context.

## API

- `GET /api/institutional/context/:exchange/:symbol?timeframe=1h` — selected-venue OHLCV, order book, visible depth walls, confirmed swing/equal-level liquidity pools, sweeps, funding/open interest where supported, macro snapshot, calendar, news, earnings mapping and event/dynamic-volatility risk.
- `GET /api/institutional/calendar?symbol=BTC/USDT` — scheduled releases and central-bank communications.
- `GET /api/institutional/news?symbol=BTC/USDT` — GDELT news index results.
- `GET /api/institutional/earnings?symbol=AAPL/USD` — Finnhub earnings calendar for mapped equities when configured.
- `GET /api/institutional/history` — persisted intelligence snapshots.
- `GET /api/institutional/sources` — source status and data limitations.

## Data sources and configuration

- Forex Factory public weekly JSON calendar feed supplies event time, currency, impact and actual/forecast/previous values. It is a third-party feed; verify high-impact events with the issuing central bank or statistical agency. Set `JPTI_FOREX_FACTORY_CALENDAR_URL` to an approved feed endpoint if required.
- Federal Reserve speech and press RSS feeds supply official published communications. These are publication feeds, not a complete future speaker calendar or transcript stance model.
- FRED observations supply effective federal funds rate, CPI, core CPI, PCE, unemployment and payroll series when `JPTI_FRED_API_KEY` is configured.
- GDELT provides news discovery. Article credibility, publication time and original reporting must be checked before trading.
- Finnhub earnings calendar requires `JPTI_FINNHUB_API_KEY` and only applies to mapped listed-company equities. Crypto and FX pairs are not assigned artificial earnings events.
- CCXT supplies selected-exchange OHLCV, ticker, order-book depth, funding and open interest only when the venue and instrument expose those capabilities.

## Event and volatility policy

The risk engine classifies conditions as `NORMAL`, `CAUTION`, `RESTRICTED`, `HALT_NEW_ENTRIES` or `RECOVERY`. High-impact events in the near-event window and severe live volatility expansion can block new entries. ATR expansion, relative volume and bid/ask spread are calculated from the selected venue; thresholds are configurable in code and are starting guardrails, not universal market laws.

Live spot orders are checked against this policy before submission. The default `JPTI_EVENT_RISK_FAIL_CLOSED=true` blocks live orders if the Forex Factory calendar feed is unavailable. Set it to false only after explicitly accepting the calendar data gap. Existing positions are never automatically closed by this engine; protective exits and position management remain separate.

## Liquidity interpretation limits

Swing highs/lows and equal-level clusters are technical liquidity proxies from closed candles. Large visible order-book levels are venue-specific snapshots and may be cancelled, replenished or spoofed. They do not reveal account ownership and cannot prove institutional positioning. FX spot is fragmented; there is no single consolidated public order book.

## Operating behaviour

The institutional panel refreshes on a bounded 45-second cadence while open; calendar data is cached server-side for 60 seconds and pair context for 45 seconds. The embedded live chart keeps its own market refresh. Snapshots are stored through JPTI's existing file or PostgreSQL event store. Provider failures remain visible as unavailable source states rather than fabricated zero values.

## Event reaction research

The context payload includes a descriptive event study for calendar releases that fall inside the loaded OHLCV history. It reports nearest-candle matching, 1/3/6/12-bar close-to-close returns and pre/post candle-range expansion. This is not a causal estimate or a validated trading strategy; simultaneous releases, timestamp precision, revisions, spreads and sample selection affect results.
