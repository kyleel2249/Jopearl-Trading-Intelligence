export function detectSignalCollisions(signals = []) {
  const bySymbol = new Map();
  signals.filter((signal) => signal && signal.direction !== 'neutral' && signal.score != null).forEach((signal) => {
    const rows = bySymbol.get(signal.symbol) || [];
    rows.push(signal); bySymbol.set(signal.symbol, rows);
  });
  return [...bySymbol.entries()].flatMap(([symbol, rows]) => {
    const directions = new Set(rows.map((row) => row.direction));
    return directions.size > 1 ? [{ symbol, severity: 'high', type: 'direction-conflict', signals: rows.map((row) => ({ timeframe: row.timeframe, direction: row.direction, score: row.score })), message: 'Opposing directional signals exist for the same instrument.' }] : [];
  });
}

export function classifyMarketRegime(signals = []) {
  const usable = signals.filter((item) => Number.isFinite(Number(item.change20Percent)) && item.score != null);
  if (usable.length < 2) return { regime: 'insufficient-sample', breadth: null, dispersion: null, observations: usable.length };
  const breadth = usable.filter((item) => item.change20Percent > 0).length / usable.length;
  const returns = usable.map((item) => Number(item.change20Percent)).sort((a, b) => a - b);
  const median = returns[Math.floor(returns.length / 2)];
  const dispersion = returns.length > 1 ? Math.sqrt(returns.reduce((sum, value) => sum + (value - median) ** 2, 0) / returns.length) : 0;
  const regime = breadth >= 0.7 && median > 0.2 ? 'bullish-trend' : breadth <= 0.3 && median < -0.2 ? 'bearish-trend' : dispersion > 2.5 ? 'high-dispersion' : 'mixed-range';
  return { regime, breadth: Number((breadth * 100).toFixed(1)), dispersion: Number(dispersion.toFixed(3)), medianReturn20: Number(median.toFixed(3)), observations: usable.length };
}

export function rankOpportunities(signals = [], now = Date.now()) {
  return signals.filter((signal) => signal.status !== 'no-trade' && signal.score != null).map((signal) => {
    const ageMs = Math.max(0, now - Number(signal.generatedAt ? Date.parse(signal.generatedAt) : now));
    const timeframeMs = ({ '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 })[signal.timeframe] || 3600000;
    const freshness = Math.max(0, 1 - ageMs / (timeframeMs * 2));
    return { ...signal, freshness: Number(freshness.toFixed(3)), rankingScore: Number((signal.score * (0.7 + 0.3 * freshness)).toFixed(2)), stale: freshness === 0 };
  }).sort((a, b) => b.rankingScore - a.rankingScore);
}
