/**
 * Shared horizontal canvas sizing for candle charts.
 * The viewport remains fixed; additional visible history receives proportional
 * canvas width so candle spacing does not collapse as users zoom out.
 */
export function getExpandedCanvasWidth(viewportWidth, visibleCandles, baselineCandles) {
  const viewport = Number.isFinite(Number(viewportWidth)) && Number(viewportWidth) > 0
    ? Number(viewportWidth)
    : 1;
  const visible = Math.max(1, Math.floor(Number(visibleCandles) || 1));
  const baseline = Math.max(1, Math.floor(Number(baselineCandles) || 1));
  return Math.max(Math.ceil(viewport), Math.ceil(viewport * visible / baseline));
}

/**
 * Vertical canvas sizing mirrors the horizontal timeline: preserve the baseline
 * plot height while adding proportional room for larger historical ranges.
 */
export function getExpandedCanvasHeight(viewportHeight, visibleCandles, baselineCandles) {
  const viewport = Number.isFinite(Number(viewportHeight)) && Number(viewportHeight) > 0
    ? Number(viewportHeight)
    : 1;
  const visible = Math.max(1, Math.floor(Number(visibleCandles) || 1));
  const baseline = Math.max(1, Math.floor(Number(baselineCandles) || 1));
  return Math.max(Math.ceil(viewport), Math.ceil(viewport * visible / baseline));
}
