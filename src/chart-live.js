/**
 * Pure helpers shared by the live candlestick charts (LiveCandlestickChart and TerminalChart).
 * No React and no DOM: everything here is unit-tested in chart-live.test.js.
 *
 *  - Live tick merging: the last (still forming) candle follows the latest ticker price between OHLCV refreshes.
 *    A candle is never fabricated: if the forming candle has already closed, the exchange candles are returned untouched.
 *  - Candle-close countdown and the exact close time of a candle, including calendar months.
 *  - Pip resolution and a pip-based price axis: one label per pip while the pixel height allows it, otherwise the
 *    smallest 1-2-5 multiple of a pip that keeps labels readable. Zooming the price scale reveals every pip.
 */

const MINUTE = 60_000;
const FRAME_MS = {
  '1m': MINUTE, '3m': 3 * MINUTE, '5m': 5 * MINUTE, '15m': 15 * MINUTE, '30m': 30 * MINUTE,
  '1h': 60 * MINUTE, '2h': 120 * MINUTE, '4h': 240 * MINUTE, '6h': 360 * MINUTE, '8h': 480 * MINUTE, '12h': 720 * MINUTE,
  '1d': 1440 * MINUTE, '3d': 4320 * MINUTE, '1w': 10080 * MINUTE
};

export const timeframeMs = (timeframe) => FRAME_MS[timeframe] || null;

/** Exact close time (ms) of the candle that opens at openTs, or null for an unknown timeframe. */
export function candleCloseAt(openTs, timeframe) {
  const open = Number(openTs);
  if (!Number.isFinite(open)) return null;
  if (timeframe === '1M') {
    const d = new Date(open);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  const ms = timeframeMs(timeframe);
  return ms ? open + ms : null;
}

export function formatCountdown(remainingMs) {
  const total = Math.max(0, Math.floor(Number(remainingMs) / 1000));
  if (!Number.isFinite(total)) return '--:--';
  const d = Math.floor(total / 86400), h = Math.floor((total % 86400) / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const two = (n) => String(n).padStart(2, '0');
  if (d > 0) return d + 'd ' + two(h) + 'h';
  if (h > 0) return h + ':' + two(m) + ':' + two(s);
  return two(m) + ':' + two(s);
}

/** Time left until the forming candle closes. expired=true once its period has elapsed. */
export function candleCountdown(openTs, timeframe, now = Date.now()) {
  const close = candleCloseAt(openTs, timeframe);
  if (close == null) return null;
  const remainingMs = close - now;
  return { remainingMs: Math.max(0, remainingMs), expired: remainingMs <= 0, label: formatCountdown(remainingMs) };
}

/**
 * Apply the latest traded price to the forming candle: close = price, high/low widened when exceeded.
 * Returns the original array unchanged when there is nothing valid to merge so memoised consumers stay stable.
 * Candle length and timestamps are preserved, so indicator arrays keep lining up with the candles.
 */
export function mergeLiveTick(candles, price, { timeframe, now = Date.now() } = {}) {
  const p = Number(price);
  if (!Array.isArray(candles) || !candles.length || !Number.isFinite(p) || p <= 0) return candles;
  const last = candles[candles.length - 1];
  if (!Array.isArray(last) || last.length < 6) return candles;
  const close = candleCloseAt(last[0], timeframe);
  if (close == null || now >= close || now < last[0]) return candles;
  if (last[4] === p && p <= last[2] && p >= last[3]) return candles;
  const merged = last.slice();
  merged[4] = p;
  merged[2] = Math.max(last[2], p);
  merged[3] = Math.min(last[3], p);
  return candles.slice(0, -1).concat([merged]);
}

const decimalPlaces = (n) => {
  const s = String(Number(n));
  if (s.includes('e-')) return Number(s.split('e-')[1]) + (s.split('e-')[0].split('.')[1] || '').length;
  return (s.split('.')[1] || '').length;
};
const positive = (n) => Number.isFinite(Number(n)) && Number(n) > 0;

const FIAT = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD']);

/** Heuristic pip used only when the exchange/provider supplies no pip, tick or profile information. */
export function pipIncrementFor(symbol, price) {
  const pair = String(symbol || '').replace(/[^A-Z]/g, '');
  const base = pair.slice(0, 3), quote = pair.slice(3, 6);
  if (pair.length === 6 && FIAT.has(base) && FIAT.has(quote)) return quote === 'JPY' ? 0.01 : 0.0001;
  if (price >= 1000) return 1;
  if (price >= 100) return 0.1;
  if (price >= 10) return 0.01;
  if (price >= 1) return 0.001;
  if (price >= 0.1) return 0.0001;
  if (price >= 0.01) return 0.00001;
  return 0.000001;
}

/**
 * Pip size in price units. Authoritative provider pip metadata wins, then the dashboard instrument profile,
 * then a heuristic. The result is never finer than the instrument tick size.
 */
export function resolvePipSize({ symbol, price, precision, profilePip } = {}) {
  let pip = null, source = 'heuristic';
  if (positive(precision?.pipSize)) { pip = Number(precision.pipSize); source = 'instrument-pip'; }
  else if (positive(profilePip)) { pip = Number(profilePip); source = 'instrument-profile'; }
  else { pip = pipIncrementFor(symbol, Number(price)); }
  const tick = Number(precision?.tickSize);
  if (positive(tick) && pip < tick) { pip = tick; source = 'instrument-tick'; }
  return { pip, source };
}

/** Distance between two prices in pips (fractional), or null when it cannot be computed. */
export function pipDistance(from, to, pip) {
  const a = Number(from), b = Number(to), step = Number(pip);
  if (![a, b, step].every(Number.isFinite) || step <= 0) return null;
  return Number(((b - a) / step).toFixed(2));
}

const NICE = [1, 2, 5, 10];
const niceMultiple = (need) => {
  if (need <= 1) return 1;
  const mag = 10 ** Math.floor(Math.log10(need));
  return NICE.map((n) => n * mag).find((m) => m >= need - 1e-9) || 10 * mag;
};

/**
 * Build the right-hand price axis.
 *  - every pip is labelled while pxPerPip >= minLabelPx (everyPip === true)
 *  - otherwise every Nth pip with N from 1-2-5-10 x 10^k, and the skipped pips become faint minor grid lines
 * Tick prices are produced from integer multiples of the step so no floating-point drift accumulates.
 */
export function buildPriceAxis({ min, max, heightPx, pip, minLabelPx = 14, maxTicks = 220 } = {}) {
  const range = Number(max) - Number(min);
  const empty = { ticks: [], minor: [], step: positive(pip) ? Number(pip) : null, multiple: null, pxPerPip: null, everyPip: false, decimals: 2 };
  if (!(range > 0) || !(Number(heightPx) > 0) || !positive(pip)) return empty;
  const pxPerPip = (Number(heightPx) * Number(pip)) / range;
  let multiple = niceMultiple(minLabelPx / pxPerPip);
  let step = Number(pip) * multiple;
  while (range / step > maxTicks) { multiple = niceMultiple(multiple * 2.01); step = Number(pip) * multiple; }
  const decimals = Math.min(12, decimalPlaces(Number((Number(pip) * multiple).toPrecision(12))));
  const toPrice = (k, unit) => Number((k * unit).toFixed(Math.min(12, decimalPlaces(Number(unit.toPrecision(12))))));
  const kMin = Math.ceil(Number(min) / step - 1e-9), kMax = Math.floor(Number(max) / step + 1e-9);
  const ticks = [];
  for (let k = kMin; k <= kMax && ticks.length <= maxTicks; k += 1) {
    const price = toPrice(k, step);
    ticks.push({ price, label: price.toFixed(decimals), major: multiple === 1 ? k % 5 === 0 : true });
  }
  const minor = [];
  if (multiple > 1 && pxPerPip >= 3.5) {
    const pMin = Math.ceil(Number(min) / Number(pip) - 1e-9), pMax = Math.floor(Number(max) / Number(pip) + 1e-9);
    for (let k = pMin; k <= pMax && minor.length < 400; k += 1) if (k % multiple !== 0) minor.push(toPrice(k, Number(pip)));
  }
  return { ticks, minor, step, multiple, pxPerPip, everyPip: multiple === 1, decimals };
}

/** Width in px needed for the axis labels (monospace-ish 10px text) including padding. */
export function axisWidthFor(labels, { min = 54, max = 118, charPx = 6.4, pad = 16 } = {}) {
  const longest = (labels || []).reduce((n, label) => Math.max(n, String(label ?? '').length), 0);
  return Math.min(max, Math.max(min, Math.ceil(longest * charPx) + pad));
}

/** Zoom a [low, high] price range about a centre price. zoom > 1 magnifies (fewer pips on screen). */
export function applyPriceZoom(low, high, zoom, center) {
  const z = Number.isFinite(Number(zoom)) && Number(zoom) > 0 ? Number(zoom) : 1;
  if (z === 1) return { low, high };
  const mid = Number.isFinite(Number(center)) ? Number(center) : (low + high) / 2;
  const half = (high - low) / 2 / z;
  return { low: mid - half, high: mid + half };
}
