// Signal collision detection across indicators, presets, timeframes, charts, strategies and models.
import { timeframeMs } from './indicators.js';

const ORDER = ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'];
const sign = (d) => (d === 'BUY' || d === 1 || d === 'bullish' ? 1 : d === 'SELL' || d === -1 || d === 'bearish' ? -1 : 0);

/**
 * items: [{ source, symbol, timeframe, direction:'BUY'|'SELL'|'WAIT', candleTs, setupId, chartId, preset,
 *           confirmed, setupDirection }]
 * Critical conflicts are never resolved by comparing scores: the resolution is always "stand-aside".
 */
export function detectCollisions(items) {
  const list = (Array.isArray(items) ? items : []).filter((i) => i && i.symbol);
  const conflicts = [], push = (severity, rule, explanation, involved) => conflicts.push({ severity, rule, explanation, items: involved.map((i) => i.source + ':' + (i.timeframe || '?') + ':' + i.direction) });
  const bySymbol = new Map();
  for (const i of list) (bySymbol.get(i.symbol) || bySymbol.set(i.symbol, []).get(i.symbol)).push(i);   // symbols are isolated
  for (const group of bySymbol.values()) {
    for (let a = 0; a < group.length; a++) for (let b = a + 1; b < group.length; b++) {
      const x = group[a], y = group[b], sx = sign(x.direction), sy = sign(y.direction);
      if (x.setupId && x.setupId === y.setupId && x.direction === y.direction && (x.chartId !== y.chartId || x.source !== y.source)) { push('LOW', 'duplicate', 'Same setup reported by more than one chart/source; counted once.', [x, y]); continue; }
      if (sx && sy && sx !== sy) {
        const sameCandle = x.timeframe === y.timeframe && x.candleTs === y.candleTs;
        if (sameCandle) push(x.confirmed !== false && y.confirmed !== false ? 'CRITICAL' : 'HIGH', 'contradictory-same-candle', 'Opposite signals on the same ' + x.timeframe + ' candle from ' + x.source + ' and ' + y.source + '.', [x, y]);
        else if (x.timeframe !== y.timeframe) {
          const ratio = Math.max(timeframeMs(x.timeframe) || 1, timeframeMs(y.timeframe) || 1) / Math.min(timeframeMs(x.timeframe) || 1, timeframeMs(y.timeframe) || 1);
          push(ratio >= 4 ? 'HIGH' : 'MODERATE', 'timeframe-disagreement', 'Execution timeframe and higher timeframe point opposite ways (' + x.timeframe + ' vs ' + y.timeframe + ').', [x, y]);
        } else push('MODERATE', 'contradictory-recent', 'Opposite signals on the same timeframe in different candles.', [x, y]);
      } else if (sx && sx === sy && x.timeframe === y.timeframe && x.candleTs === y.candleTs && (x.preset !== y.preset || x.source !== y.source) && x.setupId !== y.setupId) push('LOW', 'overlapping-entries', 'Multiple strategies request overlapping entries in the same direction.', [x, y]);
    }
    for (const i of group) if (sign(i.direction) && sign(i.setupDirection) && sign(i.direction) !== sign(i.setupDirection)) push('HIGH', 'setup-direction-conflict', 'Signal direction contradicts the direction of its own setup (e.g. bullish sweep with bearish displacement).', [i]);
  }
  const worst = conflicts.reduce((w, c) => (ORDER.indexOf(c.severity) > ORDER.indexOf(w) ? c.severity : w), 'NONE');
  return { conflicts, worst, resolution: worst === 'CRITICAL' ? 'stand-aside' : worst === 'HIGH' ? 'require-extra-confirmation' : 'proceed-with-caution', blocksSignal: worst === 'CRITICAL' };
}
