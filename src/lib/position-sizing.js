// Spot/linear position sizing helpers: fixed-risk, ATR-volatility and capped fractional Kelly.
// Pure functions, no I/O. Futures margin and liquidation maths stay in futures-risk.js.

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const pos = (v) => { const x = num(v); return Number.isFinite(x) && x > 0 ? x : null; };
const nonNeg = (v) => { const x = num(v); return Number.isFinite(x) && x >= 0 ? x : null; };
const bad = (reason) => ({ valid: false, reason, quantity: 0, notional: 0, riskAmount: 0, riskPercent: 0, capped: [] });

export function floorToStep(quantity, step) {
  const q = pos(quantity), s = pos(step);
  if (q === null) return 0;
  if (s === null) return q;
  const decimals = Math.min(12, (String(s).split('.')[1] || '').length);
  return Number((Math.floor(q / s + 1e-9) * s).toFixed(decimals));
}

export function atrStop({ side, entry, atr, multiple = 2 } = {}) {
  const e = pos(entry), a = pos(atr), m = pos(multiple), sd = String(side || '').toLowerCase();
  if (e === null || a === null || m === null || !['long', 'short'].includes(sd)) return null;
  const stop = sd === 'long' ? e - a * m : e + a * m;
  return stop > 0 ? stop : null;
}

// Size so that a stop-out loses riskPercent of equity, fees on both legs included.
export function fixedRiskSize({ side = 'long', equity, riskPercent, entry, stop, feeBps = 0, lotStep, minQuantity, maxNotional, maxPositionPercent } = {}) {
  const eq = pos(equity), rp = pos(riskPercent), e = pos(entry), s = pos(stop), fee = nonNeg(feeBps);
  if (eq === null) return bad('Equity must be a positive number.');
  if (rp === null || rp > 100) return bad('Risk percent must be between 0 and 100.');
  if (e === null || s === null) return bad('Entry and stop must be positive numbers.');
  if (fee === null) return bad('Fee must be zero or positive.');
  const sd = String(side).toLowerCase();
  if (!['long', 'short'].includes(sd)) return bad('Side must be long or short.');
  if (sd === 'long' ? s >= e : s <= e) return bad(sd === 'long' ? 'Stop must be below entry for a long.' : 'Stop must be above entry for a short.');

  const perUnitRisk = Math.abs(e - s) + ((e + s) * fee) / 10000;
  const riskBudget = eq * rp / 100;
  let quantity = riskBudget / perUnitRisk;
  const capped = [];
  const maxN = pos(maxNotional), maxP = pos(maxPositionPercent);
  if (maxN !== null && quantity * e > maxN) { quantity = maxN / e; capped.push('maxNotional'); }
  if (maxP !== null && quantity * e > eq * maxP / 100) { quantity = (eq * maxP / 100) / e; capped.push('maxPositionPercent'); }
  quantity = floorToStep(quantity, lotStep);
  const minQ = pos(minQuantity);
  if (quantity <= 0 || (minQ !== null && quantity < minQ)) return { ...bad('Risk budget is too small for the minimum order size.'), capped };
  const riskAmount = quantity * perUnitRisk;
  return { valid: true, reason: null, side: sd, quantity, notional: quantity * e, riskAmount, riskPercent: riskAmount / eq * 100, perUnitRisk, capped };
}

export function volatilitySize({ side = 'long', equity, riskPercent, entry, atr, atrMultiple = 2, ...rest } = {}) {
  const stop = atrStop({ side, entry, atr, multiple: atrMultiple });
  if (stop === null) return bad('ATR stop could not be derived from entry, ATR and multiple.');
  return { ...fixedRiskSize({ side, equity, riskPercent, entry, stop, ...rest }), stop };
}

// Kelly fraction f* = p - (1 - p) / b, with p = win rate and b = average win / average loss.
export function kellyFraction({ winRate, payoffRatio } = {}) {
  const p = num(winRate), b = pos(payoffRatio);
  if (!Number.isFinite(p) || p < 0 || p > 1 || b === null) return null;
  return p - (1 - p) / b;
}

// Conservative risk percent from realised stats: fractional Kelly, hard-capped, zero without edge or sample.
export function kellyRiskPercent({ winRate, payoffRatio, trades, minTrades = 30, fraction = 0.25, maxRiskPercent = 2 } = {}) {
  const k = kellyFraction({ winRate, payoffRatio });
  if (k === null) return { riskPercent: 0, reason: 'Win rate (0-1) and payoff ratio (>0) are required.', kelly: null };
  if (!(num(trades) >= minTrades)) return { riskPercent: 0, reason: `Needs at least ${minTrades} closed trades for a reliable estimate.`, kelly: k };
  if (k <= 0) return { riskPercent: 0, reason: 'No positive edge in the supplied statistics.', kelly: k };
  const f = Math.min(Math.max(num(fraction) || 0.25, 0), 1);
  const riskPercent = Math.min(k * f * 100, pos(maxRiskPercent) ?? 2);
  return { riskPercent, reason: null, kelly: k };
}
