/**
 * Browser WebSocket plan for the live tick stream. Reuses the Node-tested native adapters (public tickers only, no
 * keys). Spot is served on Binance, Bybit, OKX and Bitget; Bitget derivatives use its mix ticker channel.
 * The message decoder is the same code the API server uses (parseNativeTicker). Anything the plan cannot express
 * returns null and the chart keeps its REST polling.
 */
import { buildNativeStreamConfig, parseNativeTicker } from '../api/native-stream-adapters.js';

const BITGET_INST_TYPE = { futures: 'USDT-FUTURES', 'coin-futures': 'COIN-FUTURES', 'usdc-futures': 'USDC-FUTURES' };

export function venueMarketId(exchange, symbol) {
  const [rawBase = '', rawQuoteSettle = ''] = String(symbol || '').toUpperCase().split('/');
  const quote = rawQuoteSettle.split(':')[0];
  if (!rawBase || !quote) return null;
  return exchange === 'okx' ? rawBase + '-' + quote : rawBase + quote;
}

export function streamPlan({ exchange, symbol, marketType = 'spot', instrumentId } = {}) {
  const ex = String(exchange || '').toLowerCase();
  const id = ex === 'bitget' && instrumentId ? String(instrumentId) : venueMarketId(ex, symbol);
  if (!id) return null;
  if (marketType === 'spot' || (marketType === 'margin' && ex === 'bitget')) {
    const config = buildNativeStreamConfig(ex, { id, spot: true });
    return config ? { ...config, symbol, marketType } : null;
  }
  if (ex === 'bitget' && BITGET_INST_TYPE[marketType]) {
    return { exchange: ex, url: 'wss://ws.bitget.com/v2/ws/public', subscribe: { op: 'subscribe', args: [{ instType: BITGET_INST_TYPE[marketType], channel: 'ticker', instId: id }] }, heartbeat: 'ping', symbol, marketType };
  }
  return null;
}

/** Decode one raw WebSocket frame into { price, bid, ask, ts } or null (pongs, acks and anything else). */
export function decodeStreamMessage(plan, raw, now = Date.now()) {
  if (!plan || typeof raw !== 'string' || raw === 'pong') return null;
  const t = parseNativeTicker(plan.exchange, raw, plan.symbol, now);
  return t ? { price: t.last, bid: t.bid, ask: t.ask, ts: t.observedAt ? Date.parse(t.observedAt) : now, stale: t.stale } : null;
}

export const STREAM_FRESH_MS = 8000;
export const streamIsFresh = (updatedAt, now = Date.now()) => Number.isFinite(updatedAt) && now - updatedAt <= STREAM_FRESH_MS;

/** Reconnect delay: 1s doubling to a 15s ceiling. */
export const backoffMs = (attempt) => Math.min(15000, 1000 * 2 ** Math.max(0, Math.min(attempt, 4)));
