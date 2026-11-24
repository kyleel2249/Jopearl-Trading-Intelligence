// Durable GainzAlpha outcome memory (backend). Validates, de-duplicates and scopes records; uses JPTI storage events.
import { appendStoredEvent, readStoredEvents } from './storage.js';

export const GAINZ_OUTCOME_KIND = 'gainz-alpha-outcome';
export const MAX_GAINZ_OUTCOMES = 5000;
export const MAX_BATCH = 500;
const OUTCOMES = ['win', 'loss', 'timeout'];
const DIRECTIONS = ['bullish', 'bearish'];
const str = (v, n, fallback = 'unknown') => { const s = String(v ?? '').trim().slice(0, n); return s || fallback; };
const num = (v, lo, hi) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
const fail = (m) => Object.assign(new Error(m), { status: 400 });

export function cleanGainzOutcome(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Outcome record must be an object.');
  const outcome = String(input.outcome || '').toLowerCase(), direction = String(input.direction || '').toLowerCase();
  if (!OUTCOMES.includes(outcome)) throw fail('Outcome must be win, loss or timeout.');
  if (!DIRECTIONS.includes(direction)) throw fail('Direction must be bullish or bearish.');
  const returnR = num(input.returnR, -20, 50), tsRaw = Number(input.candleTs), candleTs = Number.isFinite(tsRaw) && tsRaw >= 1 && tsRaw <= 8.64e15 ? tsRaw : null;
  if (returnR === null) throw fail('returnR must be a finite number.');
  if (candleTs === null) throw fail('candleTs must be a positive timestamp.');
  const symbol = str(input.symbol, 32).toUpperCase(), timeframe = str(input.timeframe, 8);
  if (symbol === 'UNKNOWN' || timeframe === 'unknown') throw fail('symbol and timeframe are required.');
  const factors = {};
  if (input.factors && typeof input.factors === 'object' && !Array.isArray(input.factors)) for (const [k, v] of Object.entries(input.factors).slice(0, 16)) { const n = num(v, -2, 2); if (n !== null) factors[str(k, 24)] = n; }
  const id = str(input.id, 200, [symbol, timeframe, input.preset, candleTs, input.setupId].join('|'));
  return {
    id, setupId: str(input.setupId, 200, id), symbol, exchange: str(input.exchange, 30), timeframe, preset: str(input.preset, 20, 'balanced').toLowerCase(),
    setupType: str(input.setupType, 40, 'confluence'), direction, session: str(input.session, 30), regime: str(input.regime, 20), volRegime: str(input.volRegime, 12),
    candleTs, outcome, returnR, mfeR: num(input.mfeR, -50, 50), maeR: num(input.maeR, -50, 50), bars: num(input.bars, 0, 10000), falseSignal: input.falseSignal === true,
    confidence: num(input.confidence, 0, 100), score: num(input.score, -1, 1), factors, confirmations: Array.isArray(input.confirmations) ? input.confirmations.slice(0, 12).map((c) => str(c, 24)) : [],
    modelVersion: str(input.modelVersion, 40), tfMs: num(input.tfMs, 0, 3e9)
  };
}

export async function loadGainzOutcomes({ symbol = null, timeframe = null, limit = MAX_GAINZ_OUTCOMES } = {}) {
  const events = await readStoredEvents(MAX_GAINZ_OUTCOMES * 2, GAINZ_OUTCOME_KIND);
  const seen = new Set(), out = [];
  for (const e of events) {
    const r = e.payload?.record || e.record;
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    if (symbol && r.symbol !== String(symbol).toUpperCase()) continue;
    if (timeframe && r.timeframe !== timeframe) continue;
    out.push(r);
  }
  return out.slice(-Math.max(1, Math.min(limit, MAX_GAINZ_OUTCOMES)));
}

export async function saveGainzOutcomes(records) {
  if (!Array.isArray(records)) throw fail('records must be an array.');
  if (records.length > MAX_BATCH) throw fail('At most ' + MAX_BATCH + ' records per request.');
  const known = new Set((await loadGainzOutcomes({ limit: MAX_GAINZ_OUTCOMES })).map((r) => r.id));
  let saved = 0, duplicates = 0; const rejected = [];
  for (const [i, raw] of records.entries()) {
    let r;
    try { r = cleanGainzOutcome(raw); } catch (e) { rejected.push({ index: i, error: e.message }); continue; }
    if (known.has(r.id)) { duplicates++; continue; }
    await appendStoredEvent({ id: 'gainz-' + r.id, kind: GAINZ_OUTCOME_KIND, source: 'gainz-alpha', symbol: r.symbol, occurredAt: new Date(r.candleTs).toISOString(), payload: { record: r } });
    known.add(r.id); saved++;
  }
  return { saved, duplicates, rejected };
}
