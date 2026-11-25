/**
 * Price-scale modes, locked ranges and the visible-range volume profile.
 *   linear   pips on a linear axis (chart-live.buildPriceAxis)
 *   log      logarithmic spacing; labels are the same pip prices, thinned to keep a readable pixel gap
 *   percent  labels are the % move from a reference price (normally the last close); spacing stays linear
 */
import { buildPriceAxis } from './chart-live.js';

export const SCALE_MODES = ['linear', 'log', 'percent'];
const positive = (n) => Number.isFinite(Number(n)) && Number(n) > 0;

/** Price <-> pixel mapping. Log mode needs strictly positive bounds and quietly uses linear otherwise. */
export function makeScale({ mode = 'linear', lo, hi, top, bottom }) {
  const useLog = mode === 'log' && positive(lo) && positive(hi) && hi > lo;
  const height = bottom - top;
  if (useLog) {
    const a = Math.log(lo), b = Math.log(hi);
    return { mode: 'log', y: (p) => top + ((b - Math.log(p)) / (b - a)) * height, price: (py) => Math.exp(b - ((py - top) / height) * (b - a)) };
  }
  return { mode: mode === 'percent' ? 'percent' : 'linear', y: (p) => top + ((hi - p) / (hi - lo)) * height, price: (py) => hi - ((py - top) / height) * (hi - lo) };
}

const NICE = [1, 2, 5, 10];
function niceStep(need) {
  if (!(need > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(need));
  return (NICE.map((n) => n * mag).find((m) => m >= need - 1e-12)) || 10 * mag;
}

export const percentLabel = (value, decimals = 2) => (value > 0 ? '+' : '') + value.toFixed(decimals) + '%';

/** Right-hand axis for the chosen scale mode. Always returns { ticks, minor, decimals, everyPip, mode }. */
export function buildScaleAxis({ mode = 'linear', lo, hi, top, bottom, pip, ref, minLabelPx = 14 } = {}) {
  const heightPx = bottom - top;
  if (mode === 'percent' && positive(ref) && hi > lo && heightPx > 0) {
    const loPct = (lo / ref - 1) * 100, hiPct = (hi / ref - 1) * 100;
    const step = niceStep((minLabelPx * (hiPct - loPct)) / heightPx);
    const decimals = Math.max(0, Math.min(6, Math.ceil(-Math.log10(step)) + (step < 1 ? 0 : 0)));
    const ticks = [];
    for (let k = Math.ceil(loPct / step - 1e-9); k <= Math.floor(hiPct / step + 1e-9) && ticks.length < 240; k += 1) {
      const pct = Number((k * step).toFixed(8));
      ticks.push({ price: ref * (1 + pct / 100), label: pct === 0 ? '0.00%' : percentLabel(pct, Math.max(2, decimals)), major: k % 5 === 0 });
    }
    return { ticks, minor: [], decimals, everyPip: false, multiple: null, mode: 'percent' };
  }
  if (mode === 'log' && positive(lo) && hi > lo && heightPx > 0) {
    const scale = makeScale({ mode: 'log', lo, hi, top, bottom });
    const base = buildPriceAxis({ min: lo, max: hi, heightPx: Math.max(heightPx, 1), pip, minLabelPx: 1, maxTicks: 400 });
    const kept = [];
    let lastY = -Infinity;
    for (const tick of [...base.ticks].sort((p, q) => q.price - p.price)) {
      const y = scale.y(tick.price);
      if (y - lastY >= minLabelPx) { kept.push({ ...tick, major: true }); lastY = y; }
    }
    return { ticks: kept.reverse(), minor: [], decimals: base.decimals, everyPip: false, multiple: base.multiple, mode: 'log' };
  }
  return { ...buildPriceAxis({ min: lo, max: hi, heightPx, pip, minLabelPx }), mode: 'linear' };
}

/** Auto-fit range, or the locked range the user froze (never both). */
export function resolveRange(auto, locked) {
  if (locked && positive(locked.hi) && positive(locked.lo) && locked.hi > locked.lo) return { lo: locked.lo, hi: locked.hi, locked: true };
  return { lo: auto.lo, hi: auto.hi, locked: false };
}

/**
 * Volume profile over the visible candles. Each candle's volume is spread evenly over the price bins its
 * high-low range touches (a candle with no range goes to one bin). POC = busiest bin; value area = the smallest
 * band around the POC holding `valueArea` of the volume, grown toward whichever neighbour is larger.
 */
export function buildRangeProfile(rows, { bins = 48, lo, hi, valueArea = 0.7 } = {}) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const low = Number.isFinite(lo) ? lo : Math.min(...rows.map((c) => c[3]));
  const high = Number.isFinite(hi) ? hi : Math.max(...rows.map((c) => c[2]));
  const count = Math.max(4, Math.min(200, Math.floor(bins)));
  if (!(high > low)) return null;
  const size = (high - low) / count;
  const buckets = Array.from({ length: count }, (_, i) => ({ lo: low + i * size, hi: low + (i + 1) * size, mid: low + (i + 0.5) * size, volume: 0 }));
  const clampIdx = (p) => Math.max(0, Math.min(count - 1, Math.floor((p - low) / size)));
  let total = 0;
  for (const c of rows) {
    const vol = Number(c[5]);
    if (!(vol > 0)) continue;
    const a = clampIdx(c[3]), b = clampIdx(c[2]);
    const share = vol / (b - a + 1);
    for (let i = a; i <= b; i += 1) buckets[i].volume += share;
    total += vol;
  }
  if (!(total > 0)) return null;
  let poc = 0;
  buckets.forEach((b, i) => { if (b.volume > buckets[poc].volume) poc = i; });
  let a = poc, b = poc, acc = buckets[poc].volume;
  while (acc < total * valueArea && (a > 0 || b < count - 1)) {
    const below = a > 0 ? buckets[a - 1].volume : -1, above = b < count - 1 ? buckets[b + 1].volume : -1;
    if (above >= below) { b += 1; acc += buckets[b].volume; } else { a -= 1; acc += buckets[a].volume; }
  }
  return { bins: buckets, total, max: buckets[poc].volume, poc: { index: poc, price: buckets[poc].mid }, vah: buckets[b].hi, val: buckets[a].lo, valueAreaShare: acc / total };
}
