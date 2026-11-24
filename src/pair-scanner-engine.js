export function pearsonCorrelation(left, right) {
  const length = Math.min(Array.isArray(left) ? left.length : 0, Array.isArray(right) ? right.length : 0);
  if (length < 3) return null;
  const x = left.slice(-length).map(Number), y = right.slice(-length).map(Number);
  if (x.some(value => !Number.isFinite(value)) || y.some(value => !Number.isFinite(value))) return null;
  const meanX = x.reduce((sum, value) => sum + value, 0) / length;
  const meanY = y.reduce((sum, value) => sum + value, 0) / length;
  let covariance = 0, varianceX = 0, varianceY = 0;
  for (let i = 0; i < length; i++) {
    const dx = x[i] - meanX, dy = y[i] - meanY;
    covariance += dx * dy; varianceX += dx * dx; varianceY += dy * dy;
  }
  if (varianceX <= 0 || varianceY <= 0) return null;
  return Math.max(-1, Math.min(1, covariance / Math.sqrt(varianceX * varianceY)));
}

export function candleReturns(candles) {
  const rows = (Array.isArray(candles) ? candles : [])
    .filter(row => Array.isArray(row) && row.length >= 5 && Number.isFinite(Number(row[0])) && Number(row[4]) > 0)
    .map(row => [Number(row[0]), Number(row[4])])
    .sort((a, b) => a[0] - b[0]);
  const returns = [];
  for (let i = 1; i < rows.length; i++) {
    const prior = rows[i - 1][1], current = rows[i][1];
    if (prior > 0 && current > 0) returns.push([rows[i][0], Math.log(current / prior)]);
  }
  return returns;
}

export function correlateCandleSeries(referenceCandles, candidateCandles, symbol, timeframe) {
  const reference = new Map(candleReturns(referenceCandles));
  const candidate = new Map(candleReturns(candidateCandles));
  const shared = [...reference.keys()].filter(timestamp => candidate.has(timestamp)).sort((a,b)=>a-b);
  if (shared.length < 12) return { symbol, timeframe, correlation: null, observations: shared.length, status: 'insufficient-overlap' };
  const correlation = pearsonCorrelation(shared.map(time => reference.get(time)), shared.map(time => candidate.get(time)));
  return { symbol, timeframe, correlation: correlation === null ? null : Number(correlation.toFixed(4)), observations: shared.length, status: correlation === null ? 'constant-return-series' : 'measured' };
}
