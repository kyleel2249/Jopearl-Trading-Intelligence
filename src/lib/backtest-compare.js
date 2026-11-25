// Cross-product comparison of the existing deterministic replay engine.
// The engine models LINEAR PnL on one instrument and has no funding or liquidation model, so:
//  - Coin-M (inverse) and CFD are excluded rather than reported with wrong maths.
//  - Funding is applied afterwards from a user-supplied ASSUMED rate; it is not historical funding.
export const COMPARABLE_PRODUCTS = ['spot', 'margin', 'futures', 'usdc-futures'];
export const DEFAULT_FEE_BPS = { spot: 10, margin: 10, futures: 6, 'usdc-futures': 6 };
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export const replaySymbol = (symbol) => String(symbol || '').split(':')[0].toUpperCase();

export function buildReplayRequest({ candles, symbol, exchange = 'bitget', timeframe, feeBps, slippageBps, initialCapital, riskPercent }) {
  return { candles, symbol: replaySymbol(symbol), exchange, timeframe, feeBps, slippageBps, initialCapital, config: { riskPercent: Number(riskPercent), minimumConfidence: 62, minimumAgreement: 0.5, atrStopMultiple: 1.5, targetOneR: 1, targetTwoR: 2 } };
}

export function fundingCost(trade, ratePer8h) {
  const rate = num(ratePer8h);
  if (rate === null) return 0;
  const hours = Math.max(0, (Date.parse(trade.exitAt) - Date.parse(trade.entryAt)) / 3600000);
  const notional = Math.abs(num(trade.quantity) ?? 0) * Math.abs(num(trade.entry) ?? 0);
  // Positive funding: longs pay, shorts receive.
  return notional * rate * (hours / 8) * (trade.side === 'buy' ? 1 : -1);
}

export function metricsFromPnl(pnls, initialCapital) {
  const trades = pnls.length;
  const wins = pnls.filter((p) => p > 0), losses = pnls.filter((p) => p < 0);
  const grossProfit = wins.reduce((s, p) => s + p, 0), grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));
  let equity = initialCapital, peak = equity, maxDrawdown = 0;
  for (const p of pnls) { equity += p; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 0); }
  const net = pnls.reduce((s, p) => s + p, 0);
  return { trades, winRatePercent: trades ? (wins.length / trades) * 100 : null, profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null, netPnl: net, expectancy: trades ? net / trades : null, maxDrawdownPercent: maxDrawdown * 100, endingCapital: initialCapital + net };
}

export function summarizeReplay(product, replay, { initialCapital, fundingRatePer8h = 0 } = {}) {
  const trades = Array.isArray(replay?.trades) ? replay.trades : [];
  const leveraged = product === 'futures' || product === 'usdc-futures' || product === 'margin';
  const funding = leveraged ? trades.map((t) => fundingCost(t, fundingRatePer8h)) : trades.map(() => 0);
  const adjusted = trades.map((t, i) => Number(t.pnl) - funding[i]);
  return {
    product, candles: Array.isArray(replay?.data?.candles) ? replay.data.candles.length : null,
    engineNetPnl: num(replay?.overall?.netPnl), fundingCost: funding.reduce((s, f) => s + f, 0),
    ...metricsFromPnl(adjusted, initialCapital),
    outOfSampleNetPnl: num(replay?.outOfSample?.netPnl), outOfSampleTrades: num(replay?.outOfSample?.trades),
    tradesShown: trades.length, truncated: trades.length >= 500
  };
}

export function rankSummaries(rows) {
  return [...rows].sort((a, b) => (b.netPnl - a.netPnl) || (b.trades - a.trades)).map((row, index) => ({ ...row, rank: index + 1 }));
}
export const comparisonCaveats = (fundingRatePer8h) => [
  'Same deterministic engine and parameters on each product; differences come from the candles, fees and funding assumption.',
  'Funding uses the assumed rate of ' + (num(fundingRatePer8h) ?? 0) + ' per 8h for futures and margin, not historical funding.',
  'No leverage, liquidation, partial fills or order-book queue are modelled. Coin-M and CFD are not comparable here.',
  'Past results do not predict future performance; this is research output, not a trading recommendation.'
];
