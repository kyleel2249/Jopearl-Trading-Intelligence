/**
 * Crosshair link between charts on the same page. A chart publishes the time and price under its cursor and every
 * other linked chart for the same symbol draws a ghost crosshair at that timestamp (timeframes may differ, so the
 * link is by time, not by candle index). No DOM, no storage: a tiny pub/sub.
 */
const listeners = new Set();

export function publishCrosshair(event) {
  if (!event || typeof event.source !== 'string') return;
  for (const fn of [...listeners]) { try { fn(event); } catch { /* a listener must never break the publisher */ } }
}

export function subscribeCrosshair(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A ghost crosshair is only shown for another chart showing the same market (symbol and product). */
export const shouldMirror = (event, self) => Boolean(event && event.ts != null && event.source !== self.source && event.symbol === self.symbol && (event.marketType || 'spot') === (self.marketType || 'spot'));
