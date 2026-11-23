// Cross-asset evidence primitives shared by JPTI and the embedded T-Bots paper engine.
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function normalizeDexPair(pair) {
  const liquidity = finite(pair?.liquidity?.usd) ?? 0;
  const volume24h = finite(pair?.volume?.h24) ?? 0;
  const volume1h = finite(pair?.volume?.h1) ?? 0;
  const priceChange24h = finite(pair?.priceChange?.h24);
  const priceChange1h = finite(pair?.priceChange?.h1);
  const createdAt = finite(pair?.pairCreatedAt);
  return {
    source: 'dexscreener', chain: String(pair?.chainId || 'unknown').toLowerCase(),
    dex: String(pair?.dexId || 'unknown'), pairAddress: pair?.pairAddress || null,
    url: pair?.url || null,
    base: { address: pair?.baseToken?.address || null, symbol: pair?.baseToken?.symbol || null, name: pair?.baseToken?.name || null },
    quote: { address: pair?.quoteToken?.address || null, symbol: pair?.quoteToken?.symbol || null, name: pair?.quoteToken?.name || null },
    priceUsd: finite(pair?.priceUsd), liquidityUsd: liquidity, volume24hUsd: volume24h, volume1hUsd: volume1h, volume5mUsd: finite(pair?.volume?.m5) ?? 0,
    priceChange24hPercent: priceChange24h, priceChange1hPercent: priceChange1h,
    fdvUsd: finite(pair?.fdv), marketCapUsd: finite(pair?.marketCap),
    pairCreatedAt: createdAt ? new Date(createdAt).toISOString() : null,
    ageHours: createdAt ? Math.max(0, (Date.now() - createdAt) / 3600000) : null,
    txns: { m5: pair?.txns?.m5 || null, h1: pair?.txns?.h1 || null, h24: pair?.txns?.h24 || null },
    labels: Array.isArray(pair?.labels) ? pair.labels.slice(0, 12) : []
  };
}

export function scoreAssetEvidence(asset) {
  const liquidity = Math.max(0, finite(asset.liquidityUsd) ?? 0);
  const volume = Math.max(0, finite(asset.volume24hUsd) ?? 0);
  const ratio = liquidity > 0 ? volume / liquidity : 0;
  const change = finite(asset.priceChange1hPercent) ?? 0;
  const buys = finite(asset.txns?.h1?.buys) ?? 0;
  const sells = finite(asset.txns?.h1?.sells) ?? 0;
  const txTotal = buys + sells;
  const buyRatio = txTotal ? buys / txTotal : null;
  const liquidityScore = clamp(Math.log10(Math.max(1, liquidity)) * 7, 0, 28);
  const activityScore = clamp(Math.log10(Math.max(1, volume)) * 5, 0, 25);
  const flowScore = buyRatio === null ? 8 : clamp((buyRatio - 0.35) * 35, 0, 18);
  const momentumScore = clamp(10 + change * 0.6, 0, 20);
  const turnoverScore = clamp(ratio * 8, 0, 9);
  const score = Math.round(clamp(liquidityScore + activityScore + flowScore + momentumScore + turnoverScore, 0, 100));
  const warnings = [];
  if (liquidity < 10000) warnings.push('low_liquidity');
  if (volume < 5000) warnings.push('low_24h_volume');
  if (!asset.base?.address || !asset.quote?.address) warnings.push('missing_token_address');
  if (asset.ageHours !== null && asset.ageHours < 24) warnings.push('new_pair_unverified');
  return { score, components: { liquidityScore, activityScore, flowScore, momentumScore, turnoverScore }, warnings,
    buyRatio, turnoverRatio: ratio, verdict: warnings.includes('missing_token_address') ? 'insufficient_evidence' : score >= 70 ? 'watchlist_candidate' : score >= 45 ? 'monitor' : 'low_priority',
    caveat: 'Heuristic discovery score only. It does not establish token safety, holder distribution, contract integrity, executable liquidity or expected returns.' };
}

export function summarizeBotMemory(events, now = Date.now()) {
  const trades = events.filter(e => e.eventType === 'bot_trade' && ['paper_closed', 'paper_exit'].includes(e.metadata?.action));
  const closed = trades.filter(e => e.metadata?.action === 'paper_closed');
  const pnl = closed.map(e => finite(e.metadata?.pnl)).filter(v => v !== null);
  let lossStreak = 0;
  for (const value of [...pnl].reverse()) { if (value < 0) lossStreak++; else break; }
  const dayAgo = now - 86400000;
  const today = closed.filter(e => Date.parse(e.occurredAt || e.ingestedAt) >= dayAgo);
  const todayPnl = today.reduce((sum, e) => sum + (finite(e.metadata?.pnl) ?? 0), 0);
  const wins = pnl.filter(v => v > 0).length;
  return { totalClosedTrades: closed.length, wins, losses: pnl.filter(v => v < 0).length,
    winRatePercent: pnl.length ? wins / pnl.length * 100 : null, recentLossStreak: lossStreak,
    rolling24hClosedTrades: today.length, rolling24hRealizedPnl: todayPnl,
    guard: lossStreak >= 3 ? 'pause_new_entries' : 'normal',
    source: 'JPTI append-only paper event journal', caveat: 'Only events successfully published by connected T-Bots runs are represented; this is not a complete exchange-account balance or portfolio PnL.' };
}
