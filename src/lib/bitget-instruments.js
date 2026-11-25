// Exact Bitget instrument lookup. USDC-M contracts use ids such as BTCPERP, so a pair string alone
// is not enough; the catalogue is the source of truth.
import { resolveSymbol } from './bitget-search.js';

export async function fetchProductCatalog(apiFetch, product, { exchange = 'bitget', search = '', signal } = {}) {
  const response = await apiFetch('/api/exchanges/' + exchange + '/markets?type=' + encodeURIComponent(product) + '&search=' + encodeURIComponent(search), signal ? { signal } : undefined);
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || 'Market catalogue unavailable for ' + product + '.');
  return { markets: Array.isArray(data.markets) ? data.markets : [], timeframes: Array.isArray(data.timeframes) ? data.timeframes : null, counts: data.counts || null };
}

export async function resolveInstrument(apiFetch, product, symbol, options = {}) {
  const base = String(symbol || '').split('/')[0].split(':')[0];
  const { markets } = await fetchProductCatalog(apiFetch, product, { ...options, search: base });
  const entries = markets.filter((m) => m && m.symbol).map((m) => ({ product, symbol: String(m.symbol), id: m.id ? String(m.id) : '', key: String(m.symbol).split(':')[0].replace(/[^A-Za-z0-9]/g, '').toUpperCase() }));
  const exact = resolveSymbol(entries, product, symbol);
  if (!exact) return null;
  const entry = entries.find((e) => e.symbol === exact);
  return { symbol: entry.symbol, id: entry.id };
}

export const instrumentQuery = (id) => (id ? '&instrumentId=' + encodeURIComponent(id) : '');
