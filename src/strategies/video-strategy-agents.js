import {
  evaluateMa44332Strategy, evaluateFirstWilliamsFractalBreakout, VIDEO_STRATEGY_IDS, VIDEO_STRATEGY_VERSION
} from './video-derived-strategies.js';

// Strategy-specialist roster. Baselines remain independent; optional variants are explicit.
export const VIDEO_STRATEGY_AGENTS = Object.freeze([
  Object.freeze({ id: 'ma-44-332-trend-specialist', name: 'Aurelius', strategyId: VIDEO_STRATEGY_IDS.MA_CROSSOVER, role: 'trend-crossover-validation', style: 'day-trading-to-swing', baseline: true, executionPermission: 'paper-only' }),
  Object.freeze({ id: 'first-fractal-breakout-specialist', name: 'Pythia', strategyId: VIDEO_STRATEGY_IDS.FRACTAL_BREAKOUT, role: 'session-breakout-validation', style: 'intraday', baseline: true, executionPermission: 'paper-only' }),
  Object.freeze({ id: 'ma-fractal-confluence-researcher', name: 'Concord', strategyId: 'ma-fractal-confluence-variant', role: 'independent-confirmation-research', style: 'intraday', baseline: false, executionPermission: 'paper-only' })
]);

export function evaluateVideoStrategyAgents(input = {}) {
  const ma = evaluateMa44332Strategy(input.ma || {});
  const fractal = evaluateFirstWilliamsFractalBreakout(input.fractal || {});
  const maDirection = ma.signal?.direction || null;
  const matchingFractalSignals = (fractal.signals || []).filter(signal => signal.direction === maDirection);
  const confluence = ma.status === 'signal' && matchingFractalSignals.length
    ? { status: 'research-candidate', direction: maDirection, matchingSignals: matchingFractalSignals, note: 'Separate MA and fractal baselines agree; this is a research variant, not a baseline signal.' }
    : { status: 'no-confluence', direction: null, matchingSignals: [], note: 'No same-direction confirmed signal from both independent baselines.' };
  return {
    generatedAt: new Date(Number(input.now) || Date.now()).toISOString(),
    version: VIDEO_STRATEGY_VERSION,
    agents: [
      { ...VIDEO_STRATEGY_AGENTS[0], status: ma.status, result: ma, canSubmitOrders: false },
      { ...VIDEO_STRATEGY_AGENTS[1], status: fractal.status, result: fractal, canSubmitOrders: false },
      { ...VIDEO_STRATEGY_AGENTS[2], status: confluence.status, result: confluence, canSubmitOrders: false }
    ],
    baselineIsolation: true,
    paperOnly: true,
    liveExecutionAuthorized: false
  };
}
