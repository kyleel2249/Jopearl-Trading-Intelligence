import { runCycle, dailyReview, ensureAgents } from '../functions/api/paper/[[path]].js';
import { normalizeStreamRequest } from '../src/sequence-aware-stream-engine.js';

const WATCHLIST = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','SOPHUSDT','BNBUSDT','DOGEUSDT','ADAUSDT','LINKUSDT','SUIUSDT'];
const DAILY_REVIEW_CRON = '5 0 * * *';
export function isDailyReviewDue(event = {}) {
  if (event.cron === DAILY_REVIEW_CRON) return true;
  const scheduledAt = Number(event.scheduledTime);
  if (!Number.isFinite(scheduledAt) || scheduledAt <= 0) return false;
  const date = new Date(scheduledAt);
  return date.getUTCHours() === 0 && date.getUTCMinutes() === 5;
}
const shortError = (error) => String(error?.message || error).slice(0, 180);
const STREAM_FALLBACK = [
  ...['binance','bybit','okx','bitget'].flatMap(exchange => [
    { exchange, marketType: 'spot', symbol: 'BTC/USDT' },
    { exchange, marketType: 'usdt-m', symbol: 'BTC/USDT' }
  ])
];
export function buildStreamStartPayload(rows = []) {
  const streams = (Array.isArray(rows) ? rows : []).map(row => ({
    exchange: String(row.exchange || '').toLowerCase(),
    marketType: String(row.market_type || row.marketType || '').toLowerCase(),
    symbol: String(row.symbol || '').toUpperCase().replace(/USDT$/, '/USDT').replace('//', '/')
  })).filter(x => ['binance','bybit','okx','bitget'].includes(x.exchange)
    && ['spot','margin','usdt-m','coin-m','usdc-m'].includes(x.marketType) && x.symbol.length >= 5);
  return { streams: (streams.length ? streams : STREAM_FALLBACK).slice(0, 40) };
}
export async function startMarketStreamCollector(env) {
  if (!env.MARKET_STREAMS) throw new Error('MARKET_STREAMS Durable Object binding is not configured.');
  const rows = await env.JPTI_DB.prepare("SELECT exchange,market_type,symbol,MAX(observed_at) AS last_seen FROM jpti_market_observations WHERE market_type IN ('spot','margin','usdt-m','coin-m','usdc-m') GROUP BY exchange,market_type,symbol ORDER BY last_seen DESC LIMIT 40").all();
  const payload = buildStreamStartPayload(rows.results || []);
  const results = [];
  for (let i = 0; i < payload.streams.length; i += 6) {
    const batch = await Promise.all(payload.streams.slice(i, i + 6).map(async item => {
      const config = normalizeStreamRequest(item);
      const id = env.MARKET_STREAMS.idFromName(config.streamId);
      const stub = env.MARKET_STREAMS.get(id);
      const response = await stub.fetch('https://stream-hub/start', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config)
      });
      if (!response.ok) throw new Error('Stream ' + config.streamId + ' returned HTTP ' + response.status + '.');
      return { streamId: config.streamId, ...(await response.json()) };
    }));
    results.push(...batch);
  }
  const started = results.filter(x => x.status === 'connected' || x.status === 'connecting').length;
  if (started < 1) throw new Error('No market streams were started.');
  return { requested: results.length, started, results };
}

export default {
  async scheduled(event, env, ctx) {
    if (!env.JPTI_DB) throw new Error('JPTI_DB D1 binding is required.');
    const task = (async () => {
      const failures = [], streamFailures = [];
      try { await startMarketStreamCollector(env); }
      catch (error) { streamFailures.push({ stage: 'market-stream-collector', error: shortError(error) }); }
      // Symbols run sequentially on purpose: each cycle reads fleet exposure from D1 before opening
      // a position, so parallel cycles could both pass the same concentration gate.
      try { await ensureAgents(env.JPTI_DB); }
      catch (error) { failures.push({ stage: 'ensure-agents', error: shortError(error) }); }
      if (!failures.length) {
        for (const symbol of WATCHLIST) {
          try { await runCycle(env.JPTI_DB, symbol, { agentsEnsured: true }); }
          catch (error) { failures.push({ stage: 'cycle', symbol, error: shortError(error) }); }
        }
      }
      // The daily review must not be skipped, nor lose its own failure, because a market cycle failed.
      if (isDailyReviewDue(event)) {
        try { await dailyReview(env.JPTI_DB); }
        catch (error) { failures.push({ stage: 'daily-review', error: shortError(error) }); }
      }
      if (failures.length || streamFailures.length) {
        // Each invocation receives a unique health-event ID so overlapping retries cannot overwrite diagnostics.
        const at = new Date().toISOString();
        const id = 'paper-scheduler:' + at + ':' + crypto.randomUUID().slice(0, 8);
        try {
          await env.JPTI_DB.prepare("INSERT OR IGNORE INTO jpti_events(id,kind,source,external_id,occurred_at,payload) VALUES(?, 'paper-scheduler-health','jpti-paper-scheduler',?,?,?)")
            .bind(id, String(event.cron || 'manual'), at, JSON.stringify({ failures, streamFailures, watchlist: WATCHLIST, cron: event.cron || null, mode: 'PAPER_ONLY' })).run();
        } catch (error) {
          console.error('[JPTI paper scheduler] could not record health event:', shortError(error), JSON.stringify(failures));
        }
      }
    })();
    ctx.waitUntil(task);
  }
};
