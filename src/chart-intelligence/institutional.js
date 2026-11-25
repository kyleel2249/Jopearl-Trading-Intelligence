// Normalise cross-domain institutional evidence before it reaches the chart decision engine.
// Only timestamped, source-attributed observations are scored. Missing or stale inputs remain unavailable.
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const finite = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const signed = (v, scale) => finite(v) ? clamp(Number(v) / scale, -1, 1) : null;
const round = (v, n = 3) => Number.isFinite(v) ? Number(v.toFixed(n)) : null;

export function scoreInstitutionalContext(context, { now = Date.now(), maxAgeMs = 30 * 60 * 1000 } = {}) {
  if (!context || typeof context !== 'object') return { status: 'unavailable', score: 0, confidence: 0, evidence: [], sources: [], reason: 'No institutional context supplied' };
  const sourceTimestamp = context.generatedAt ?? context.observedAt;
  const parsedTimestamp = finite(sourceTimestamp) ? Number(sourceTimestamp) : Date.parse(sourceTimestamp || '');
  const generatedAt = Number.isFinite(parsedTimestamp) ? (parsedTimestamp > 0 && parsedTimestamp < 1e12 ? parsedTimestamp * 1000 : parsedTimestamp) : NaN;
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
  add('exchange-and-global-context', rawScore == null ? NaN : Math.abs(rawScore) > 1.5 ? rawScore / 100 : rawScore, 0.323, 'existing JPTI multi-factor market-context score');
  const market = context.market || {}, broad = context.broadContext || {};
  add('global-crypto-risk', signed(broad.globalMarketCapChange24hPct, 3), 0.136, 'aggregate global market-cap change');
  add('local-momentum', signed(market.priceChangePct, 3), 0.102, 'exchange closed-candle momentum');
  add('order-book-pressure', signed(market.orderBookImbalancePct, 100), 0.119, 'exchange order-book depth imbalance');
  const funding = finite(market.fundingRate) ? Number(market.fundingRate) : null;
  add('funding-crowding', funding == null ? NaN : clamp(-funding / 0.001, -1, 1), 0.068, 'perpetual funding, contrarian crowding adjustment');
  const mtf = Array.isArray(context.multiTimeframe) ? context.multiTimeframe.map(x => ({ ...x, numericBias: finite(x?.bias) ? Number(x.bias) : x?.bias === 'bullish' ? 1 : x?.bias === 'bearish' ? -1 : x?.bias === 'neutral' ? 0 : finite(x?.biasScore) ? Number(x.biasScore) : null })).filter(x => x.numericBias !== null) : [];
  if (mtf.length) add('institutional-context-mtf', mtf.reduce((sum, x) => sum + x.numericBias, 0) / mtf.length, 0.102, 'timeframe-aligned exchange context');
  const external = context.institutionalSources || {};
  const cftc = external.cftc || {};
  if (cftc.status === 'live') {
    if (cftc.dealer && finite(cftc.dealer.bias)) add('cftc-bank-and-dealer-positioning', signed(cftc.dealer.bias, 1), 0.012, 'CFTC TFF dealer/intermediary net futures positions / open interest');
    if (cftc.assetManager && finite(cftc.assetManager.bias)) add('cftc-asset-manager-positioning', signed(cftc.assetManager.bias, 1), 0.012, 'CFTC TFF asset-manager net futures positions / open interest');
    if (cftc.leveragedMoney && finite(cftc.leveragedMoney.bias)) add('cftc-leveraged-fund-positioning', signed(cftc.leveragedMoney.bias, 1), 0.012, 'CFTC TFF leveraged-fund net futures positions / open interest');
    if (cftc.otherReportables && finite(cftc.otherReportables.bias)) add('cftc-other-reportable-positioning', signed(cftc.otherReportables.bias, 1), 0.012, 'CFTC TFF other reportable net futures positions / open interest');
    if (cftc.nonReportables && finite(cftc.nonReportables.bias)) add('cftc-nonreportable-positioning', signed(cftc.nonReportables.bias, 1), 0.012, 'CFTC TFF non-reportable positions as a smaller-trader proxy, not a pure retail cohort');
  }
  const macro = external.macro || {};
  if (macro.status === 'live') add('government-and-central-bank-macro-risk', signed(macro.riskBias, 1), 0.04, 'FRED, Treasury Fiscal Data and ECB observations; low-frequency macro context');
  const retail = external.retailSentiment || {};
  if (retail.status === 'live') add('retail-risk-sentiment', signed(retail.riskBias, 1), 0.05, 'public Crypto Fear & Greed sentiment index; crowd sentiment, not position-level flow');
  const usedWeight = evidence.reduce((sum, x) => sum + x.weight, 0);
  const raw = usedWeight ? evidence.reduce((sum, x) => sum + x.contribution, 0) / usedWeight : 0;
  const coverage = knownSources ? liveSources / knownSources : (evidence.length ? 0.5 : 0);
  const freshness = clamp(1 - ageMs / maxAgeMs, 0, 1);
  const completeness = clamp(usedWeight, 0, 1);
  const confidence = round(clamp(coverage * 0.45 + freshness * 0.25 + completeness * 0.30, 0, 1));
  const available = evidence.length > 0 && (!knownSources || liveSources > 0);
  return { status: available ? 'ready' : 'unavailable', score: available ? round(raw) : 0, confidence: available ? confidence : 0, ageMs, sourceCoverage: round(coverage), evidence, sources: sourceRows, limitations: Array.isArray(context.limitations) ? context.limitations : [], generatedAt: context.generatedAt || null, reason: available ? null : 'No live corroborating source is available', method: 'Timestamp-gated weighted evidence; missing sources are excluded and remaining weights are renormalised' };
}
