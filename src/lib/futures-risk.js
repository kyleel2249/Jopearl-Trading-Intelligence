// Product-aware sizing, margin and liquidation-distance gate for directional trades.
// Liquidation figures are ISOLATED-MARGIN ESTIMATES from the standard closed forms; they ignore fees,
// funding, tiered maintenance margin and exchange-specific liquidation fees. They support review of a
// plan; they never replace the exchange's own liquidation price.
export const DEFAULT_LIMITS = { maxRiskPercent: 2, maxLeverage: 20, maxMarginUtilizationPercent: 50, minLiquidationBufferRatio: 1.5 };
const MODELS = {
  spot: { kind: 'cash' },
  margin: { kind: 'linear', liquidation: false },
  futures: { kind: 'linear', liquidation: true },
  'usdc-futures': { kind: 'linear', liquidation: true },
  'coin-futures': { kind: 'inverse', liquidation: true }
};
const num = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));
const positive = (value) => { const n = num(value); return n !== null && n > 0 ? n : null; };

export function liquidationPrice({ kind, side, entry, leverage, mmr }) {
  if (!(entry > 0) || !(leverage >= 1) || !(mmr >= 0)) return null;
  if (kind === 'linear') return side === 'long' ? entry * (1 - 1 / leverage + mmr) : entry * (1 + 1 / leverage - mmr);
  if (kind === 'inverse') {
    if (side === 'long') return (entry * (1 + mmr) * leverage) / (1 + leverage);
    return leverage <= 1 ? null : (entry * (1 - mmr) * leverage) / (leverage - 1);
  }
  return null;
}

// Highest leverage (within [1, cap]) that still keeps the liquidation price beyond the stop by the buffer.
export function safeMaxLeverage({ kind, side, entry, stop, mmr, minBuffer, cap }) {
  const stopDistance = Math.abs(entry - stop);
  const ok = (leverage) => {
    const liq = liquidationPrice({ kind, side, entry, leverage, mmr });
    if (liq === null) return true;
    const beyond = side === 'long' ? liq < stop : liq > stop;
    return beyond && Math.abs(entry - liq) / stopDistance >= minBuffer;
  };
  if (!ok(1)) return null;
  let lo = 1, hi = Math.max(1, cap);
  if (ok(hi)) return hi;
  for (let i = 0; i < 60; i += 1) { const mid = (lo + hi) / 2; if (ok(mid)) lo = mid; else hi = mid; }
  return Math.floor(lo * 100) / 100;
}

export function evaluateFuturesRisk(input = {}) {
  const product = String(input.product || 'futures');
  const model = MODELS[product];
  const requestedLimit = (key) => {
    const value = positive(input.limits?.[key]);
    return value === null ? DEFAULT_LIMITS[key] : value;
  };
  // Caller settings may tighten policy, never relax the hard safety ceilings.
  const limits = {
    maxRiskPercent: Math.min(DEFAULT_LIMITS.maxRiskPercent, requestedLimit('maxRiskPercent')),
    maxLeverage: Math.min(DEFAULT_LIMITS.maxLeverage, requestedLimit('maxLeverage')),
    maxMarginUtilizationPercent: Math.min(DEFAULT_LIMITS.maxMarginUtilizationPercent, requestedLimit('maxMarginUtilizationPercent')),
    minLiquidationBufferRatio: Math.max(DEFAULT_LIMITS.minLiquidationBufferRatio, requestedLimit('minLiquidationBufferRatio'))
  };
  const assumptions = ['Isolated-margin estimate; fees, funding and tiered maintenance margin are not modelled in the liquidation price.'];
  if (product === 'cfd') return { decision: 'unsupported', supported: false, product, checks: [], assumptions, reason: 'CFD sizing needs the instrument contract specification (lot size, pip value, margin), which the market feed does not supply. No figures were produced.' };
  if (!model) return { decision: 'unsupported', supported: false, product, checks: [], assumptions, reason: 'Unknown product "' + product + '".' };

  const sideInput = String(input.side || 'long').toLowerCase();
  const side = sideInput === 'short' || sideInput === 'long' ? sideInput : 'invalid';
  const entry = positive(input.entry), stop = positive(input.stop), equity = positive(input.equity);
  const riskPercent = positive(input.riskPercent);
  const leverage = model.kind === 'cash' ? 1 : positive(input.leverage);
  const rawFeeBps = input.takerFeeBps == null ? 6 : num(input.takerFeeBps);
  const rawMmr = input.maintenanceMarginRate == null ? 0.005 : num(input.maintenanceMarginRate);
  const feeAssumptionValid = rawFeeBps !== null && rawFeeBps >= 0 && rawFeeBps <= 1000;
  const mmrAssumptionValid = rawMmr !== null && rawMmr >= 0 && rawMmr <= 0.2;
  const feeRate = feeAssumptionValid ? rawFeeBps / 10000 : 0;
  const mmr = mmrAssumptionValid ? rawMmr : 0.005;
  const checks = [];
  const check = (id, passed, detail) => checks.push({ id, passed: Boolean(passed), detail });

  check('valid_inputs', entry && stop && equity && riskPercent && leverage && leverage >= 1 && ['long', 'short'].includes(side), 'Entry, stop, equity, risk %, a valid long/short side and (for leveraged products) leverage of at least 1 are required.');
  check('cost_assumptions', feeAssumptionValid && mmrAssumptionValid, 'Taker fees must be 0–1,000 bps and maintenance margin must be 0–20%.');
  if (!checks[0].passed || !checks[1].passed) return finish({ product, side, checks, assumptions, sizing: null, liquidation: null });
  if (!checks[0].passed) return { decision: 'blocked', supported: true, product, side, checks, assumptions, sizing: null, liquidation: null };
  const stopOnCorrectSide = side === 'long' ? stop < entry : stop > entry;
  check('stop_side', stopOnCorrectSide, side === 'long' ? 'A long needs its stop below entry.' : 'A short needs its stop above entry.');
  if (!stopOnCorrectSide) return { decision: 'blocked', supported: true, product, side, checks, assumptions, sizing: null, liquidation: null };

  const riskAmount = equity * riskPercent / 100;
  let quantity, notional, initialMargin, quantityUnit;
  if (model.kind === 'inverse') {
    // Equity and PnL are in the base coin; notional is in USD contracts.
    const perUsd = Math.abs(1 / stop - 1 / entry) + feeRate * (1 / entry + 1 / stop);
    quantity = riskAmount / perUsd; notional = quantity; initialMargin = quantity / (entry * leverage); quantityUnit = 'USD contracts';
    assumptions.push('Coin-M: equity and risk are in the margin coin (for example BTC); notional is in USD contracts.');
  } else {
    const perUnit = Math.abs(entry - stop) + feeRate * (entry + stop);
    quantity = riskAmount / perUnit; notional = quantity * entry; initialMargin = notional / leverage; quantityUnit = 'base units';
  }
  const marginUtilization = (initialMargin / equity) * 100;
  const sizingIsFinite = [riskAmount, quantity, notional, initialMargin, marginUtilization].every(Number.isFinite)
    && [riskAmount, quantity, notional, initialMargin].every(value => value > 0);
  check('finite_sizing', sizingIsFinite, 'Risk, quantity, notional and margin calculations must remain finite and positive.');
  if (!sizingIsFinite) return finish({ product, side, checks, assumptions, sizing: null, liquidation: null });
  const sizing = { riskAmount, quantity, quantityUnit, notional, initialMargin, marginUtilizationPercent: marginUtilization, leverage };

  check('risk_budget', riskPercent <= limits.maxRiskPercent, 'Risk of ' + riskPercent + '% must not exceed ' + limits.maxRiskPercent + '% of equity.');
  if (model.kind === 'cash') {
    check('cash_available', notional <= equity, 'Spot position cost must not exceed available equity.');
    return finish({ product, side, sizing, liquidation: null, checks, assumptions });
  }
  check('leverage_cap', leverage <= limits.maxLeverage, 'Leverage ' + leverage + 'x must not exceed ' + limits.maxLeverage + 'x.');
  check('margin_utilization', marginUtilization <= limits.maxMarginUtilizationPercent, 'Initial margin is ' + marginUtilization.toFixed(1) + '% of equity (cap ' + limits.maxMarginUtilizationPercent + '%).');

  let liquidation = null;
  if (model.liquidation) {
    const price = liquidationPrice({ kind: model.kind, side, entry, leverage, mmr });
    if (price === null) {
      liquidation = { price: null, note: 'No liquidation price applies at this leverage for a short coin-margined position.' };
      check('liquidation_buffer', true, 'No liquidation level applies.');
    } else {
      const beyondStop = side === 'long' ? price < stop : price > stop;
      const bufferRatio = Math.abs(entry - price) / Math.abs(entry - stop);
      liquidation = { price, distancePercent: (Math.abs(entry - price) / entry) * 100, bufferRatio, beyondStop, safeMaxLeverage: safeMaxLeverage({ kind: model.kind, side, entry, stop, mmr, minBuffer: limits.minLiquidationBufferRatio, cap: limits.maxLeverage }) };
      check('liquidation_buffer', beyondStop && bufferRatio >= limits.minLiquidationBufferRatio, beyondStop ? 'Liquidation is ' + bufferRatio.toFixed(2) + 'x the stop distance away (need ' + limits.minLiquidationBufferRatio + 'x).' : 'Liquidation would trigger before the stop is reached.');
    }
  } else {
    liquidation = { price: null, note: 'Margin liquidation depends on account-wide margin level; no estimate is produced.' };
    assumptions.push('Margin: sizing and leverage checks only; liquidation is not estimated.');
  }
  const target = positive(input.target);
  const rewardRisk = target && (side === 'long' ? target > entry : target < entry) ? Math.abs(target - entry) / Math.abs(entry - stop) : null;
  return finish({ product, side, sizing, liquidation, checks, assumptions, rewardRisk });
}

function finish(result) {
  const failed = result.checks.filter((c) => !c.passed).map((c) => c.id);
  return { ...result, supported: true, failedChecks: failed, decision: failed.length ? 'blocked' : 'eligible' };
}
