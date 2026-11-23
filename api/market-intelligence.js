export function buildCrossVenueComparison(symbol, observations, thresholdPercent = 0.5) {
  const valid = observations.filter((item) => Number.isFinite(item.last) && item.last > 0);
  const sorted = valid.map((item) => item.last).sort((a, b) => a - b);
  const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
  const asks = valid.filter((item) => Number.isFinite(item.ask) && item.ask > 0);
  const bids = valid.filter((item) => Number.isFinite(item.bid) && item.bid > 0);
  const crossVenuePairs = asks.flatMap((ask) => bids
    .filter((bid) => bid.exchange !== ask.exchange)
    .map((bid) => ({ buyVenue: ask.exchange, ask: ask.ask, sellVenue: bid.exchange,
      bid: bid.bid, grossEdgePercent: ((bid.bid - ask.ask) / ask.ask) * 100 })));
  const bestIndicativeTopOfBook = crossVenuePairs.sort((a, b) => b.grossEdgePercent - a.grossEdgePercent)[0] || null;
  return {
    symbol, generatedAt: new Date().toISOString(), venueCount: valid.length,
    medianLast: median,
    lastPriceSpreadPercent: sorted.length > 1 && median ? ((sorted[sorted.length - 1] - sorted[0]) / median) * 100 : null,
    bestIndicativeTopOfBook,
    venues: valid.map((item) => ({
      ...item,
      deviationFromMedianPercent: median ? ((item.last - median) / median) * 100 : null,
      outlier: valid.length >= 3 && median ? Math.abs((item.last - median) / median) * 100 > thresholdPercent : false
    })),
    caveats: [
      'Top-of-book comparison is indicative only; it excludes trading fees, funding, slippage, latency, queue position, transfer costs and venue-specific restrictions.',
      'Displayed bid/ask sizes are not modeled. A positive gross edge is not proof of an executable arbitrage.',
      'Only venues that returned a valid ticker are included; market symbols and quote conventions must match.'
    ]
  };
}
