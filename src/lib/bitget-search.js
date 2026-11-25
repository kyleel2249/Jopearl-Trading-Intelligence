// Cross-product Bitget market search. Pure functions so the ranking is testable without a DOM.
export const PRODUCTS = [
  { id: 'spot', label: 'Spot', hints: ['spot'] },
  { id: 'futures', label: 'USDT-M Futures', hints: ['usdt', 'usdtm', 'perp', 'perpetual', 'futures', 'swap', 'linear'] },
  { id: 'coin-futures', label: 'Coin-M Futures', hints: ['coin', 'coinm', 'inverse'] },
  { id: 'usdc-futures', label: 'USDC-M Futures', hints: ['usdc', 'usdcm'] },
  { id: 'margin', label: 'Margin', hints: ['margin'] },
  { id: 'cfd', label: 'CFD', hints: ['cfd'] }
];
export const PRODUCT_IDS = PRODUCTS.map((product) => product.id);
export const productLabel = (id) => PRODUCTS.find((product) => product.id === id)?.label || id;

const HINT_TO_PRODUCT = new Map(PRODUCTS.flatMap((product) => product.hints.map((hint) => [hint, product.id])));
// Bare "usdt" is also a quote currency, so it only narrows the product when it is a separate word.
const alnum = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const pairKey = (symbol) => alnum(String(symbol || '').split(':')[0]);

export function parseQuery(query) {
  const words = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const products = new Set();
  const terms = [];
  for (const word of words) {
    if (words.length > 1 && HINT_TO_PRODUCT.has(word)) products.add(HINT_TO_PRODUCT.get(word));
    else terms.push(word);
  }
  return { text: alnum(terms.join('')), products: [...products] };
}

export function buildSearchIndex(catalogs = {}) {
  const entries = [];
  for (const product of PRODUCT_IDS) {
    for (const market of Array.isArray(catalogs[product]) ? catalogs[product] : []) {
      if (!market || !market.symbol) continue;
      const symbol = String(market.symbol);
      entries.push({ product, symbol, id: market.id ? String(market.id) : '', base: String(market.base || symbol.split('/')[0] || '').toUpperCase(), quote: String(market.quote || '').toUpperCase(), key: pairKey(symbol) });
    }
  }
  return entries;
}

const PRODUCT_RANK = Object.fromEntries(['futures', 'spot', 'usdc-futures', 'coin-futures', 'margin', 'cfd'].map((id, index) => [id, index]));

export function searchMarkets(index, query, { limit = 20, products } = {}) {
  const parsed = parseQuery(query);
  const allowed = new Set(products && products.length ? products : parsed.products.length ? parsed.products : PRODUCT_IDS);
  if (!parsed.text) return [];
  const scored = [];
  for (const entry of index) {
    if (!allowed.has(entry.product)) continue;
    let score = 0;
    if (entry.key === parsed.text) score = 100;
    else if (entry.key.startsWith(parsed.text)) score = 80;
    else if (entry.base.startsWith(parsed.text)) score = 70;
    else if (entry.key.includes(parsed.text)) score = 50;
    if (score) scored.push({ ...entry, score });
  }
  scored.sort((a, b) => b.score - a.score || PRODUCT_RANK[a.product] - PRODUCT_RANK[b.product] || a.symbol.length - b.symbol.length || a.symbol.localeCompare(b.symbol));
  return scored.slice(0, Math.max(1, limit));
}

// Maps a loose symbol (BTC/USDT) onto the exact listed symbol for a product (BTC/USDT:USDT).
export function resolveSymbol(index, product, symbol) {
  const key = pairKey(symbol);
  const match = index.find((entry) => entry.product === product && entry.key === key);
  return match ? match.symbol : null;
}
