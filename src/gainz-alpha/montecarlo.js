// Seeded Monte Carlo over a series of per-trade R results: drawdown and outcome bands.
// Deterministic for a given seed, no I/O, safe in browser, Workers and Node.

export function seededRandom(seed = 1) {
  let a = (Number(seed) >>> 0) || 1; // mulberry32
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear-interpolated percentile of an ascending-sorted array, p in [0, 100]. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

const clamp = (v, lo, hi, fallback) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : fallback);
const round = (v, d = 2) => (v === null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

/**
 * Bootstraps `runs` equity paths of `horizon` trades from the observed R results.
 * Each trade risks `riskPerTradePct` of current equity (compounding). `blockSize` > 1 resamples runs of
 * consecutive trades, which preserves loss clustering that an independent bootstrap would erase.
 */
export function monteCarloDrawdown(returnsR, options = {}) {
  // Number(null), Number('') and Number([]) are all 0, so a missing result must be dropped, not read as a 0R trade.
  const usable = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v));
  const R = (Array.isArray(returnsR) ? returnsR : []).filter(usable).map(Number);
  const minTrades = clamp(options.minTrades, 2, 1000, 20);
  if (R.length < minTrades) return { status: 'insufficient', n: R.length, needed: minTrades, reason: 'not-enough-closed-trades' };

  const runs = Math.floor(clamp(options.runs, 100, 20000, 2000));
  const horizon = Math.floor(clamp(options.horizon, 5, 5000, R.length));
  const risk = clamp(options.riskPerTradePct, 0.01, 10, 1) / 100;
  const ruinDrawdown = clamp(options.ruinDrawdownPct, 1, 99, 30) / 100;
  const blockSize = Math.floor(clamp(options.blockSize, 1, Math.max(1, R.length), 1));
  const seed = options.seed ?? 1;
  const rand = seededRandom(seed);

  const drawdowns = new Array(runs), finals = new Array(runs);
  let ruined = 0, losing = 0;
  for (let run = 0; run < runs; run++) {
    let equity = 1, peak = 1, maxDrawdown = 0, taken = 0;
    while (taken < horizon && equity > 0) {
      const start = Math.floor(rand() * R.length);
      for (let b = 0; b < blockSize && taken < horizon && equity > 0; b++, taken++) {
        equity = Math.max(0, equity * (1 + R[(start + b) % R.length] * risk));
        if (equity > peak) peak = equity;
        const drawdown = (peak - equity) / peak;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
      }
    }
    drawdowns[run] = maxDrawdown * 100;
    finals[run] = (equity - 1) * 100;
    if (maxDrawdown >= ruinDrawdown) ruined++;
    if (equity < 1) losing++;
  }
  drawdowns.sort((a, b) => a - b); finals.sort((a, b) => a - b);
  const band = (sorted) => ({ p5: round(percentile(sorted, 5)), p25: round(percentile(sorted, 25)), p50: round(percentile(sorted, 50)), p75: round(percentile(sorted, 75)), p95: round(percentile(sorted, 95)) });
  return {
    status: 'ok', n: R.length, runs, horizon, seed, blockSize,
    maxDrawdownPct: band(drawdowns), finalReturnPct: band(finals),
    probabilityOfRuin: round(ruined / runs, 4), probabilityOfLoss: round(losing / runs, 4),
    assumptions: {
      riskPerTradePct: round(risk * 100, 3), ruinDrawdownPct: round(ruinDrawdown * 100, 2),
      resampling: blockSize > 1 ? 'block bootstrap (' + blockSize + ' consecutive trades)' : 'independent bootstrap',
      note: 'Resamples past results; it cannot see regimes the history did not contain. An independent bootstrap understates drawdowns when losses cluster.'
    }
  };
}
