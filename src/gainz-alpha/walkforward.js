// Rolling walk-forward optimisation on top of the live-engine backtest.
// For each window: pick the best candidate on the TRAIN span only, skip an embargo gap, then measure that
// single choice on the following unseen TEST span. Only out-of-sample trades enter the final statistics.
import { runBacktest } from './backtest.js';
import { normalizeCandles, timeframeMs } from './indicators.js';
import { summarize } from './learning.js';
import { monteCarloDrawdown } from './montecarlo.js';

export const DEFAULT_GRID = Object.freeze([
  { id: 'balanced', preset: 'balanced' },
  { id: 'alpha', preset: 'alpha' },
  { id: 'precision', preset: 'precision' }
]);

const WARMUP = 60; // runBacktest needs this many bars of history before its first signal
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const round = (v, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

function withCosts(overrides = {}, spreadPct, slippagePct) {
  const costs = { ...(overrides.costs || {}) };
  if (Number.isFinite(spreadPct)) costs.spreadPct = spreadPct;
  if (Number.isFinite(slippagePct)) costs.slippagePct = slippagePct;
  return { ...overrides, costs };
}

/**
 * Verdict from out-of-sample results only.
 *  insufficient: fewer than 30 out-of-sample trades; failing: expectancy not positive;
 *  robust: expectancy > 0, at least 60% of traded windows positive, and efficiency (out-of-sample over training
 *  expectancy) at least 0.5 when training expectancy was positive; fragile: positive but fails those checks.
 */
export function walkForwardVerdict({ trades, expectancy, positiveShare, efficiency }) {
  if (!(trades >= 30)) return 'insufficient';
  if (!(expectancy > 0)) return 'failing';
  if (positiveShare >= 0.6 && (efficiency === null || efficiency === undefined || efficiency >= 0.5)) return 'robust';
  return 'fragile';
}

/** Minimum number of candles needed for a single walk-forward window. */
export const minimumBars = ({ trainBars = 400, testBars = 150, maxHold = 24 } = {}) => WARMUP + trainBars + maxHold + testBars + 1;

/**
 * @param candles  [[ts, open, high, low, close, volume], ...] oldest first
 * @param options  symbol, timeframe, grid, trainBars, testBars, stepBars, window, maxHold, minTrainTrades,
 *                 feePct, spreadPct, slippagePct, higherTimeframes, monteCarlo
 */
export function rollingWalkForward(candles, options = {}) {
  const {
    symbol = 'unknown', timeframe = '1h', grid = DEFAULT_GRID, trainBars = 400, testBars = 150,
    window = 250, maxHold = 24, minTrainTrades = 15, feePct = 0.0005, spreadPct, slippagePct,
    higherTimeframes = [], monteCarlo = {}
  } = options;
  if (!timeframeMs(timeframe)) return { status: 'error', reason: 'unknown timeframe ' + timeframe };
  if (!Array.isArray(grid) || !grid.length) return { status: 'error', reason: 'grid needs at least one candidate' };
  const ids = grid.map((c) => c?.id);
  if (ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) return { status: 'error', reason: 'every candidate needs a unique string id' };
  if (!Number.isFinite(trainBars) || trainBars < 100 || !Number.isFinite(testBars) || testBars < 30) return { status: 'error', reason: 'trainBars must be >= 100 and testBars >= 30' };

  // Overlapping test spans would count the same trades twice, so the step is never smaller than the test span.
  const stepBars = Math.max(testBars, Number.isFinite(options.stepBars) ? options.stepBars : testBars);
  const embargo = maxHold; // trades opened late in training can still be open this many bars later
  const rows = normalizeCandles(candles);
  const needed = minimumBars({ trainBars, testBars, maxHold });
  if (rows.length < needed) return { status: 'insufficient', reason: 'Need at least ' + needed + ' candles for one window, got ' + rows.length, needed, bars: rows.length };

  const base = { symbol, timeframe, feePct, window, maxHold, higherTimeframes };
  const run = (preset, overrides, upTo, startIndex) => runBacktest(rows.slice(0, upTo + 1), { ...base, preset, overrides: withCosts(overrides, spreadPct, slippagePct), startIndex });

  const windows = [], oosTrades = [], chosenTrainExpectancy = [];
  const selections = Object.fromEntries(grid.map((c) => [c.id, 0]));
  for (let start = WARMUP; ; start += stepBars) {
    const trainEnd = start + trainBars, testStart = trainEnd + embargo, testEnd = testStart + testBars;
    if (testEnd > rows.length - 1) break;

    const scoreboard = grid.map((candidate) => {
      const bt = run(candidate.preset || 'balanced', candidate.overrides, trainEnd, start);
      return { id: candidate, trades: bt.summary?.n ?? 0, expectancy: bt.summary?.expectancy ?? null, winRate: bt.summary?.winRate ?? null };
    }).map((row) => ({ ...row, id: row.id.id }));
    const eligible = scoreboard.filter((row) => row.trades >= minTrainTrades && row.expectancy !== null);
    const window_ = {
      index: windows.length + 1,
      train: { fromTs: rows[start][0], toTs: rows[trainEnd][0], scoreboard },
      test: { fromTs: rows[testStart][0], toTs: rows[testEnd][0] }
    };
    if (!eligible.length) {
      windows.push({ ...window_, chosen: null, skipped: 'no-candidate-reached-' + minTrainTrades + '-training-trades', test: { ...window_.test, trades: 0, expectancy: null, winRate: null } });
      continue;
    }
    eligible.sort((a, b) => b.expectancy - a.expectancy || b.trades - a.trades);
    const chosen = grid.find((c) => c.id === eligible[0].id);
    selections[chosen.id]++;
    chosenTrainExpectancy.push(eligible[0].expectancy);

    const bt = run(chosen.preset || 'balanced', chosen.overrides, testEnd, testStart);
    const trades = (bt.trades || []).map((t) => ({ ...t, window: window_.index, candidate: chosen.id }));
    oosTrades.push(...trades);
    windows.push({ ...window_, chosen: chosen.id, test: { ...window_.test, trades: trades.length, expectancy: bt.summary?.expectancy ?? null, winRate: bt.summary?.winRate ?? null } });
  }

  const summary = summarize(oosTrades, {});
  const withTrades = windows.filter((w) => w.test.trades > 0);
  const positive = withTrades.filter((w) => w.test.expectancy > 0).length;
  const positiveShare = withTrades.length ? positive / withTrades.length : null;
  const trainMean = mean(chosenTrainExpectancy);
  const efficiency = trainMean > 0 && summary.expectancy !== null ? summary.expectancy / trainMean : null;
  const picks = Object.values(selections), totalPicks = picks.reduce((s, v) => s + v, 0);

  const verdict = walkForwardVerdict({ trades: summary.n, expectancy: summary.expectancy, positiveShare, efficiency });

  return {
    status: 'ok', symbol, timeframe, windows,
    oos: { summary, trades: oosTrades },
    metrics: {
      windows: windows.length, windowsWithTrades: withTrades.length,
      positiveWindowShare: round(positiveShare), trainExpectancy: round(trainMean), oosExpectancy: summary.expectancy,
      walkForwardEfficiency: round(efficiency),
      parameterStability: totalPicks ? round(Math.max(...picks) / totalPicks) : null, selections
    },
    monteCarlo: monteCarloDrawdown(oosTrades.map((t) => t.returnR), { seed: 1, ...monteCarlo }),
    verdict,
    verdictRules: {
      insufficient: 'fewer than 30 out-of-sample trades',
      failing: 'out-of-sample expectancy is not positive',
      robust: 'positive out-of-sample expectancy, at least 60% of windows positive, and out-of-sample expectancy at least half of training expectancy',
      fragile: 'positive out-of-sample expectancy that fails the robust checks'
    },
    assumptions: {
      selection: 'best training expectancy among candidates with at least ' + minTrainTrades + ' trades',
      trainBars, testBars, stepBars, embargoBars: embargo, maxHoldBars: maxHold, feePct,
      spreadPct: Number.isFinite(spreadPct) ? spreadPct : 'preset default', slippagePct: Number.isFinite(slippagePct) ? slippagePct : 'preset default',
      lookahead: 'none: training and test series are cut at the window end, entries use the next bar open, same-bar stop and target resolve stop-first'
    }
  };
}
