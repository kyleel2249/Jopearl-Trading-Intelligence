// Shared, fail-closed qualification policy for every JPTI agent and bot.
// Historical results alone can never authorize live execution.
const finite = value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const pass = (id, ok, detail, actual = null, target = null) => ({ id, passed: Boolean(ok), detail, actual, target });

export const VALIDATION_POLICY = Object.freeze({
  version: '1.0.0',
  backtest: { minimumTrades: 100, minimumProfitFactor: 1.2, maximumDrawdownPct: 10, requirePositiveNetPnl: true },
  outOfSample: { minimumTrades: 30, requirePositiveNetPnl: true },
  walkForward: { minimumWindows: 3, minimumPositiveRatio: 0.6 },
  replay: { requireChronological: true, requireNoLookahead: true, requireVerifiedData: true },
  forward: { minimumPaperTrades: 30, minimumObservationDays: 14, minimumProfitFactor: 1.1, maximumDrawdownPct: 5, maximumRiskBreaches: 0 },
  live: { enabled: false }
});

export function evaluateTradingValidation(input = {}, policy = VALIDATION_POLICY) {
  const backtest = input.backtest || {}, oos = input.outOfSample || {}, wf = input.walkForward || {};
  const replay = input.replay || {}, forward = input.forward || {}, risk = input.risk || {};
  const checks = [];
  const btTrades = finite(backtest.closedTrades), btPf = finite(backtest.profitFactor);
  const btDd = finite(backtest.maxDrawdownPct), btPnl = finite(backtest.netPnl);
  checks.push(pass('backtest_sample', btTrades !== null && btTrades >= policy.backtest.minimumTrades, 'Backtest must contain the minimum number of closed trades.', btTrades, policy.backtest.minimumTrades));
  checks.push(pass('backtest_profit_factor', btPf !== null && btPf >= policy.backtest.minimumProfitFactor, 'Backtest profit factor is below the qualification threshold.', btPf, policy.backtest.minimumProfitFactor));
  checks.push(pass('backtest_drawdown', btDd !== null && btDd >= 0 && btDd <= policy.backtest.maximumDrawdownPct, 'Backtest drawdown must be known and within the configured cap.', btDd, policy.backtest.maximumDrawdownPct));
  checks.push(pass('backtest_net_profit', !policy.backtest.requirePositiveNetPnl || btPnl !== null && btPnl > 0, 'Backtest net PnL must be positive.', btPnl, '> 0'));

  const oosTrades = finite(oos.closedTrades), oosPnl = finite(oos.netPnl);
  checks.push(pass('out_of_sample_sample', oosTrades !== null && oosTrades >= policy.outOfSample.minimumTrades, 'Untouched out-of-sample segment must have enough closed trades.', oosTrades, policy.outOfSample.minimumTrades));
  checks.push(pass('out_of_sample_profit', !policy.outOfSample.requirePositiveNetPnl || oosPnl !== null && oosPnl > 0, 'Out-of-sample net PnL must be positive.', oosPnl, '> 0'));

  const windows = finite(wf.windows), positiveWindows = finite(wf.positiveWindows);
  const ratio = windows > 0 && positiveWindows !== null ? positiveWindows / windows : null;
  checks.push(pass('walk_forward_windows', Number.isInteger(windows) && windows >= policy.walkForward.minimumWindows && Number.isInteger(positiveWindows) && positiveWindows >= 0 && positiveWindows <= windows, 'Walk-forward evidence must contain valid rolling windows.', windows, policy.walkForward.minimumWindows));
  checks.push(pass('walk_forward_stability', ratio !== null && ratio >= policy.walkForward.minimumPositiveRatio, 'The required share of walk-forward windows must be profitable.', ratio, policy.walkForward.minimumPositiveRatio));

  checks.push(pass('replay_chronology', !policy.replay.requireChronological || replay.chronological === true, 'Replay must use strictly chronological data.'));
  checks.push(pass('replay_no_lookahead', !policy.replay.requireNoLookahead || replay.lookaheadBias === false, 'Replay must explicitly attest that no future data was used.'));
  checks.push(pass('replay_data_quality', !policy.replay.requireVerifiedData || replay.dataQuality === 'verified', 'Replay data quality must be verified, not assumed.'));

  const paperTrades = finite(forward.closedPaperTrades), days = finite(forward.observationDays);
  const paperPf = finite(forward.profitFactor), paperDd = finite(forward.maxDrawdownPct), breaches = finite(forward.riskBreaches);
  checks.push(pass('forward_sample', paperTrades !== null && paperTrades >= policy.forward.minimumPaperTrades, 'Live-market paper test must contain enough closed trades.', paperTrades, policy.forward.minimumPaperTrades));
  checks.push(pass('forward_duration', days !== null && days >= policy.forward.minimumObservationDays, 'Live-market paper test must span the minimum observation period.', days, policy.forward.minimumObservationDays));
  checks.push(pass('forward_profit_factor', paperPf !== null && paperPf >= policy.forward.minimumProfitFactor, 'Forward paper profit factor must meet the minimum.', paperPf, policy.forward.minimumProfitFactor));
  checks.push(pass('forward_drawdown', paperDd !== null && paperDd >= 0 && paperDd <= policy.forward.maximumDrawdownPct, 'Forward paper drawdown must remain within the cap.', paperDd, policy.forward.maximumDrawdownPct));
  checks.push(pass('forward_risk_breaches', breaches === policy.forward.maximumRiskBreaches, 'Forward paper testing must have zero risk-policy breaches.', breaches, policy.forward.maximumRiskBreaches));

  checks.push(pass('risk_controls', risk.preTradePassed === true && risk.dailyLossGuard === true && risk.drawdownGuard === true && risk.killSwitchTested === true, 'Independent pre-trade, daily-loss, drawdown and kill-switch tests must all pass.'));
  const failedChecks = checks.filter(item => !item.passed).map(item => item.id);
  const eligibleForPaper = failedChecks.length === 0;
  return {
    policyVersion: policy.version,
    evaluatedAt: new Date().toISOString(),
    status: eligibleForPaper ? 'paper_qualification_candidate' : 'research_only',
    checks, failedChecks, passedChecks: checks.length - failedChecks.length,
    permissions: {
      research: true, historicalBacktest: true, replay: true, paperTrading: true,
      paperQualificationCandidate: eligibleForPaper,
      liveTrading: false, liveOrders: false, autonomousRiskOverride: false
    },
    decision: eligibleForPaper ? 'HUMAN_REVIEW_REQUIRED' : 'BLOCKED_PENDING_EVIDENCE',
    note: 'This is a qualification assessment, not a profitability guarantee or live-trading authorization.'
  };
}

export function agentExecutionGate(validation, { requestedMode = 'paper' } = {}) {
  const valid = validation && validation.status === 'paper_qualification_candidate' && Array.isArray(validation.failedChecks) && validation.failedChecks.length === 0;
  if (requestedMode === 'live') return { allowed: false, mode: 'blocked', reason: 'Autonomous live execution is disabled by policy.', liveOrders: false };
  return { allowed: requestedMode === 'research' || requestedMode === 'backtest' || requestedMode === 'replay' || requestedMode === 'paper' && Boolean(valid),
    mode: requestedMode === 'paper' && !valid ? 'research_only' : requestedMode,
    reason: requestedMode === 'paper' && !valid ? 'Paper entry blocked until the unified validation gate passes.' : null,
    liveOrders: false };
}
