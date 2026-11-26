# Video-derived strategy pack

Version: `video-strategies-1.0.0`

This pack turns the two reviewed video rule sets into deterministic, reproducible JPTI research strategies. Both are paper-only and have no exchange/order-routing dependency.

## 1. XAUUSD MA 44/332 crossover

**Baseline rules**
- Intended chart: 5-minute candles.
- Fast SMA: 44 closed candles; slow SMA: 332 closed candles.
- Long: fast SMA crosses from at/below to above the slow SMA on the latest closed candle.
- Short: fast SMA crosses from at/above to below the slow SMA on the latest closed candle.
- Long stop reference: previous completed day's low. Short stop reference: previous completed day's high.
- A stop-out does not itself create a new signal; a fresh crossover is required.

The engine deliberately does not infer the previous-day levels. The caller must supply verified `previousDayHigh` and `previousDayLow`, sourced from the instrument's completed daily session. It abstains if the stop is on the wrong side of entry. It detects a new crossover, not a continuing MA alignment.

## 2. First Williams Fractal Breakout

**Baseline rules**
- Intended chart: 5-minute candles.
- Default session: 03:00–16:45 America/New_York, with IANA timezone/DST handling.
- Williams fractal: five candles. The center high must exceed the highs of the two candles on each side for an up fractal; center low must be below the lows of the two candles on each side for a down fractal.
- The fractal is only known after the two right-hand candles have closed. A breakout cannot trigger on or before its confirmation candle.
- Use the first confirmed up and first confirmed down fractal in the session.
- Long trigger: a later closed candle closes above the first up-fractal level. Short trigger: a later closed candle closes below the first down-fractal level.
- Stop distance: 0.25 × ATR from a completed daily candle. Target: 6R.
- At most one long and one short entry per local session day. Session-close event at 16:45 New York time instructs the paper simulator to flatten open exposure.

The ATR is passed in with explicit provenance (`dailyAtrSource: 'completed-daily-candle'`); the engine does not calculate ATR from incomplete daily candles. The implementation uses close-confirmed breakouts and a strict timestamp ordering to avoid look-ahead.

## 3. Shared protection and qualification

- Default risk policy is capped at 0.25% of equity per trade; sizing uses stop distance, not leverage.
- Paper allocation is blocked unless daily-loss, drawdown, event-risk, cost, stop-distance, and strategy-qualification gates pass.
- Strategy qualification requires out-of-sample sample size, positive net expectancy, profit factor, drawdown ceiling, verified spread/commission/slippage/swap treatment, walk-forward validation, paper-forward validation, data integrity, random-entry baseline comparison, and parameter-sensitivity testing.
- All outputs explicitly set `liveExecutionAuthorized: false`. Human review remains required.

## 4. Reproducibility protocol

Persist the complete input candle series or immutable dataset reference, venue/instrument, timeframe, timezone, session definition, daily ATR source and value, previous-day levels, strategy version/configuration, fee schedule, spread/slippage assumptions, and output. Replay the same ordered closed-candle input with the same configuration to reproduce the same signals.

Run each baseline separately before evaluating variants:
1. MA 44/332 unchanged.
2. First Williams Fractal Breakout unchanged.
3. MA direction as an optional confirmation filter for fractal entries.
4. Liquidity sweep/FVG as optional confirmation filters.
5. Regime-aware selection as a separate portfolio policy, never as a silent change to either baseline.

Do not tune against the final test period. Use chronological train/validation/test partitions, walk-forward windows, Monte Carlo trade-order resampling, nearby-parameter sensitivity, realistic costs and swap, and paper-forward validation. A high win rate or a video-reported return is a hypothesis until independently reproduced from full trade-level data.

## 5. Known limitations

- The strategy functions produce research signals/events, not broker-ready orders.
- Session handling uses the supplied candle timestamps and the IANA timezone; source timestamps must be correctly normalized.
- Daily ATR and previous-day high/low must be supplied from verified completed sessions.
- The fractal simulator reports entry events and session-close events; the portfolio simulator must handle intrabar stop/target ordering, gaps, partial fills, spread, fees, slippage, swap, and position overlap.
- The six-R target is a requested target, not a claim that trades reach it. Actual exits and realized R must be measured.
- The video performance claims are not validated by this code.
