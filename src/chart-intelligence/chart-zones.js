// Price bands used by the shared SVG chart overlay. These are visual tolerances,
// not claims about resting exchange orders or guaranteed execution prices.
const finite = value => Number.isFinite(Number(value));
const positive = value => finite(value) && Number(value) > 0;

export function buildLiquidityZones(items = [], atr, widthAtr = 0.07) {
  if (!positive(atr)) return [];
  return (Array.isArray(items) ? items : []).filter(item => positive(item?.price))
    .map((item, index) => {
      const halfWidth = Number(atr) * widthAtr;
      return { ...item, id: item.id || 'liquidity-zone-' + index, top: Number(item.price) + halfWidth, bottom: Number(item.price) - halfWidth, bandBasis: 'ATR-scaled visual tolerance' };
    });
}

export function buildTargetZones(plan, atr) {
  if (!plan || !positive(plan.entry) || !positive(plan.stopLoss)) return [];
  const risk = Math.abs(Number(plan.entry) - Number(plan.stopLoss));
  if (!positive(risk)) return [];
  return (Array.isArray(plan.targets) ? plan.targets : []).slice(0, 3)
    .filter(target => positive(target?.price))
    .map((target, index) => {
      const halfWidth = Math.max((positive(atr) ? Number(atr) : 0) * 0.045, risk * 0.035, Math.abs(Number(target.price)) * 0.00002);
      return { ...target, name: target.name || 'TP' + (index + 1), index: index + 1, top: Number(target.price) + halfWidth, bottom: Number(target.price) - halfWidth, bandBasis: 'ATR/risk-scaled target tolerance' };
    });
}
