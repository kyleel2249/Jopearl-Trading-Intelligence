const finite = (value) => Number.isFinite(Number(value));
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

export function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const alpha = 2 / (period + 1);
  let current = values[0];
  return values.map((value, index) => {
    current = index ? Number(value) * alpha + current * (1 - alpha) : Number(value);
    return current;
  });
}

export function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = Number(values[i]) - Number(values[i - 1]);
    gains += Math.max(0, change); losses += Math.max(0, -change);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i += 1) {
    const change = Number(values[i]) - Number(values[i - 1]);
    avgGain = (avgGain * (period - 1) + Math.max(0, change)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -change)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length <= period) return null;
  const ranges = candles.slice(1).map((candle, index) => Math.max(
    Number(candle[2]) - Number(candle[3]),
    Math.abs(Number(candle[2]) - Number(candles[index][4])),
    Math.abs(Number(candle[3]) - Number(candles[index][4]))
  ));
  return mean(ranges.slice(-period));
}

export function analyzeSignal(candles, { symbol = 'BTC/USDT', exchange = 'bitget', timeframe = '1h', now = Date.now() } = {}) {
  const valid = (Array.isArray(candles) ? candles : []).filter((row) =>
    Array.isArray(row) && row.length >= 6 && row.slice(0, 6).every(finite) &&
    Number(row[2]) >= Number(row[3]) && Number(row[1]) > 0 && Number(row[4]) > 0
  );
  // Exclude the currently forming candle. Signals are based only on completed bars.
  const closed = valid.filter((row) => Number(row[0]) + timeframeMs(timeframe) <= now);
  if (closed.length < 55) return { status: 'insufficient-data', symbol, exchange, timeframe, observations: closed.length, required: 55, score: null, direction: 'neutral', evidence: [], reasons: ['At least 55 completed candles are required.'] };

  const closes = closed.map((row) => Number(row[4]));
  const last = closed[closed.length - 1], previous = closed[closed.length - 2];
  const fast = ema(closes, 20), slow = ema(closes, 50);
  const momentum = rsi(closes);
  const volatility = atr(closed);
  const recent = closed.slice(-20), prior = closed.slice(-40, -20);
  const recentHigh = Math.max(...recent.map((row) => Number(row[2])));
  const recentLow = Math.min(...recent.map((row) => Number(row[3])));
  const priorHigh = prior.length ? Math.max(...prior.map((row) => Number(row[2]))) : null;
  const priorLow = prior.length ? Math.min(...prior.map((row) => Number(row[3]))) : null;
  const averageVolume = mean(closed.slice(-21, -1).map((row) => Number(row[5])));
  const relativeVolume = averageVolume > 0 ? Number(last[5]) / averageVolume : null;
  const change20 = closes.length > 20 ? (closes.at(-1) / closes.at(-21) - 1) * 100 : 0;
  const bullish = fast.at(-1) > slow.at(-1) && Number(last[4]) > fast.at(-1);
  const bearish = fast.at(-1) < slow.at(-1) && Number(last[4]) < fast.at(-1);
  const breakoutUp = priorHigh != null && Number(last[4]) > priorHigh && Number(last[4]) > Number(previous[2]);
  const breakoutDown = priorLow != null && Number(last[4]) < priorLow && Number(last[4]) < Number(previous[3]);
  const volumeConfirmed = relativeVolume != null && relativeVolume >= 1.25;
  const momentumBull = momentum != null && momentum >= 52 && momentum <= 74;
  const momentumBear = momentum != null && momentum <= 48 && momentum >= 26;
  const evidence = [
    { key: 'trend', label: 'EMA 20 / 50 alignment', max: 15, bullish: bullish ? 15 : 0, bearish: bearish ? 15 : 0, detail: bullish ? 'Price and fast EMA above slow EMA' : bearish ? 'Price and fast EMA below slow EMA' : 'Trend alignment is mixed' },
    { key: 'structure', label: 'Structure / breakout', max: 15, bullish: breakoutUp ? 15 : 0, bearish: breakoutDown ? 15 : 0, detail: breakoutUp ? 'Close cleared the prior 20-bar high' : breakoutDown ? 'Close broke the prior 20-bar low' : 'No confirmed 20-bar breakout' },
    { key: 'momentum', label: 'RSI momentum', max: 10, bullish: momentumBull ? 10 : 0, bearish: momentumBear ? 10 : 0, detail: momentum == null ? 'Unavailable' : 'RSI ' + momentum.toFixed(1) },
    { key: 'volume', label: 'Relative volume', max: 10, bullish: volumeConfirmed && Number(last[4]) >= Number(last[1]) ? 10 : 0, bearish: volumeConfirmed && Number(last[4]) < Number(last[1]) ? 10 : 0, detail: relativeVolume == null ? 'Unavailable' : relativeVolume.toFixed(2) + '× 20-bar average' },
    { key: 'follow-through', label: 'Price follow-through', max: 10, bullish: change20 > 0.25 ? 10 : 0, bearish: change20 < -0.25 ? 10 : 0, detail: change20.toFixed(2) + '% over 20 completed bars' },
    { key: 'range', label: 'Range position', max: 5, bullish: Number(last[4]) > (recentHigh + recentLow) / 2 ? 5 : 0, bearish: Number(last[4]) < (recentHigh + recentLow) / 2 ? 5 : 0, detail: '20-bar range ' + recentLow + ' – ' + recentHigh }
  ];
  const bullScore = evidence.reduce((sum, item) => sum + item.bullish, 0);
  const bearScore = evidence.reduce((sum, item) => sum + item.bearish, 0);
  const direction = bullScore === bearScore ? 'neutral' : bullScore > bearScore ? 'long' : 'short';
  const score = Math.max(bullScore, bearScore);
  const rawEvidenceScore = direction === 'long' ? bullScore : direction === 'short' ? bearScore : 0;
  // Current implemented evidence set has 65 available points; normalize it to a stable 0–100 display scale.
  const sideScore = Math.round((rawEvidenceScore / 65) * 100);
  const entry = Number(last[4]);
  const stopDistance = volatility ? volatility * 1.5 : entry * 0.01;
  const stopLoss = direction === 'long' ? entry - stopDistance : direction === 'short' ? entry + stopDistance : null;
  const risk = stopLoss == null ? null : Math.abs(entry - stopLoss);
  const targets = risk == null ? [] : [1, 2, 3].map((multiple) => Number((entry + (direction === 'long' ? 1 : -1) * risk * multiple).toPrecision(12)));
  const invalidation = direction === 'long' ? 'A completed close below the stop / invalidation level' : direction === 'short' ? 'A completed close above the stop / invalidation level' : 'Wait for directional evidence';
  const signalType = breakoutUp ? 'breakout' : breakoutDown ? 'breakdown' : direction === 'long' || direction === 'short' ? 'trend-continuation' : 'no-trade';
  return {
    status: sideScore >= 60 ? 'confirmed-candidate' : sideScore >= 40 ? 'developing' : 'no-trade',
    signalId: [exchange, symbol, timeframe, last[0], direction].join(':'),
    symbol, exchange, timeframe, direction, signalType, score: sideScore,
    scoreLabel: sideScore >= 80 ? 'Strong evidence' : sideScore >= 60 ? 'Moderate evidence' : sideScore >= 40 ? 'Developing' : 'Weak / no trade',
    referencePrice: entry, stopLoss, targets, riskReward: risk ? [1, 2, 3] : [],
    rsi: momentum == null ? null : Number(momentum.toFixed(2)),
    atr: volatility, relativeVolume: relativeVolume == null ? null : Number(relativeVolume.toFixed(2)),
    change20Percent: Number(change20.toFixed(3)), recentHigh, recentLow,
    evidence: evidence.map((item) => ({ ...item, contribution: direction === 'long' ? item.bullish : direction === 'short' ? item.bearish : 0 })),
    reasons: evidence.filter((item) => (direction === 'long' ? item.bullish : direction === 'short' ? item.bearish : 0) > 0).map((item) => item.detail),
    invalidation, generatedAt: new Date(now).toISOString(), candleTimestamp: last[0],
    dataQuality: { completedCandles: closed.length, formingCandleExcluded: true, source: 'exchange OHLCV', scoreIsProbability: false }
  };
}

export function timeframeMs(value) {
  const match = /^(\d+)(m|h|d|w)$/.exec(String(value || ''));
  if (!match) return 60 * 60 * 1000;
  const amount = Number(match[1]), unit = match[2];
  return amount * ({ m: 60000, h: 3600000, d: 86400000, w: 604800000 }[unit]);
}
