const finite = value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function normalizeCandles(input) {
  return (Array.isArray(input) ? input : []).map(row => {
    const values = Array.isArray(row) ? row : [row.timestamp, row.open, row.high, row.low, row.close, row.volume];
    return { timestamp: finite(values[0]), open: finite(values[1]), high: finite(values[2]), low: finite(values[3]), close: finite(values[4]), volume: finite(values[5]) };
  }).filter(c => c.timestamp !== null && [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
    Math.min(c.open,c.high,c.low,c.close) > 0 && c.volume >= 0 && c.high >= Math.max(c.open,c.close,c.low) && c.low <= Math.min(c.open,c.close,c.high))
    .sort((a,b) => a.timestamp-b.timestamp);
}

export function ema(values, period) {
  if (!Array.isArray(values) || values.length < period || period < 2) return null;
  const alpha = 2 / (period + 1);
  let value = mean(values.slice(0, period));
  for (let i = period; i < values.length; i++) value = values[i] * alpha + value * (1 - alpha);
  return value;
}

export function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change; else losses -= change;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

export function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length <= period) return null;
  const ranges = candles.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - candles[i].close), Math.abs(c.low - candles[i].close)));
  return mean(ranges.slice(-period));
}

function pivotLevels(candles, span = 2) {
  const highs = [], lows = [];
  for (let i = span; i < candles.length - span; i++) {
    const slice = candles.slice(i - span, i + span + 1);
    if (candles[i].high === Math.max(...slice.map(c => c.high))) highs.push({ index: i, price: candles[i].high });
    if (candles[i].low === Math.min(...slice.map(c => c.low))) lows.push({ index: i, price: candles[i].low });
  }
  return { highs, lows };
}

export function analyzeTimeframe(input, timeframe) {
  const candles = normalizeCandles(input);
  if (candles.length < 60) return { timeframe, status: 'insufficient-data', candles: candles.length, required: 60, bias: 'unavailable', score: null, reasons: ['At least 60 valid candles are required.'] };
  const closed = candles.slice(0, -1);
  const closes = closed.map(c => c.close), last = closed.at(-1), previous = closed.at(-2);
  const ema20 = ema(closes, 20), ema50 = ema(closes, 50), currentRsi = rsi(closes), currentAtr = atr(closed);
  const avgVolume = mean(closed.slice(-21, -1).map(c => c.volume));
  const relativeVolume = avgVolume > 0 ? last.volume / avgVolume : null;
  const pivots = pivotLevels(closed.slice(-80));
  const recentHighs = pivots.highs.slice(-2), recentLows = pivots.lows.slice(-2);
  const structure = recentHighs.length >= 2 && recentLows.length >= 2
    ? (recentHighs[1].price > recentHighs[0].price && recentLows[1].price > recentLows[0].price ? 'higher-highs-higher-lows'
      : recentHighs[1].price < recentHighs[0].price && recentLows[1].price < recentLows[0].price ? 'lower-highs-lower-lows' : 'mixed')
    : 'unconfirmed';
  const momentumPct = previous.close ? (last.close / previous.close - 1) * 100 : 0;
  const trend = last.close > ema20 && ema20 > ema50 ? 'bullish' : last.close < ema20 && ema20 < ema50 ? 'bearish' : 'mixed';
  const rsiBias = currentRsi >= 55 ? 1 : currentRsi <= 45 ? -1 : 0;
  const trendBias = trend === 'bullish' ? 1 : trend === 'bearish' ? -1 : 0;
  const structureBias = structure === 'higher-highs-higher-lows' ? 1 : structure === 'lower-highs-lower-lows' ? -1 : 0;
  const momentumBias = momentumPct > 0.1 ? 1 : momentumPct < -0.1 ? -1 : 0;
  const score = clamp(Math.round(trendBias * 35 + structureBias * 30 + rsiBias * 20 + momentumBias * 15), -100, 100);
  return {
    timeframe, status: 'available', candles: closed.length, asOf: new Date(last.timestamp).toISOString(),
    close: last.close, previousClose: previous.close, momentumPct: Number(momentumPct.toFixed(4)),
    ema20, ema50, rsi14: currentRsi, atr14: currentAtr, atrPercent: currentAtr / last.close * 100,
    relativeVolume, trend, structure, bias: score >= 25 ? 'bullish' : score <= -25 ? 'bearish' : 'neutral', score,
    support: pivots.lows.at(-1)?.price ?? null, resistance: pivots.highs.at(-1)?.price ?? null,
    reasons: [
      'EMA structure: ' + trend + '.',
      'Recent swing structure: ' + structure + '.',
      'RSI(14): ' + currentRsi.toFixed(1) + '.',
      'Relative volume: ' + (relativeVolume === null ? 'unavailable' : relativeVolume.toFixed(2) + '×') + '.'
    ],
    limitations: ['Uses closed candles only; the newest in-progress candle is excluded.', 'Swing structure is a simple confirmed-pivot heuristic, not a full market-structure or order-flow model.']
  };
}

export function analyzeTradeRisk(input = {}) {
  const entry = finite(input.entryPrice), quantity = finite(input.quantity), margin = finite(input.margin), leverage = finite(input.leverage);
  const reportedLiquidation = finite(input.liquidationPrice);
  const notional = entry !== null && quantity !== null ? entry * quantity : null;
  const impliedMargin = notional !== null && leverage > 0 ? notional / leverage : null;
  const marginUtilization = notional && margin ? margin / notional * 100 : null;
  const liquidationDistancePct = entry && reportedLiquidation ? (entry - reportedLiquidation) / entry * 100 : null;
  const scenarios = [-1,-2,-3,-4,-5,-7.5,-10].map(move => ({ movePct: move, pnl: notional === null ? null : notional * move / 100, marginReturnPct: notional && margin ? (notional * move / 100) / margin * 100 : null }));
  const warnings = [];
  if (leverage >= 10) warnings.push('High leverage magnifies small adverse price moves.');
  if (input.stopLoss === null || input.stopLoss === undefined || input.stopLoss === '') warnings.push('No stop-loss or alternative maximum-loss rule is recorded.');
  if (liquidationDistancePct !== null && leverage >= 10 && liquidationDistancePct > (100 / leverage) * 1.5) warnings.push('Reported liquidation distance is unusually wide for the stated leverage; verify margin mode, additional collateral, maintenance margin and mark-price rules.');
  if (input.direction === 'long' && input.marketBias === 'bearish') warnings.push('Countertrend long: document the reversal trigger and invalidation before treating this as a prepared setup.');
  return { notional, impliedMargin, reportedMargin: margin, marginDifference: margin !== null && impliedMargin !== null ? margin - impliedMargin : null,
    marginUtilizationPercent: marginUtilization, reportedLiquidation, liquidationDistancePct, scenarios, warnings,
    classification: warnings.length >= 3 ? 'high' : warnings.length ? 'elevated' : 'unassessed',
    note: 'Linear P/L illustrations only. Not a liquidation calculator; excludes maintenance tiers, fees, funding, mark price, cross collateral and other positions.' };
}

export function buildTradingDevelopmentAssessment(input = {}) {
  const timeframes = input.timeframes || {};
  const order = ['15m','1h','4h','1d'].map(key => timeframes[key]).filter(x => x?.status === 'available');
  const positive = order.filter(x => x.score > 0).length, negative = order.filter(x => x.score < 0).length;
  const alignment = order.length ? (positive - negative) / order.length : null;
  const marketBias = alignment === null ? 'insufficient-evidence' : alignment >= .5 ? 'bullish-alignment' : alignment <= -.5 ? 'bearish-alignment' : 'mixed-timeframe';
  const direction = String(input.direction || 'long').toLowerCase();
  const countertrend = (direction === 'long' && marketBias === 'bearish-alignment') || (direction === 'short' && marketBias === 'bullish-alignment');
  const risk = analyzeTradeRisk(input.trade || {});
  const missing = [];
  if (order.length < 3) missing.push('At least three valid timeframes are required for multi-timeframe alignment.');
  if (!input.trade?.invalidation) missing.push('A written setup invalidation condition is missing.');
  if (!input.trade?.takeProfit) missing.push('A planned profit-taking rule or target is missing.');
  if (input.trade?.stopLoss === null || input.trade?.stopLoss === undefined || input.trade?.stopLoss === '') missing.push('No stop-loss or bounded alternative loss rule is documented.');
  const process = missing.length >= 3 ? 'incomplete' : missing.length ? 'partially-documented' : 'documented';
  const riskLevel = risk.classification;
  const decision = riskLevel === 'high' || countertrend || order.length < 3 ? 'caution' : 'review-setup';
  return {
    generatedAt: new Date().toISOString(), engine: 'JPTI Trading Development Engine', engineVersion: '1.0.0-rules',
    status: order.length >= 3 ? 'analysis-available' : 'partial-analysis',
    market: { timeframeCount: order.length, alignment, bias: marketBias, countertrend, positiveTimeframes: positive, negativeTimeframes: negative },
    timeframes: input.timeframes || {}, risk, process: { status: process, missing },
    decision: { status: decision, instruction: 'Research and decision support only. No order is placed, modified or cancelled.' },
    coaching: {
      strengths: ['You recorded the trade before execution.', 'You stated operating rules and a profit-allocation policy.', 'You intend to review and learn from each trade.'],
      developmentAreas: [
        ...(countertrend ? ['The selected direction conflicts with the available higher-timeframe alignment; require a specific reversal trigger.'] : []),
        ...risk.warnings,
        'Replace subjective confidence with observable entry, invalidation and exit criteria.',
        'Measure decision quality separately from the trade outcome.'
      ],
      nextActions: missing
    },
    limitations: ['This is a deterministic rules-based assessment, not an AI model or a calibrated probability of profit.', 'No news, tokenomics, order-book, funding or institutional positioning is inferred from OHLCV.', 'Missing evidence is reported as missing, never filled with assumptions.']
  };
}

export function buildReflectiveReport(entry = {}, assessment = null) {
  const money = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? 'Not recorded' : '
  const price = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? 'Not recorded' : String(value);
  const lines = [
    '# Reflective Trading Journal — ' + String(entry.symbol || 'Unspecified pair'),
    '',
    '## The beginning of a new trading chapter',
    '',
    String(entry.openingNarrative || ''),
    '',
    '## Trade record',
    '',
    '- Date: ' + String(entry.date || 'Not recorded'),
    '- Direction: ' + String(entry.direction || 'Not recorded'),
    '- Timeframe: ' + String(entry.timeframe || 'Not recorded'),
    '- Execution venue: ' + String(entry.exchange || 'Not confirmed'),
    '- Order status: ' + String(entry.orderStatus || 'Not recorded'),
    '- Limit price: ' + price(entry.entryPrice),
    '- Quantity: ' + String(entry.quantity ?? 'Not recorded'),
    '- Notional: ' + money(entry.notional || Number(entry.entryPrice) * Number(entry.quantity)),
    '- Margin: ' + money(entry.margin),
    '- Leverage: ' + String(entry.leverage ?? 'Not recorded') + 'x',
    '- Reported liquidation: ' + price(entry.liquidationPrice),
    '- Estimated institutional liquidity reference: ' + price(entry.institutionalLiquidityLevel) + ' (user-supplied hypothesis; unverified),
    '- Stop-loss: ' + (entry.stopLoss ?? 'Not set'),
    '- Take-profit: ' + (entry.takeProfit ?? 'Not recorded'),
    '',
    '## Research and market context',
    '',
    String(entry.thesis || 'No complete trade thesis has been documented.'),
    '',
    ...(entry.researchSnapshot ? [
      '### Fundamental findings',
      '',
      '- Project transition: ' + String(entry.researchSnapshot.projectFundamentals?.finding || 'Not recorded'),
      '- Chain migration: ' + String(entry.researchSnapshot.chainMigration?.finding || 'Not recorded'),
      '- Unlock watch: ' + String(entry.researchSnapshot.unlockWatch?.finding || 'Not recorded'),
      '- Derivatives snapshot: ' + JSON.stringify(entry.researchSnapshot.derivativesSnapshot || {}),
      '',
      'Sources:',
      ...(Object.values(entry.researchSnapshot).filter(x => x && x.url).map(x => '- ' + String(x.source || 'Source') + ': ' + x.url)),
      ''
    ] : []),
    '## Risk assessment',
    '',
    ...(assessment?.risk?.warnings || []).map(item => '- WARNING: ' + item),
    ...(assessment?.risk?.scenarios || []).map(item => '- ' + item.movePct + '% price move: ' + money(item.pnl) + ' estimated P/L'),
    assessment?.risk?.note || 'Risk calculation unavailable until position inputs are complete.',
    '',
    '## Coach and mentor assessment',
    '',
    ...(assessment?.coaching?.strengths || ['Trade preparation and behavioural evidence remain incomplete.']).map(item => '- Strength: ' + item),
    ...(assessment?.coaching?.developmentAreas || ['Define entry evidence, invalidation and exit conditions.']).map(item => '- Development area: ' + item),
    '',
    ...(entry.mentorReview ? ['## AI mentor and research council review', '', String(entry.mentorReview), ''] : []),
    '## Reflections and lessons',
    '',
    ...((entry.reflection || []).map(item => '- ' + String(item.at || '') + ' — ' + String(item.note || '') + (item.lesson ? ' Lesson: ' + item.lesson : '') + (item.nextAction ? ' Next action: ' + item.nextAction : ''))),
    '',
    '## Trading charter',
    '',
    ...(entry.rules || []).map((item, index) => (index + 1) + '. ' + item),
    '',
    '## Final note',
    '',
    'This report separates user-supplied facts, market-source observations and deterministic engine interpretation. It is not a calibrated probability, personalized investment instruction or proof of order execution. Update it when new evidence or trade outcomes arrive.',
    ''
  ];
  return lines.join('\n');
}
 + Number(value).toFixed(2);
  const price = value => Number.isFinite(Number(value)) ? String(value) : 'Not recorded';
  const lines = [
    '# Reflective Trading Journal — ' + String(entry.symbol || 'Unspecified pair'),
    '',
    '## The beginning of a new trading chapter',
    '',
    String(entry.openingNarrative || ''),
    '',
    '## Trade record',
    '',
    '- Date: ' + String(entry.date || 'Not recorded'),
    '- Direction: ' + String(entry.direction || 'Not recorded'),
    '- Timeframe: ' + String(entry.timeframe || 'Not recorded'),
    '- Execution venue: ' + String(entry.exchange || 'Not confirmed'),
    '- Order status: ' + String(entry.orderStatus || 'Not recorded'),
    '- Limit price: ' + price(entry.entryPrice),
    '- Quantity: ' + String(entry.quantity ?? 'Not recorded'),
    '- Notional: ' + money(entry.notional || Number(entry.entryPrice) * Number(entry.quantity)),
    '- Margin: ' + money(entry.margin),
    '- Leverage: ' + String(entry.leverage ?? 'Not recorded') + 'x',
    '- Reported liquidation: ' + price(entry.liquidationPrice),
    '- Stop-loss: ' + (entry.stopLoss ?? 'Not set'),
    '- Take-profit: ' + (entry.takeProfit ?? 'Not recorded'),
    '',
    '## Research and market context',
    '',
    String(entry.thesis || 'No complete trade thesis has been documented.'),
    '',
    ...(entry.researchSnapshot ? [
      '### Fundamental findings',
      '',
      '- Project transition: ' + String(entry.researchSnapshot.projectFundamentals?.finding || 'Not recorded'),
      '- Chain migration: ' + String(entry.researchSnapshot.chainMigration?.finding || 'Not recorded'),
      '- Unlock watch: ' + String(entry.researchSnapshot.unlockWatch?.finding || 'Not recorded'),
      '- Derivatives snapshot: ' + JSON.stringify(entry.researchSnapshot.derivativesSnapshot || {}),
      '',
      'Sources:',
      ...(Object.values(entry.researchSnapshot).filter(x => x && x.url).map(x => '- ' + String(x.source || 'Source') + ': ' + x.url)),
      ''
    ] : []),
    '## Risk assessment',
    '',
    ...(assessment?.risk?.warnings || []).map(item => '- WARNING: ' + item),
    ...(assessment?.risk?.scenarios || []).map(item => '- ' + item.movePct + '% price move: ' + money(item.pnl) + ' estimated P/L'),
    assessment?.risk?.note || 'Risk calculation unavailable until position inputs are complete.',
    '',
    '## Coach and mentor assessment',
    '',
    ...(assessment?.coaching?.strengths || ['Trade preparation and behavioural evidence remain incomplete.']).map(item => '- Strength: ' + item),
    ...(assessment?.coaching?.developmentAreas || ['Define entry evidence, invalidation and exit conditions.']).map(item => '- Development area: ' + item),
    '',
    ...(entry.mentorReview ? ['## AI mentor and research council review', '', String(entry.mentorReview), ''] : []),
    '## Reflections and lessons',
    '',
    ...((entry.reflection || []).map(item => '- ' + String(item.at || '') + ' — ' + String(item.note || '') + (item.lesson ? ' Lesson: ' + item.lesson : '') + (item.nextAction ? ' Next action: ' + item.nextAction : ''))),
    '',
    '## Trading charter',
    '',
    ...(entry.rules || []).map((item, index) => (index + 1) + '. ' + item),
    '',
    '## Final note',
    '',
    'This report separates user-supplied facts, market-source observations and deterministic engine interpretation. It is not a calibrated probability, personalized investment instruction or proof of order execution. Update it when new evidence or trade outcomes arrive.',
    ''
  ];
  return lines.join('\n');
}
