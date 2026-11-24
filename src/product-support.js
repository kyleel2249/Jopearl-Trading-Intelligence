/**
 * Which trading products can be served for an exchange in the current API mode.
 *
 * Modes:
 *   api              full JPTI Node API (CCXT market catalogue, every venue it lists)
 *   cloudflare-edge  Cloudflare Pages functions: spot on every venue, derivatives/margin through Bitget only
 *   direct           browser-direct public data: spot on every venue, derivatives/margin through Bitget only
 *
 * A product that the selected venue cannot serve is NOT left greyed out. Selecting it moves the chart to the venue
 * that can serve it (Bitget) and says so. Only products nothing can serve right now stay disabled, with a reason.
 */

export const PRODUCT_OPTIONS = [
  { value: 'spot', label: 'Spot' },
  { value: 'margin', label: 'Margin' },
  { value: 'futures', label: 'USDT-M Futures' },
  { value: 'coin-futures', label: 'Coin-M Futures' },
  { value: 'usdc-futures', label: 'USDC-M Futures' },
  { value: 'cfd', label: 'CFD' }
];

export const DERIVATIVES_VENUE = 'bitget';
const DERIVATIVE_PRODUCTS = ['margin', 'futures', 'coin-futures', 'usdc-futures'];
const MODE_LABEL = { api: 'the JPTI API', 'cloudflare-edge': 'Cloudflare edge mode', direct: 'browser-direct mode' };
const titleCase = (id) => String(id || '').charAt(0).toUpperCase() + String(id || '').slice(1);
const labelOf = (value) => PRODUCT_OPTIONS.find((item) => item.value === value)?.label || value;

export function normalizeMode(mode) {
  return mode === 'cloudflare-edge' || mode === 'direct' ? mode : 'api';
}

/** Per-product availability: { available, native, switchTo, reason } keyed by product value. */
export function productSupport({ exchange, mode = 'api', cfdReady = false } = {}) {
  const ex = String(exchange || '').toLowerCase();
  const m = normalizeMode(mode);
  const result = {};
  for (const { value } of PRODUCT_OPTIONS) {
    if (value === 'spot') { result[value] = { available: true, native: true, switchTo: null, reason: '' }; continue; }
    if (value === 'cfd') {
      if (!cfdReady) { result[value] = { available: false, native: false, switchTo: null, reason: 'CFD needs the Cloudflare Pages edge API with the Bitget read-only UTA credentials.' }; continue; }
      result[value] = ex === DERIVATIVES_VENUE
        ? { available: true, native: true, switchTo: null, reason: '' }
        : { available: true, native: false, switchTo: DERIVATIVES_VENUE, reason: 'CFD is served by Bitget.' };
      continue;
    }
    if (m === 'api' || ex === DERIVATIVES_VENUE) { result[value] = { available: true, native: true, switchTo: null, reason: '' }; continue; }
    result[value] = { available: true, native: false, switchTo: DERIVATIVES_VENUE, reason: labelOf(value) + ' is served by Bitget in ' + MODE_LABEL[m] + '.' };
  }
  return result;
}

/** Resolve a user's product choice: stay, switch venue, or explain why it cannot be served. */
export function resolveProductChoice({ exchange, requested, mode = 'api', cfdReady = false } = {}) {
  const table = productSupport({ exchange, mode, cfdReady });
  const entry = table[requested];
  if (!entry) return { ok: false, exchange, marketType: 'spot', switched: false, notice: 'That product is not available in this adapter.' };
  if (!entry.available) return { ok: false, exchange, marketType: null, switched: false, notice: entry.reason };
  if (entry.native) return { ok: true, exchange, marketType: requested, switched: false, notice: '' };
  return {
    ok: true,
    exchange: entry.switchTo,
    marketType: requested,
    switched: true,
    notice: 'Exchange switched from ' + titleCase(exchange) + ' to ' + titleCase(entry.switchTo) + ': ' + entry.reason
  };
}

/** After the exchange or API mode changes: keep the product only if the venue still serves it natively. */
export function coerceProductForExchange({ exchange, marketType, mode = 'api', cfdReady = false } = {}) {
  const entry = productSupport({ exchange, mode, cfdReady })[marketType];
  if (!marketType || marketType === 'spot' || (entry && entry.available && entry.native)) return { marketType: marketType || 'spot', notice: '' };
  return { marketType: 'spot', notice: titleCase(exchange) + ' does not serve ' + labelOf(marketType) + ' in ' + MODE_LABEL[normalizeMode(mode)] + '; showing Spot. Pick the product again to switch to Bitget.' };
}
