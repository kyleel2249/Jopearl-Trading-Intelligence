# Candle Formation Intelligence Engine (CFIE)

CFIE is a deterministic closed-candle OHLCV subsystem integrated into the canonical Chart Intelligence engine. It does not mint BUY/SELL signals; GainzAlpha remains the sole signal authority.

## Capabilities
- Candle DNA: body/range, upper/lower wick ratios, close location, ATR-normalized range, volume ratio and directional pressure estimate.
- Patterns: doji, hammer, shooting star, marubozu, bullish/bearish engulfing, inside/outside bar, morning star and evening star.
- Context: wick rejection, high-volume absorption candidate, range/volume anomaly, pressure score and a heuristic directional-bias gauge.
- Chart layer: historical pattern markers with method/basis provenance and user-controlled visibility.
- Guardrails: closed candles only, no future-bar access, bounded scores, malformed-input rejection and explicit OHLCV-estimate labels.

## Interpretation and limitations
The directional gauge is a rule-based heuristic, not a statistically calibrated probability or guaranteed next-candle forecast. OHLCV cannot reveal true bid/ask aggressor flow, hidden liquidity, iceberg orders or actual absorption. Those require measured trade/order-book feeds. CFIE complements, but never overrides, the canonical GainzAlpha signal and JPTI risk controls.
