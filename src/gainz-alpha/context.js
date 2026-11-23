import { getHub } from './hub.js';

/** Fields that let the Alpha API weigh GainzAlpha with this user's own recorded outcomes for exactly this context. */
export function gainzAlphaContext(symbol, timeframe) {
  const hub = getHub(), st = hub.getState();
  const sym = String(symbol || '').toUpperCase();
  return {
    gainzPreset: hub.getSettings().preset,
    gainzOutcomes: st.outcomes.filter((r) => String(r.symbol).toUpperCase() === sym && r.timeframe === timeframe).slice(-2000),
    gainzModel: { version: st.model.version, weights: st.model.weights, dispAdjust: st.model.dispAdjust }
  };
}
