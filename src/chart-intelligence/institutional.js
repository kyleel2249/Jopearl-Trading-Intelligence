// Normalise cross-domain institutional evidence before it reaches the chart decision engine.
// Only timestamped, source-attributed observations are scored. Missing or stale inputs remain unavailable.
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const finite = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const signed = (v, scale) => finite(v) ? clamp(Number(v) / scale, -1, 1) : null;
const round = (v, n = 3) => Number.isFinite(v) ? Number(v.toFixed(n)) : null;

export function scoreInstitutionalContext(context, { now = Date.now(), maxAgeMs = 30 * 60 * 1000 } = {}) {
  if (!context || typeof context !== 'object') return { status: 'unavailable', score: 0, confidence: 0, evidence: [], sources: [], reason: 'No institutional context supplied' };
  const generatedAt = Date.parse(context.generatedAt || context.observedAt || '');
  const ageMs = Number.isFinite(generatedAt) ? Math.max(0, now - generatedAt) : null;
  const sourceRows = Array.isArray(context.sources) ? context.sources : [];
  const liveSources = sourceRows.filter((s) => s && s.status === 'live').length;
  const knownSources = sourceRows.filter((s) => s && typeof s.name === 'string').length;
  if (ageMs == null || ageMs > maxAgeMs) return {
    status: 'stale', score: 0, confidence: 0, ageMs, sourceCoverage: knownSources ? liveSources / knownSources : 0,
    evidence: [], sources: sourceRows, reason: ageMs == null ? 'Source timestamp missing' : 'Institutional context exceeded freshness limit'
  };
  const evidence = [];
  const add = (factor, value, weight, basis) => {
    if (!Number.isFinite(value)) return;
    evidence.push({ factor, value: round(clamp(value, -1, 1)), weight, contribution: round(clamp(value, -1, 1) * weight), basis });
  };
  const rawScore = context.score && finite(context.score.score) ? Number(context.score.score) : null;
  add('exchange-and-global-context', rawScore == null ? NaN : Math.abs(rawScore) > 1.5 ? rawScore / 100 : rawScore, 0.38, 'existing JPTI multi-factor market-context score');
  const market = context.market || {}, broad = context.broadContext || {};
  add('global-crypto-risk', signed(broad.globalMarketCapChange24hPct, 3), 0.16, 'aggregate global market-cap change');
  add('local-momentum', signed(market.priceChangePct, 3), 0.12, 'exchange closed-candle momentum');
  add('order-book-pressure', signed(market.orderBookImbalancePct, 100), 0.14, 'exchange order-book depth imbalance');
  const funding = finite(market.fundingRate) ? Number(market.fundingRate) : null;
  add('funding-crowding', funding == null ? NaN : clamp(-funding / 0.001, -1, 1), 0.08, 'perpetual funding, contrarian crowding adjustment');
  const mtf = Array.isArray(context.multiTimeframe) ? context.multiTimeframe.filter((x) => x && finite(x.bias)) : [];
  if (mtf.length) add('institutional-context-mtf', mtf.reduce((sum, x) => sum + Number(x.bias), 0) / mtf.length, 0.12, 'timeframe-aligned exchange context');
  const usedWeight = evidence.reduce((sum, x) => sum + x.weight, 0);
  const raw = usedWeight ? evidence.reduce((sum, x) => sum + x.contribution, 0) / usedWeight : 0;
  const coverage = knownSources ? liveSources / knownSources : (evidence.length ? 0.5 : 0);
  const freshness = clamp(1 - ageMs / maxAgeMs, 0, 1);
  const completeness = clamp(usedWeight, 0, 1);
  const confidence = round(clamp(coverage * 0.45 + freshness * 0.25 + completeness * 0.30, 0, 1));
  const available = evidence.length > 0 && (!knownSources || liveSources > 0);
  return { status: available ? 'ready' : 'unavailable', score: available ? round(raw) : 0, confidence: available ? confidence : 0, ageMs, sourceCoverage: round(coverage), evidence, sources: sourceRows, limitations: Array.isArray(context.limitations) ? context.limitations : [], generatedAt: context.generatedAt || null, reason: available ? null : 'No live corroborating source is available', method: 'Timestamp-gated weighted evidence; missing sources are excluded and remaining weights are renormalised' };
}
