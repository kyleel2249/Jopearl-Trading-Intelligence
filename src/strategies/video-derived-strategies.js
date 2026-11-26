// Reproducible video-derived strategy specifications for JPTI.
// Research/paper only. No broker or order-routing dependencies.
export const VIDEO_STRATEGY_VERSION = 'video-strategies-1.0.0';
export const VIDEO_STRATEGY_IDS = Object.freeze({
  MA_CROSSOVER: 'xau-ma-44-332',
  FRACTAL_BREAKOUT: 'first-williams-fractal-breakout'
});

const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const positive = value => finite(value) && Number(value) > 0;
const round = (value, places = 8) => Number(Number(value).toFixed(places));
const asTime = value => {
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) ? n : NaN;
};
const validBars = bars => Array.isArray(bars) && bars.length > 0 && bars.every((b, i) =>
  b && positive(b.close) && finite(b.high) && finite(b.low) && Number(b.high) >= Number(b.low) &&
  Number(b.close) <= Number(b.high) && Number(b.close) >= Number(b.low) &&
  Number.isFinite(asTime(b.timestamp)) && (i === 0 || asTime(b.timestamp) > asTime(bars[i - 1].timestamp))
);
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const localParts = (timestamp, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
};
const localDay = (timestamp, timeZone) => {
  const p = localParts(timestamp, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
};
const localMinute = (timestamp, timeZone) => {
  const p = localParts(timestamp, timeZone);
  return Number(p.hour) * 60 + Number(p.minute);
};

export function calculateSma(values, period) {
  if (!Array.isArray(values) || !Number.isInteger(period) || period < 1) return [];
  return values.map((_, index) => index + 1 < period ? null : mean(values.slice(index + 1 - period, index + 1)));
}

export function evaluateMa44332Strategy(input = {}) {
  const bars = input.bars || [];
  const fastPeriod = Number(input.fastPeriod ?? 44);
  const slowPeriod = Number(input.slowPeriod ?? 332);
  const reasons = [];
  if (!validBars(bars)) reasons.push('bars-invalid-or-not-strictly-ordered');
  if (!Number.isInteger(fastPeriod) || !Number.isInteger(slowPeriod) || fastPeriod < 2 || slowPeriod <= fastPeriod) reasons.push('moving-average-periods-invalid');
  if (bars.length < slowPeriod + 1) reasons.push('insufficient-closed-bars-for-crossover');
  if (!positive(input.previousDayHigh) || !positive(input.previousDayLow) || Number(input.previousDayHigh) <= Number(input.previousDayLow)) reasons.push('previous-day-range-unavailable');
  if (input.allBarsClosed !== true) reasons.push('closed-candles-not-confirmed');
  if (reasons.length) return { strategyId: VIDEO_STRATEGY_IDS.MA_CROSSOVER, version: VIDEO_STRATEGY_VERSION, status: 'abstain', reasons, signal: null, paperOnly: true, liveExecutionAuthorized: false };

  const closes = bars.map(b => Number(b.close));
  const fast = calculateSma(closes, fastPeriod), slow = calculateSma(closes, slowPeriod);
  const last = bars.length - 1, prior = last - 1;
  const crossedUp = fast[prior] <= slow[prior] && fast[last] > slow[last];
  const crossedDown = fast[prior] >= slow[prior] && fast[last] < slow[last];
  if (!crossedUp && !crossedDown) return {
    strategyId: VIDEO_STRATEGY_IDS.MA_CROSSOVER, version: VIDEO_STRATEGY_VERSION,
    status: 'no-signal', reasons: ['no-new-confirmed-crossover'], signal: null,
    diagnostics: { fastPeriod, slowPeriod, fastSma: round(fast[last]), slowSma: round(slow[last]), barsUsed: bars.length },
    paperOnly: true, liveExecutionAuthorized: false
  };
  const direction = crossedUp ? 'long' : 'short';
  const entry = Number(bars[last].close);
  const stop = Number(crossedUp ? input.previousDayLow : input.previousDayHigh);
  const riskDistance = direction === 'long' ? entry - stop : stop - entry;
  if (!(riskDistance > 0)) return { strategyId: VIDEO_STRATEGY_IDS.MA_CROSSOVER, version: VIDEO_STRATEGY_VERSION, status: 'abstain', reasons: ['previous-day-stop-on-wrong-side-of-entry'], signal: null, paperOnly: true, liveExecutionAuthorized: false };
  return {
    strategyId: VIDEO_STRATEGY_IDS.MA_CROSSOVER, version: VIDEO_STRATEGY_VERSION, status: 'signal',
    signal: { direction, entry, stopLoss: stop, riskDistance: round(riskDistance), stopSource: direction === 'long' ? 'previous-day-low' : 'previous-day-high', confirmedAt: bars[last].timestamp, trigger: 'closed-candle-sma-crossover' },
    diagnostics: { fastPeriod, slowPeriod, fastSma: round(fast[last]), slowSma: round(slow[last]), barsUsed: bars.length },
    paperOnly: true, liveExecutionAuthorized: false
  };
}

export function confirmWilliamsFractal(bars, centerIndex) {
  if (!Array.isArray(bars) || !Number.isInteger(centerIndex) || centerIndex < 2 || centerIndex + 2 >= bars.length) return { up: false, down: false, confirmed: false };
  const center = bars[centerIndex];
  const left = bars.slice(centerIndex - 2, centerIndex), right = bars.slice(centerIndex + 1, centerIndex + 3);
  const up = left.every(b => Number(center.high) > Number(b.high)) && right.every(b => Number(center.high) > Number(b.high));
  const down = left.every(b => Number(center.low) < Number(b.low)) && right.every(b => Number(center.low) < Number(b.low));
  return { up, down, confirmed: true, centerIndex, confirmationIndex: centerIndex + 2, levelUp: up ? Number(center.high) : null, levelDown: down ? Number(center.low) : null };
}

export function evaluateFirstWilliamsFractalBreakout(input = {}) {
  const bars = input.bars || [];
  const timeZone = input.timeZone || 'America/New_York';
  const startMinute = Number(input.sessionStartMinute ?? 180);
  const endMinute = Number(input.sessionEndMinute ?? 1005);
  const stopAtrFraction = Number(input.stopAtrFraction ?? 0.25);
  const rewardRisk = Number(input.rewardRisk ?? 6);
  const reasons = [];
  if (!validBars(bars)) reasons.push('bars-invalid-or-not-strictly-ordered');
  if (!positive(input.dailyAtr)) reasons.push('completed-daily-atr-unavailable');
  if (input.dailyAtrSource !== 'completed-daily-candle') reasons.push('daily-atr-must-use-completed-daily-candle');
  if (!Number.isFinite(startMinute) || !Number.isFinite(endMinute) || startMinute < 0 || endMinute > 1440 || endMinute <= startMinute) reasons.push('session-window-invalid');
  if (!positive(stopAtrFraction) || !positive(rewardRisk)) reasons.push('stop-or-reward-risk-configuration-invalid');
  if (input.allBarsClosed !== true) reasons.push('closed-candles-not-confirmed');
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date()); } catch { reasons.push('session-timezone-invalid'); }
  if (reasons.length) return { strategyId: VIDEO_STRATEGY_IDS.FRACTAL_BREAKOUT, version: VIDEO_STRATEGY_VERSION, status: 'abstain', reasons, signals: [], paperOnly: true, liveExecutionAuthorized: false };

  const events = [];
  const daily = new Map();
  for (let i = 4; i < bars.length; i++) {
    const current = bars[i], stamp = asTime(current.timestamp), day = localDay(stamp, timeZone), minute = localMinute(stamp, timeZone);
    if (!daily.has(day)) daily.set(day, { firstUp: null, firstDown: null, tradedLong: false, tradedShort: false, closed: false });
    const state = daily.get(day);
    if (minute >= endMinute) {
      if (!state.closed) events.push({ type: 'session-close', day, timestamp: current.timestamp, action: 'flatten-paper-positions' });
      state.closed = true;
      continue;
    }
    if (minute < startMinute || state.closed) continue;
    // The fractal centered two bars ago only becomes knowable after the current bar closes.
    const fractal = confirmWilliamsFractal(bars.slice(0, i + 1), i - 2);
    const centerStamp = asTime(bars[i - 2].timestamp);
    if (fractal.up && !state.firstUp && localDay(centerStamp, timeZone) === day && localMinute(centerStamp, timeZone) >= startMinute) {
      state.firstUp = { level: fractal.levelUp, confirmedAt: current.timestamp, centerAt: bars[i - 2].timestamp };
      events.push({ type: 'fractal-confirmed', direction: 'long', day, ...state.firstUp });
    }
    if (fractal.down && !state.firstDown && localDay(centerStamp, timeZone) === day && localMinute(centerStamp, timeZone) >= startMinute) {
      state.firstDown = { level: fractal.levelDown, confirmedAt: current.timestamp, centerAt: bars[i - 2].timestamp };
      events.push({ type: 'fractal-confirmed', direction: 'short', day, ...state.firstDown });
    }
    const stopDistance = Number(input.dailyAtr) * stopAtrFraction;
    if (state.firstUp && !state.tradedLong && stamp > asTime(state.firstUp.confirmedAt) && Number(current.close) > state.firstUp.level) {
      const entry = Number(current.close), stopLoss = entry - stopDistance;
      state.tradedLong = true;
      events.push({ type: 'entry', direction: 'long', day, timestamp: current.timestamp, entry, stopLoss, takeProfit: entry + stopDistance * rewardRisk, riskDistance: round(stopDistance), rewardRisk, trigger: 'close-above-first-confirmed-up-fractal' });
    }
    if (state.firstDown && !state.tradedShort && stamp > asTime(state.firstDown.confirmedAt) && Number(current.close) < state.firstDown.level) {
      const entry = Number(current.close), stopLoss = entry + stopDistance;
      state.tradedShort = true;
      events.push({ type: 'entry', direction: 'short', day, timestamp: current.timestamp, entry, stopLoss, takeProfit: entry - stopDistance * rewardRisk, riskDistance: round(stopDistance), rewardRisk, trigger: 'close-below-first-confirmed-down-fractal' });
    }
  }
  const signals = events.filter(e => e.type === 'entry');
  return {
    strategyId: VIDEO_STRATEGY_IDS.FRACTAL_BREAKOUT, version: VIDEO_STRATEGY_VERSION,
    status: signals.length ? 'signal' : 'no-signal', signals, events,
    diagnostics: { timeZone, sessionStartMinute: startMinute, sessionEndMinute: endMinute, dailyAtr: Number(input.dailyAtr), stopAtrFraction, rewardRisk, daysProcessed: daily.size, maxEntriesPerDay: 2, maxEntriesPerDirectionPerDay: 1 },
    paperOnly: true, liveExecutionAuthorized: false
  };
}

export function evaluateVideoStrategyRisk(input = {}, policy = {}) {
  const violations = [];
  const equity = Number(input.equityUsd), riskPct = Number(input.riskPct), drawdown = Number(input.drawdownPct);
  const maxRiskPct = Number(policy.maxRiskPct ?? 0.25);
  if (!positive(equity)) violations.push('equity-missing-or-invalid');
  if (!positive(riskPct) || riskPct > maxRiskPct) violations.push('risk-per-trade-over-policy');
  if (!finite(drawdown) || drawdown >= Number(policy.maxDrawdownPct ?? 8)) violations.push('drawdown-limit');
  if (input.dailyLossLimitPassed !== true) violations.push('daily-loss-limit-not-cleared');
  if (input.eventRiskCleared !== true) violations.push('event-risk-not-cleared');
  if (input.executionCostsIncluded !== true) violations.push('spread-fees-slippage-not-accounted-for');
  if (input.strategyQualified !== true) violations.push('strategy-not-qualified');
  if (input.paperMode !== true) violations.push('paper-mode-required');
  const stopDistancePct = Number(input.stopDistancePct);
  if (!positive(stopDistancePct)) violations.push('stop-distance-invalid');
  const allowedForPaper = violations.length === 0;
  const riskUsd = allowedForPaper ? equity * riskPct / 100 : 0;
  const notionalCapUsd = allowedForPaper ? riskUsd / (stopDistancePct / 100) : 0;
  return { allowedForPaper, violations, riskUsd: round(riskUsd, 2), notionalCapUsd: round(notionalCapUsd, 2), maxRiskPct, liveExecutionAuthorized: false };
}

export function qualifyVideoStrategy(metrics = {}, policy = {}) {
  const reasons = [];
  if (Number(metrics.outOfSampleTrades) < Number(policy.minimumTrades ?? 100)) reasons.push('insufficient-out-of-sample-sample');
  if (!finite(metrics.netExpectancyR) || Number(metrics.netExpectancyR) <= 0) reasons.push('net-expectancy-not-positive');
  if (!finite(metrics.profitFactor) || Number(metrics.profitFactor) < Number(policy.minimumProfitFactor ?? 1.2)) reasons.push('profit-factor-below-threshold');
  if (!finite(metrics.maxDrawdownPct) || Number(metrics.maxDrawdownPct) > Number(policy.maximumDrawdownPct ?? 8)) reasons.push('drawdown-over-threshold');
  for (const key of ['spreadIncluded','commissionIncluded','slippageIncluded','swapIncluded','walkForwardPassed','paperForwardPassed']) if (metrics[key] !== true) reasons.push(`${key}-not-verified`);
  if (metrics.dataIntegrity !== 'verified') reasons.push('data-integrity-not-verified');
  if (metrics.randomBaselineCompared !== true) reasons.push('random-baseline-not-compared');
  if (metrics.parameterSensitivityPassed !== true) reasons.push('parameter-sensitivity-not-passed');
  return { qualified: reasons.length === 0, status: reasons.length ? 'research-or-quarantine' : 'eligible-for-controlled-paper-allocation', reasons, humanReviewRequired: true, liveExecutionAuthorized: false };
}
