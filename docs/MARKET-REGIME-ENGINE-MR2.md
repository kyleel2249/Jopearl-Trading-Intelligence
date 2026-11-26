# JPTI Market Regime Engine MR-2.0

MR-2.0 replaces the former efficiency-ratio/ATR label with a multi-factor closed-candle regime ensemble.

## Measurements
- Kaufman efficiency ratio at 10/20/30 bars, ADX, ATR-normalised regression slope, EMA 20/50/100 alignment and directional persistence.
- ATR percentile and ratio, realised volatility ratio, average range in ATR, Bollinger bandwidth percentile, choppiness and relative volume.
- Normalised scores for trend-up, trend-down, range, high volatility and compression; transitional state when evidence is ambiguous.
- Confidence, runner-up state, entropy/ambiguity transition risk, regime age and persistence.
- Higher-timeframe regime states, coverage, directional bias and agreement.
- Regime-specific confluence weights, score threshold, risk and position-size multipliers, extra-confirmation flag, compression breakout watch and playbook.

## Integration
The existing detectRegime API remains as a compatibility adapter. Chart Intelligence uses MR-2.0 before confluence scoring, applies its adaptive configuration and exposes the complete regime object through structured Alpha/scanner evidence. The chart intelligence details panel displays the probability distribution, measurements, higher-timeframe agreement and adaptive controls. GainzAlpha remains the sole BUY/SELL signal authority.

## Guardrails
Only validated closed OHLCV bars are used. No future bars or unmeasured tick/order-book facts are inferred. Normalised regime scores are model confidence scores, not empirically calibrated outcome probabilities. Position-size and risk multipliers are advisory metadata; existing JPTI risk controls remain authoritative.
