// Live Bitget health probe: for every product check catalogue, ticker and candles and classify the result.
export const HEALTH_PRODUCTS = ['spot', 'margin', 'futures', 'coin-futures', 'usdc-futures', 'cfd'];
const SAMPLE = { spot: 'BTC/USDT', margin: 'BTC/USDT', futures: 'BTC/USDT', 'coin-futures': 'BTC/USD', 'usdc-futures': 'BTC/USDC', cfd: 'XAUUSD' };
const FRAME_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000 };

export function classifyStep(step) {
  if (!step) return 'skipped';
  if (!step.ok) return 'down';
  if (step.slow) return 'degraded';
  return 'ok';
}
export function overallStatus(steps) {
  const states = Object.values(steps).map(classifyStep).filter((s) => s !== 'skipped');
  if (!states.length) return 'unknown';
  if (states.every((s) => s === 'down')) return 'down';
  if (states.includes('down') || states.includes('degraded')) return 'degraded';
  return 'ok';
}
export function candleFreshness(lastTimestamp, timeframe, now) {
  const frame = FRAME_MS[timeframe];
  if (!Number.isFinite(lastTimestamp) || !frame) return { stale: null, ageMs: null };
  const ageMs = now - lastTimestamp;
  return { stale: ageMs > frame * 3, ageMs };
}

async function timed(run, slowMs, clock) {
  const start = clock();
  try { const value = await run(); const latencyMs = Math.round(clock() - start); return { ok: true, latencyMs, slow: latencyMs > slowMs, ...value }; }
  catch (error) { return { ok: false, latencyMs: Math.round(clock() - start), error: error.message || 'failed' }; }
}

export async function probeProduct(apiFetch, product, { exchange = 'bitget', timeframe = '5m', slowMs = 4000, clock = () => Date.now(), cloudflareMode = false } = {}) {
  if (product === 'cfd' && !cloudflareMode) return { product, status: 'unavailable', reason: 'CFD needs the Cloudflare Pages edge API with Bitget read-only UTA secrets.', steps: {} };
  const getJson = async (path) => { const response = await apiFetch(path, { cache: 'no-store' }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data?.error || 'HTTP ' + response.status); return data; };
  const sampleBase = SAMPLE[product].split('/')[0];
  let markets = [];
  const catalog = await timed(async () => { const data = await getJson('/api/exchanges/' + exchange + '/markets?type=' + encodeURIComponent(product) + '&search=' + encodeURIComponent(sampleBase)); markets = Array.isArray(data.markets) ? data.markets : []; if (!markets.length) throw new Error('Catalogue is empty.'); return { count: data.counts?.[product] ?? markets.length }; }, slowMs, clock);
  const wanted = SAMPLE[product].replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const market = markets.find((m) => String(m.symbol || '').split(':')[0].replace(/[^A-Za-z0-9]/g, '').toUpperCase() === wanted) || markets[0];
  const steps = { catalog };
  if (!catalog.ok || !market) return { product, status: overallStatus(steps), sample: null, steps };
  const sym = String(market.symbol).replace('/', '-');
  const extra = (market.id && exchange === 'bitget' ? '&instrumentId=' + encodeURIComponent(market.id) : '') + (product === 'cfd' ? '&side=buy' : '');
  steps.ticker = await timed(async () => { const data = await getJson('/api/exchanges/' + exchange + '/ticker/' + sym + '?type=' + encodeURIComponent(product) + extra); if (!(Number(data.last) > 0)) throw new Error('Ticker has no last price.'); return { last: Number(data.last) }; }, slowMs, clock);
  steps.candles = await timed(async () => { const data = await getJson('/api/exchanges/' + exchange + '/ohlcv/' + sym + '?timeframe=' + timeframe + '&limit=50&type=' + encodeURIComponent(product) + extra); const rows = (data.candles || []).filter((r) => Array.isArray(r) && r.length >= 6); if (!rows.length) throw new Error('No candles returned.'); const fresh = candleFreshness(Number(rows[rows.length - 1][0]), timeframe, clock()); return { count: rows.length, ...fresh }; }, slowMs, clock);
  const status = steps.candles.ok && steps.candles.stale ? 'degraded' : overallStatus(steps);
  return { product, status, sample: market.symbol, steps };
}

export async function probeAll(apiFetch, options = {}) {
  const results = await Promise.all(HEALTH_PRODUCTS.map((product) => probeProduct(apiFetch, product, options)));
  const counted = results.filter((r) => r.status !== 'unavailable');
  return { checkedAt: new Date((options.clock || Date.now)()).toISOString(), results, working: counted.filter((r) => r.status === 'ok').length, total: counted.length };
}
