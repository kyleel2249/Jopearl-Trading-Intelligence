// Preset definitions. Each preset changes real engine behaviour (gates, weights, windows, thresholds).
export const MODEL_VERSION = 'gainz-alpha-1.0.0';

export const BASE = {
  minBars: 60, swingLen: 3, minScore: 0.3, minConfidence: 55, minConfluence: 3,
  requireTrend: false, requireMomentum: false, requireVolume: false, requireSweep: false, requireDisplacement: false, requireHtf: false,
  minRR: 1.5, cooldownBars: 3, expireBars: 12, reclaimWindow: 4, dispWindow: 5, dispBase: 0.5, dispAtrMult: 0.8, volMin: 1.1, minSweepDepthAtr: 0.2,
  stopAtr: 1.5, maxStopAtr: 4, sessions: null, tp3: false, htf: [], maxFalseRate: null, requirePositiveExpectancy: false,
  costs: { spreadPct: 0.0002, slippagePct: 0.0002 },
  weights: { trend: 0.2, momentum: 0.15, volume: 0.08, structure: 0.12, liquidity: 0.2, displacement: 0.15, fvg: 0.05, location: 0.05 }
};

const P = (o) => ({ ...BASE, ...o, costs: { ...BASE.costs, ...(o.costs || {}) }, weights: { ...BASE.weights, ...(o.weights || {}) } });

export const PRESETS = {
  balanced: P({ id: 'balanced', label: 'Balanced', timeframes: null }),
  alpha: P({ id: 'alpha', label: 'Alpha', minScore: 0.4, minConfidence: 65, minConfluence: 4, requireSweep: true, requireDisplacement: true, requireHtf: true, htf: ['1h', '4h'], expireBars: 10, dispBase: 0.55, weights: { liquidity: 0.3, displacement: 0.25, trend: 0.14, momentum: 0.1, volume: 0.07 } }),
  scalp: P({ id: 'scalp', minSweepDepthAtr: 0.12, label: 'Scalp', timeframes: ['1m', '3m', '5m', '15m'], minScore: 0.3, minConfidence: 55, minConfluence: 3, minRR: 1.2, cooldownBars: 2, expireBars: 6, reclaimWindow: 3, dispWindow: 3, stopAtr: 1.0, maxStopAtr: 2.5, costs: { spreadPct: 0.0004, slippagePct: 0.0004 }, htf: ['15m'] }),
  intraday: P({ id: 'intraday', label: 'Intraday', timeframes: ['5m', '15m', '30m', '1h'], minConfidence: 60, requireTrend: true, minRR: 1.8, expireBars: 14, sessions: ['london', 'london-new-york', 'new-york'], htf: ['1h', '4h'], weights: { trend: 0.25 } }),
  swing: P({ id: 'swing', minSweepDepthAtr: 0.3, label: 'Swing', timeframes: ['1h', '4h', '12h', '1d'], minBars: 80, minConfidence: 60, requireTrend: true, requireHtf: true, minRR: 2, cooldownBars: 4, expireBars: 20, stopAtr: 2.5, maxStopAtr: 6, htf: ['1d'], tp3: true, weights: { structure: 0.2, trend: 0.25 } }),
  precision: P({ id: 'precision', label: 'Precision', minScore: 0.5, minConfidence: 75, minConfluence: 5, requireTrend: true, requireMomentum: true, requireVolume: true, requireSweep: true, requireDisplacement: true, minRR: 2, cooldownBars: 6, dispBase: 0.6, expireBars: 8, maxFalseRate: 0.45 }),
  liquidityScalp: P({ id: 'liquidityScalp', label: 'Liquidity Sweep Scalper', timeframes: ['1m','3m','5m','15m'], minScore: 0.43, minConfidence: 68, minConfluence: 4, requireSweep: true, requireDisplacement: true, requireVolume: true, minRR: 1.35, cooldownBars: 3, expireBars: 6, reclaimWindow: 2, dispWindow: 3, stopAtr: 0.9, maxStopAtr: 2, sessions: ['london','london-new-york','new-york'], costs: { spreadPct: 0.0005, slippagePct: 0.0006 }, weights: { liquidity: 0.32, displacement: 0.25, structure: 0.16, volume: 0.1 } }),
  momentumScalp: P({ id: 'momentumScalp', label: 'Momentum Continuation Scalper', timeframes: ['1m','3m','5m'], minScore: 0.46, minConfidence: 70, minConfluence: 4, requireTrend: true, requireMomentum: true, requireVolume: true, requireDisplacement: true, minRR: 1.4, cooldownBars: 4, expireBars: 5, dispBase: 0.65, stopAtr: 1, maxStopAtr: 2.2, costs: { spreadPct: 0.0004, slippagePct: 0.0005 }, weights: { trend: 0.28, momentum: 0.2, displacement: 0.22, volume: 0.12 } }),
  trendDay: P({ id: 'trendDay', label: 'Trend Day Trader', timeframes: ['5m','15m','30m','1h'], minScore: 0.44, minConfidence: 68, minConfluence: 4, requireTrend: true, requireHtf: true, htf: ['1h','4h'], minRR: 1.8, cooldownBars: 5, expireBars: 16, sessions: ['london','london-new-york','new-york'], stopAtr: 1.6, maxStopAtr: 3.5, tp3: true, weights: { trend: 0.28, structure: 0.2, momentum: 0.14, liquidity: 0.18 } }),
  rangeDay: P({ id: 'rangeDay', label: 'Range Rotation Day Trader', timeframes: ['5m','15m','30m','1h'], minScore: 0.44, minConfidence: 66, minConfluence: 4, requireVolume: true, requireSweep: true, minRR: 1.7, cooldownBars: 5, expireBars: 14, sessions: ['london','london-new-york','new-york'], stopAtr: 1.4, maxStopAtr: 3, weights: { liquidity: 0.28, location: 0.2, volume: 0.12, structure: 0.12 } }),
  breakoutDay: P({ id: 'breakoutDay', label: 'Compression Breakout Day Trader', timeframes: ['5m','15m','30m','1h'], minScore: 0.47, minConfidence: 70, minConfluence: 4, requireTrend: true, requireMomentum: true, requireVolume: true, requireDisplacement: true, minRR: 2, cooldownBars: 6, expireBars: 12, dispBase: 0.7, sessions: ['london','london-new-york','new-york'], tp3: true, weights: { trend: 0.22, momentum: 0.18, volume: 0.16, displacement: 0.24 } })
};

export function resolvePreset(id, overrides = {}) {
  const base = PRESETS[String(id || 'balanced').toLowerCase()] || PRESETS.balanced;
  return { ...base, ...overrides, costs: { ...base.costs, ...(overrides.costs || {}) }, weights: { ...base.weights, ...(overrides.weights || {}) } };
}
