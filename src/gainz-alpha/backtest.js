// Backtest / walk-forward using the SAME engine as live. Closed candles only; entry at the next bar's open.
import { normalizeCandles, timeframeMs, mean } from './indicators.js';
import { analyzeGainzAlpha } from './engine.js';
import { evaluateOutcome, summarize, signalToRecord } from './learning.js';

export function runBacktest(candles, o = {}) {
  const { symbol = 'unknown', timeframe = '1h', preset = 'balanced', overrides, feePct = 0.0005, window = 400, maxHold = 24, startIndex = 0, endIndex = null, higherTimeframes = [] } = o;
  const rows = normalizeCandles(candles), tf = timeframeMs(timeframe);
  if (!tf) return { status: 'error', reason: 'unknown timeframe ' + timeframe, trades: [] };
  const end = endIndex ?? rows.length - 1, trades = [], recent = [];
  let busyUntil = -1, held = 0;
  for (let i = Math.max(startIndex, 60); i < end; i++) {
    if (i <= busyUntil) continue;
    const slice = rows.slice(Math.max(0, i + 1 - window), i + 1), now = rows[i][0] + tf;
    const r = analyzeGainzAlpha(slice, { symbol, timeframe, preset, overrides, now, recentSignals: recent, higherTimeframes: higherTimeframes.map((h) => ({ timeframe: h.timeframe, candles: h.candles.filter((c) => c[0] + (timeframeMs(h.timeframe) || 0) <= now) })), outcomes: [] });
    if (r.status !== 'ready' || !['BUY', 'SELL'].includes(r.signal)) continue;
    recent.push({ setupId: r.setupId, direction: r.signal, symbol, timeframe, candleTs: r.asOf });
    const future = rows.slice(i + 1, i + 1 + maxHold);
    const out = evaluateOutcome(r, future, { window: maxHold, costPct: feePct * 2 + (r.riskPlan.costs.spreadPct + r.riskPlan.costs.slippagePct) });
    if (out.status !== 'resolved') continue; // window not complete: never counted (no partial information)
    const rec = { ...signalToRecord(r), ...out, tfMs: tf };
    trades.push(rec); busyUntil = i + out.bars; held += out.bars;
  }
  const span = Math.max(1, end - Math.max(startIndex, 60));
  const R = trades.map((t) => t.returnR), sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
  const dn = R.filter((v) => v < 0);
  const s = summarize(trades, {});
  const regimes = {};
  for (const v of ['low', 'normal', 'high']) regimes[v] = summarize(trades, { volRegime: v });
  return {
    status: 'ok', symbol, timeframe, preset, bars: span, trades, summary: s, exposure: Number((held / span).toFixed(3)),
    sharpePerTrade: R.length >= 30 && sd(R) > 0 ? Number((mean(R) / sd(R)).toFixed(3)) : null,
    sortinoPerTrade: R.length >= 30 && dn.length > 1 && sd(dn) > 0 ? Number((mean(R) / sd(dn)).toFixed(3)) : null,
    regimes, assumptions: { feePct, entry: 'next-open', sameBarStopTarget: 'stop-first', maxHoldBars: maxHold, lookahead: 'none' }
  };
}

export function walkForward(candles, o = {}) {
  const rows = normalizeCandles(candles), folds = o.folds || 3, warm = 60, seg = Math.floor((rows.length - warm) / folds);
  if (seg < 30) return { status: 'insufficient', reason: 'Not enough history for ' + folds + ' folds' };
  const out = [];
  for (let f = 0; f < folds; f++) {
    const startIndex = warm + f * seg, endIndex = f === folds - 1 ? rows.length - 1 : startIndex + seg;
    const bt = runBacktest(rows, { ...o, startIndex, endIndex });
    out.push({ fold: f + 1, role: f === folds - 1 ? 'out-of-sample' : 'in-sample', startTs: rows[startIndex][0], endTs: rows[endIndex][0], summary: bt.summary, exposure: bt.exposure });
  }
  return { status: 'ok', folds: out, note: 'Parameters are fixed across folds (no fitting inside this function), so the last fold is a genuine out-of-sample check.' };
}
