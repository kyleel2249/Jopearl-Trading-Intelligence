import { runCycle, dailyReview } from '../functions/api/paper/[[path]].js';

const WATCHLIST = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','SOPHUSDT','BNBUSDT','DOGEUSDT','ADAUSDT','LINKUSDT','SUIUSDT'];

export default {
  async scheduled(event, env, ctx) {
    if (!env.JPTI_DB) throw new Error('JPTI_DB D1 binding is required.');
    const task = (async () => {
      const failures = [];
      for (const symbol of WATCHLIST) {
        try { await runCycle(env.JPTI_DB, symbol); }
        catch (error) { failures.push({ symbol, error: String(error?.message || error).slice(0,180) }); }
      }
      if (event.cron === '5 0 * * *') await dailyReview(env.JPTI_DB);
      if (failures.length) {
        await env.JPTI_DB.prepare("INSERT INTO jpti_events(id,kind,source,external_id,occurred_at,payload) VALUES(?, 'paper-scheduler-health','jpti-paper-scheduler',?,?,?)")
          .bind('paper-scheduler:'+new Date().toISOString().slice(0,16), 'minute-cycle', new Date().toISOString(), JSON.stringify({ failures, watchlist: WATCHLIST, mode:'PAPER_ONLY' })).run();
      }
    })();
    ctx.waitUntil(task);
  }
};
