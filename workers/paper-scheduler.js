import { runCycle, dailyReview, ensureAgents } from '../functions/api/paper/[[path]].js';

const WATCHLIST = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','SOPHUSDT','BNBUSDT','DOGEUSDT','ADAUSDT','LINKUSDT','SUIUSDT'];
const DAILY_REVIEW_CRON = '5 0 * * *';
const shortError = (error) => String(error?.message || error).slice(0, 180);

export default {
  async scheduled(event, env, ctx) {
    if (!env.JPTI_DB) throw new Error('JPTI_DB D1 binding is required.');
    const task = (async () => {
      const failures = [];
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
      if (event.cron === DAILY_REVIEW_CRON) {
        try { await dailyReview(env.JPTI_DB); }
        catch (error) { failures.push({ stage: 'daily-review', error: shortError(error) }); }
      }
      if (failures.length) {
        // The per-minute and 00:05 crons both fire at 00:05, so the id must be unique per invocation;
        // a minute-granular id made the second health write collide and silently drop its failures.
        const at = new Date().toISOString();
        const id = 'paper-scheduler:' + at + ':' + crypto.randomUUID().slice(0, 8);
        try {
          await env.JPTI_DB.prepare("INSERT OR IGNORE INTO jpti_events(id,kind,source,external_id,occurred_at,payload) VALUES(?, 'paper-scheduler-health','jpti-paper-scheduler',?,?,?)")
            .bind(id, String(event.cron || 'manual'), at, JSON.stringify({ failures, watchlist: WATCHLIST, cron: event.cron || null, mode: 'PAPER_ONLY' })).run();
        } catch (error) {
          console.error('[JPTI paper scheduler] could not record health event:', shortError(error), JSON.stringify(failures));
        }
      }
    })();
    ctx.waitUntil(task);
  }
};
