// Order-flow analytics. With only OHLCV, buy/sell split is an ESTIMATE (close-location model) and every item says so.
// When per-candle measured aggressor volume is supplied (flow = [{ts, buyVolume, sellVolume}]), the measured basis is used.
import { clamp, atrSeries, relativeVolume } from '../gainz-alpha/indicators.js';

const r4 = (v) => (Number.isFinite(v) ? Number(v.toFixed(4)) : null);
const src = (method, basis, inputs = {}) => ({ module: 'chart-intelligence/orderflow', method, basis, inputs });

export function candleDelta(rows, flow = null) {
  const byTs = new Map((flow || []).map((f) => [f.ts, f]));
  const measured = rows.length > 0 && rows.every((c) => byTs.has(c[0]));
  const basis = measured ? 'measured-aggressor' : 'ohlcv-estimate';
  const bars = rows.map((c) => {
    let buy, sell;
    if (measured) { const f = byTs.get(c[0]); buy = f.buyVolume; sell = f.sellVolume; }
    else { const range = c[2] - c[3]; const clv = range > 0 ? (c[4] - c[3]) / range : 0.5; buy = c[5] * clv; sell = c[5] - buy; }
    return { ts: c[0], buy, sell, delta: buy - sell, ratio: sell > 0 ? buy / sell : buy > 0 ? Infinity : 1 };
  });
  let cum = 0;
  bars.forEach((b) => { cum += b.delta; b.cumDelta = cum; });
  return { bars, basis };
}

export function analyzeOrderFlow(rows, { flow = null, window = 20 } = {}) {
  const empty = { status: 'insufficient', basis: null, items: [], summary: null };
  if (rows.length < window + 5) return empty;
  const atrS = atrSeries(rows, 14), { bars, basis } = candleDelta(rows, flow), last = rows.length - 1;
  const items = [], s = (m, inputs) => src(m, basis, inputs);
  const push = (kind, i, price, direction, label, strength, method, inputs) => items.push({ id: [kind, rows[i][0]].join('|'), layer: 'orderflow', kind, direction, ts: rows[i][0], price: r4(price), label, strength: r4(strength), source: s(method, inputs) });
  const lookback = Math.max(8, rows.length - 160);
  for (let i = lookback; i <= last; i++) {
    const c = rows[i], a = atrS[i]; if (!a) continue;
    const rv = relativeVolume(rows.slice(0, i + 1)), body = Math.abs(c[4] - c[1]), range = c[2] - c[3] || 1e-12;
    const upW = c[2] - Math.max(c[1], c[4]), loW = Math.min(c[1], c[4]) - c[3];
    // Absorption: heavy volume, small body, long rejection wick, close away from the pressured side.
    if (rv != null && rv >= 1.6 && body / range <= 0.35) {
      if (loW / range >= 0.45 && c[4] >= c[3] + range * 0.55) push('ABSORPTION', i, c[3], 'bullish', 'Absorption ▲', clamp(rv / 3, 0.3, 1), 'high-volume-small-body-lower-rejection', { relVolume: r4(rv), bodyToRange: r4(body / range) });
      else if (upW / range >= 0.45 && c[4] <= c[3] + range * 0.45) push('ABSORPTION', i, c[2], 'bearish', 'Absorption ▼', clamp(rv / 3, 0.3, 1), 'high-volume-small-body-upper-rejection', { relVolume: r4(rv), bodyToRange: r4(body / range) });
    }
    // Exhaustion: climactic volume with a long wick at a fresh 20-bar extreme.
    if (rv != null && rv >= 2.2 && i >= 20) {
      const prior = rows.slice(i - 20, i);
      if (c[2] > Math.max(...prior.map((x) => x[2])) && upW / range >= 0.4) push('EXHAUSTION', i, c[2], 'bearish', 'Exhaustion ▼', clamp(rv / 4, 0.3, 1), 'climax-volume-upper-wick-at-high', { relVolume: r4(rv) });
      if (c[3] < Math.min(...prior.map((x) => x[3])) && loW / range >= 0.4) push('EXHAUSTION', i, c[3], 'bullish', 'Exhaustion ▲', clamp(rv / 4, 0.3, 1), 'climax-volume-lower-wick-at-low', { relVolume: r4(rv) });
    }
    // Stacked imbalance: 3 consecutive bars with the same aggressive side ≥ 2:1 (or ≤ 1:2).
    if (i >= 2) {
      const t = bars.slice(i - 2, i + 1);
      if (t.every((b) => b.ratio >= 2)) push('IMBALANCE', i, c[4], 'bullish', 'Buy imbalance', clamp(t[2].ratio / 5, 0.3, 1), 'stacked-3-bar-buy-ratio', { minRatio: r4(Math.min(...t.map((b) => b.ratio))) });
      if (t.every((b) => b.ratio <= 0.5)) push('IMBALANCE', i, c[4], 'bearish', 'Sell imbalance', clamp((1 / Math.max(t[2].ratio, 0.01)) / 5, 0.3, 1), 'stacked-3-bar-sell-ratio', { maxRatio: r4(Math.max(...t.map((b) => b.ratio))) });
    }
    // Delta divergence: price makes a new 10-bar extreme while cumulative delta fails to confirm.
    if (i >= 12) {
      const w = rows.slice(i - 10, i), wb = bars.slice(i - 10, i);
      if (c[2] > Math.max(...w.map((x) => x[2])) && bars[i].cumDelta < Math.max(...wb.map((b) => b.cumDelta))) push('DELTA_DIVERGENCE', i, c[2], 'bearish', 'Δ div ▼', 0.6, 'new-high-without-cumulative-delta-high', {});
      if (c[3] < Math.min(...w.map((x) => x[3])) && bars[i].cumDelta > Math.min(...wb.map((b) => b.cumDelta))) push('DELTA_DIVERGENCE', i, c[3], 'bullish', 'Δ div ▲', 0.6, 'new-low-without-cumulative-delta-low', {});
    }
  }
  const recent = bars.slice(-window), buy = recent.reduce((x, b) => x + b.buy, 0), sell = recent.reduce((x, b) => x + b.sell, 0);
  const pressure = buy + sell > 0 ? (buy - sell) / (buy + sell) : 0;
  const lastDelta = bars[last];
  return { status: 'ready', basis, items, summary: { pressure: r4(pressure), window, buyVolume: r4(buy), sellVolume: r4(sell), delta: r4(lastDelta.delta), cumDelta: r4(lastDelta.cumDelta), bias: pressure > 0.12 ? 'buying' : pressure < -0.12 ? 'selling' : 'balanced', basisNote: basis === 'measured-aggressor' ? 'Measured aggressor volume' : 'Estimated from OHLCV close location — not tick data' }, series: bars.slice(-120).map((b) => ({ ts: b.ts, delta: r4(b.delta), cumDelta: r4(b.cumDelta) })) };
}
