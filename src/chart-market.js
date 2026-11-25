/**
 * Pure helpers that turn exchange data into chart annotations: higher-timeframe levels, order-book depth and
 * spread, and futures funding / open interest / liquidation context. Nothing is estimated or invented: when a
 * venue does not supply a figure the field is null and the UI says it is unavailable.
 */
import { candleCloseAt } from './chart-live.js';

const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/* ---------- higher timeframe ---------- */

export const HTF_MAP = { '1m': '15m', '3m': '15m', '5m': '1h', '15m': '1h', '30m': '4h', '1h': '4h', '2h': '1d', '4h': '1d', '6h': '1d', '8h': '1d', '12h': '1d', '1d': '1w', '3d': '1w', '1w': '1M' };
export const higherTimeframe = (tf) => HTF_MAP[tf] || null;

/**
 * Levels from the next timeframe up: the forming candle's open/high/low and the previous candle's high/low/close.
 * If the newest candle has already closed it is treated as the previous one and there is no forming candle.
 */
export function htfLevels(candles, htf, now = Date.now()) {
  const rows = (candles || []).filter((c) => Array.isArray(c) && c.length >= 5 && c.slice(0, 5).every((v) => Number.isFinite(Number(v)))).map((c) => c.slice(0, 6).map(Number));
  if (rows.length < 2) return null;
  const last = rows.at(-1), close = candleCloseAt(last[0], htf);
  const forming = close !== null && now < close && now >= last[0];
  const prev = forming ? rows.at(-2) : last;
  const levels = [
    { id: 'pH', label: 'Prev High', price: prev[2], kind: 'prev' },
    { id: 'pL', label: 'Prev Low', price: prev[3], kind: 'prev' },
    { id: 'pC', label: 'Prev Close', price: prev[4], kind: 'prev' }
  ];
  if (forming) levels.unshift({ id: 'fO', label: 'Open', price: last[1], kind: 'open' });
  return { timeframe: htf, forming, levels, formingCandle: forming ? last : null };
}

/* ---------- order book ---------- */

const cleanSide = (levels) => (Array.isArray(levels) ? levels : []).map((l) => [Number(l[0]), Number(l[1])]).filter(([p, s]) => p > 0 && s > 0);

export function summarizeBook(book, { pip } = {}) {
  const bids = cleanSide(book?.bids).sort((a, b) => b[0] - a[0]);
  const asks = cleanSide(book?.asks).sort((a, b) => a[0] - b[0]);
  if (!bids.length || !asks.length) return null;
  const bestBid = bids[0][0], bestAsk = asks[0][0];
  const bidDepth = bids.reduce((s, l) => s + l[0] * l[1], 0), askDepth = asks.reduce((s, l) => s + l[0] * l[1], 0);
  const spread = bestAsk - bestBid;
  return {
    bids, asks, bestBid, bestAsk, mid: (bestBid + bestAsk) / 2, spread,
    spreadPips: Number(pip) > 0 ? Number((spread / pip).toFixed(2)) : null,
    spreadPct: (spread / ((bestAsk + bestBid) / 2)) * 100,
    bidDepth, askDepth, imbalance: bidDepth + askDepth ? (bidDepth - askDepth) / (bidDepth + askDepth) : null,
    crossed: spread < 0
  };
}

/** Sum visible-range liquidity (price x size) into `bins` equal price buckets for drawing depth bars. */
export function bucketDepth(levels, { lo, hi, bins }) {
  const count = Math.max(1, Math.floor(bins));
  if (!(hi > lo)) return { buckets: [], max: 0 };
  const size = (hi - lo) / count;
  const buckets = Array.from({ length: count }, (_, i) => ({ lo: lo + i * size, hi: lo + (i + 1) * size, notional: 0 }));
  for (const [price, qty] of levels) {
    if (price < lo || price > hi) continue;
    buckets[Math.min(count - 1, Math.floor((price - lo) / size))].notional += price * qty;
  }
  return { buckets, max: buckets.reduce((m, b) => Math.max(m, b.notional), 0) };
}

/* ---------- derivatives ---------- */

const unavailable = (v) => !v || typeof v !== 'object' || 'unavailable' in v;

/** Normalise the /api/advanced/derivatives payload. Every field stays null when the venue does not supply it. */
export function summarizeDerivatives(data, now = Date.now()) {
  if (!data || typeof data !== 'object') return null;
  const f = unavailable(data.funding) ? null : data.funding, oi = unavailable(data.openInterest) ? null : data.openInterest, t = unavailable(data.ticker) ? null : data.ticker;
  const rate = f ? num(f.fundingRate) : null;
  const nextAt = f ? (num(f.nextFundingTimestamp) ?? num(f.fundingTimestamp)) : null;
  const mark = (f && num(f.markPrice)) ?? (t && num(t.markPrice)) ?? null;
  const index = (f && num(f.indexPrice)) ?? (t && num(t.indexPrice)) ?? null;
  const liq = Array.isArray(data.liquidations) ? data.liquidations.map((l) => ({ ts: num(l.timestamp), price: num(l.price), side: l.side === 'sell' || l.side === 'short' ? 'long-liquidated' : l.side === 'buy' || l.side === 'long' ? 'short-liquidated' : 'unknown', value: num(l.quoteValue) ?? (num(l.price) && num(l.baseValue) ? num(l.price) * num(l.baseValue) : null) })).filter((l) => l.ts !== null && l.price > 0) : [];
  const out = {
    fundingRate: rate, fundingPct: rate === null ? null : rate * 100,
    nextFundingAt: nextAt, fundingInMs: nextAt !== null && nextAt > now ? nextAt - now : null,
    markPrice: mark, indexPrice: index,
    basis: mark !== null && index !== null ? mark - index : null,
    openInterest: oi ? num(oi.openInterestAmount) : null, openInterestValue: oi ? num(oi.openInterestValue) : null,
    liquidations: liq,
    liquidationStatus: data.liquidationClusters && data.liquidationClusters.status === 'unavailable' && !liq.length ? 'unavailable' : liq.length ? 'reported' : 'none-reported'
  };
  const any = out.fundingRate !== null || out.markPrice !== null || out.openInterest !== null || out.openInterestValue !== null || liq.length > 0;
  return any ? out : null;
}

export const fundingLabel = (pct) => (pct === null ? '—' : (pct > 0 ? '+' : '') + pct.toFixed(4) + '%');
