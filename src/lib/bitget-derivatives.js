// Bitget derivatives snapshot: mark/index/last, funding, open interest and spot basis.
// Parsers are tolerant (several field spellings) and return null for anything missing; nothing is guessed.
export const FUTURES_PRODUCTS = new Set(['futures', 'coin-futures', 'usdc-futures']);
export const CATEGORY = { spot: 'SPOT', margin: 'MARGIN', futures: 'USDT-FUTURES', 'coin-futures': 'COIN-FUTURES', 'usdc-futures': 'USDC-FUTURES' };
const HOST = 'https://api.bitget.com';
const num = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));
const first = (object, keys) => { for (const key of keys) { const value = num(object?.[key]); if (value !== null) return value; } return null; };
const row = (payload) => (Array.isArray(payload?.data) ? payload.data[0] : payload?.data) || null;
const okPayload = (payload) => payload && String(payload.code) === '00000';

export function venueSymbolFromPair(pair, instrumentId) {
  if (instrumentId) return String(instrumentId).toUpperCase();
  return String(pair || '').split(':')[0].replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

export function parseDerivativesTicker(payload) {
  if (!okPayload(payload)) return null;
  const t = row(payload);
  if (!t) return null;
  return {
    last: first(t, ['lastPrice', 'lastPr', 'close']),
    mark: first(t, ['markPrice', 'markPr']),
    index: first(t, ['indexPrice', 'indexPr']),
    fundingRate: first(t, ['fundingRate']),
    openInterest: first(t, ['openInterest', 'holdingAmount']),
    timestamp: first(t, ['ts'])
  };
}

export function parseFundingRate(payload) {
  if (!okPayload(payload)) return null;
  const t = row(payload);
  if (!t) return null;
  const interval = first(t, ['fundingRateInterval', 'fundingInterval']);
  return { rate: first(t, ['fundingRate']), intervalHours: interval !== null && interval > 0 ? interval : null, nextUpdate: first(t, ['nextUpdate', 'nextFundingTime']) };
}

export function parseOpenInterest(payload) {
  if (!okPayload(payload)) return null;
  const data = payload.data;
  const list = Array.isArray(data?.openInterestList) ? data.openInterestList : Array.isArray(data) ? data : [data];
  const t = list[0];
  return t ? first(t, ['openInterest', 'size', 'amount']) : null;
}

export const annualizeFunding = (rate, intervalHours = 8) => (num(rate) === null || !(intervalHours > 0) ? null : rate * (24 / intervalHours) * 365);

export function computeBasis({ derivativePrice, spotPrice, expiryMs = null, nowMs = Date.now() }) {
  const d = num(derivativePrice), s = num(spotPrice);
  if (d === null || s === null || s <= 0) return null;
  const absolute = d - s, pct = (absolute / s) * 100;
  const days = expiryMs ? (expiryMs - nowMs) / 86400000 : null;
  return { absolute, pct, annualizedPct: days !== null && days > 1 ? pct * (365 / days) : null, daysToExpiry: days !== null && days > 0 ? days : null };
}

async function getJson(url, fetchImpl, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(url, controller ? { signal: controller.signal, cache: 'no-store' } : { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.json();
  } finally { if (timer) clearTimeout(timer); }
}

export async function fetchDerivativesSnapshot({ product, pair, instrumentId, fetchImpl = globalThis.fetch, timeoutMs = 8000, now = Date.now } = {}) {
  if (!FUTURES_PRODUCTS.has(product)) return { ok: false, reason: 'Derivatives data applies to Bitget futures products only.' };
  const category = CATEGORY[product];
  const symbol = venueSymbolFromPair(pair, instrumentId);
  const base = String(pair || '').split('/')[0].toUpperCase();
  const errors = {};
  const call = async (name, url, parse) => { try { return parse(await getJson(url, fetchImpl, timeoutMs)); } catch (error) { errors[name] = error.message || 'failed'; return null; } };
  const q = '?category=' + encodeURIComponent(category) + '&symbol=' + encodeURIComponent(symbol);
  const [ticker, funding, openInterest, spot] = await Promise.all([
    call('ticker', HOST + '/api/v3/market/tickers' + q, parseDerivativesTicker),
    call('funding', HOST + '/api/v3/market/current-fund-rate' + q, parseFundingRate),
    call('openInterest', HOST + '/api/v3/market/open-interest' + q, parseOpenInterest),
    base ? call('spot', HOST + '/api/v3/market/tickers?category=SPOT&symbol=' + encodeURIComponent(base + 'USDT'), parseDerivativesTicker) : Promise.resolve(null)
  ]);
  const fundingRate = funding?.rate ?? ticker?.fundingRate ?? null;
  const intervalHours = funding?.intervalHours ?? null;
  const derivativePrice = ticker?.mark ?? ticker?.last ?? null;
  const out = {
    ok: Boolean(ticker || funding || openInterest), symbol, category, fetchedAt: new Date(now()).toISOString(),
    prices: { last: ticker?.last ?? null, mark: ticker?.mark ?? null, index: ticker?.index ?? null, spot: spot?.last ?? null, spotSymbol: base ? base + 'USDT' : null },
    funding: { rate: fundingRate, intervalHours, annualized: annualizeFunding(fundingRate, intervalHours || 8), annualizedAssumesEightHours: intervalHours === null, nextUpdate: funding?.nextUpdate ?? null },
    openInterest: openInterest ?? ticker?.openInterest ?? null,
    basis: computeBasis({ derivativePrice, spotPrice: spot?.last ?? null, nowMs: now() }),
    errors
  };
  if (!out.ok) out.reason = 'Bitget public market data was unreachable from this browser.';
  return out;
}
