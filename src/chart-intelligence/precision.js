/**
 * JPTI Instrument Precision Intelligence
 * Exchange/provider tick metadata is authoritative; no global decimal assumptions.
 * Handles FX pips, fractional pips, exchange tick sizes, and safe price rounding.
 */
const finitePositive = (n) => Number.isFinite(Number(n)) && Number(n) > 0;
const decimalPlaces = (n) => {
  const s = String(n);
  if (s.includes("e-")) return Number(s.split("e-")[1]) || 0;
  return (s.split(".")[1] || "").length;
};

export function resolvePrecision(meta = {}) {
  const tick = Number(meta.tickSize ?? meta.priceIncrement ?? meta.minPriceIncrement);
  const pip = Number(meta.pipSize ?? meta.pip ?? meta.pointSize);
  const tickValid = finitePositive(tick);
  const pipValid = finitePositive(pip);
  const decimals = Number.isInteger(meta.priceDecimals) && meta.priceDecimals >= 0
    ? meta.priceDecimals
    : tickValid ? decimalPlaces(tick) : Number.isInteger(meta.precision) && meta.precision >= 0 ? meta.precision : null;
  return {
    tickSize: tickValid ? tick : null,
    pipSize: pipValid ? pip : null,
    decimals,
    source: tickValid ? "instrument-tick" : decimals !== null ? "precision-metadata" : "unresolved",
    calibrated: tickValid || decimals !== null,
    symbol: meta.symbol ?? null,
    marketType: meta.marketType ?? meta.type ?? null,
    quote: meta.quote ?? null
  };
}

export function roundToTick(price, precisionOrMeta) {
  const p = typeof precisionOrMeta === "object" ? resolvePrecision(precisionOrMeta) : { tickSize: null, decimals: precisionOrMeta };
  const value = Number(price);
  if (!Number.isFinite(value)) return null;
  if (finitePositive(p.tickSize)) {
    const units = Math.round((value + Number.EPSILON) / p.tickSize);
    return Number((units * p.tickSize).toFixed(Math.min(14, decimalPlaces(p.tickSize))));
  }
  if (Number.isInteger(p.decimals) && p.decimals >= 0 && p.decimals <= 14) return Number(value.toFixed(p.decimals));
  return value;
}

export function formatInstrumentPrice(price, meta = {}, options = {}) {
  const precision = resolvePrecision(meta);
  const rounded = roundToTick(price, precision);
  if (rounded === null) return "—";
  const digits = precision.decimals ?? options.maxDecimals ?? 8;
  return rounded.toLocaleString(options.locale || "en-US", {
    minimumFractionDigits: options.minimumFractionDigits ?? precision.decimals ?? 0,
    maximumFractionDigits: Math.max(0, Math.min(14, options.maximumFractionDigits ?? digits)),
    useGrouping: options.useGrouping ?? false
  });
}

export function priceDistanceInPips(from, to, meta = {}) {
  const pip = resolvePrecision(meta).pipSize;
  const a = Number(from), b = Number(to);
  if (!finitePositive(pip) || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  // Normalize floating-point residue (e.g. 0.1 / 0.01) without losing fractional pip values.
  return Number(((b - a) / pip).toFixed(10));
}

export function pricePrecisionDiagnostics(meta = {}) {
  const p = resolvePrecision(meta);
  return {
    ...p,
    warnings: [
      ...(p.tickSize === null ? ["No authoritative tick-size metadata; rounding falls back to decimal precision."] : []),
      ...(p.pipSize === null ? ["Pip/point size unavailable; pip distances are disabled."] : [])
    ]
  };
}
