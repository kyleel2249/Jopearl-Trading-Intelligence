const timestampOf = trade => {
  const value = Number(trade?.timestamp) || Date.parse(trade?.datetime || '') || 0;
  return Number.isFinite(value) ? value : 0;
};

export function fillSyncConfig(env = process.env) {
  const days = Number(env.JPTI_FILL_SYNC_LOOKBACK_DAYS ?? 7);
  const pageSize = Number(env.JPTI_FILL_SYNC_PAGE_SIZE ?? 250);
  const maxPages = Number(env.JPTI_FILL_SYNC_MAX_PAGES ?? 20);
  const overlapMinutes = Number(env.JPTI_FILL_SYNC_OVERLAP_MINUTES ?? 3);
  return {
    lookbackDays: Number.isFinite(days) ? Math.min(3650, Math.max(1, Math.floor(days))) : 7,
    pageSize: Number.isFinite(pageSize) ? Math.min(1000, Math.max(10, Math.floor(pageSize))) : 250,
    maxPages: Number.isFinite(maxPages) ? Math.min(100, Math.max(1, Math.floor(maxPages))) : 20,
    overlapMs: Number.isFinite(overlapMinutes) ? Math.min(60, Math.max(0, overlapMinutes)) * 60_000 : 180_000
  };
}

export function parseFillWatchlist(value = '') {
  return String(value).split(',').map(item => item.trim()).filter(Boolean).slice(0, 20).map(entry => {
    const split = entry.indexOf(':');
    if (split < 1 || split === entry.length - 1) throw new Error('Invalid fill watchlist entry: ' + entry);
    return { exchange: entry.slice(0, split).toLowerCase(), symbol: entry.slice(split + 1).toUpperCase() };
  });
}

export async function fetchPaginatedTrades({ fetchPage, since, until = Date.now(), pageSize = 250, maxPages = 20, onProgress = () => {} }) {
  if (typeof fetchPage !== 'function') throw new TypeError('fetchPage must be a function');
  let cursor = Math.max(0, Number(since) || 0);
  const end = Number(until);
  if (!Number.isFinite(end) || end <= cursor) throw new Error('The backfill end time must be later than its start time.');
  const tradesById = new Map();
  let pages = 0;
  let rawFetched = 0;
  let newestTimestamp = cursor;
  let exhausted = false;
  while (pages < maxPages && cursor < end) {
    const page = await fetchPage(cursor, pageSize);
    pages += 1;
    if (!Array.isArray(page)) throw new Error('Exchange trade-history response was not an array.');
    rawFetched += page.length;
    let pageNewest = cursor;
    for (const trade of page) {
      const timestamp = timestampOf(trade);
      if (!timestamp || timestamp > end || timestamp < 0) continue;
      pageNewest = Math.max(pageNewest, timestamp);
      const id = trade?.id == null ? null : String(trade.id);
      if (id) tradesById.set(id, trade);
    }
    newestTimestamp = Math.max(newestTimestamp, pageNewest);
    onProgress({ pages, rawFetched, uniqueTrades: tradesById.size, newestTimestamp, maxPages });
    if (page.length < pageSize) { exhausted = true; break; }
    if (pageNewest < cursor || pageNewest === cursor) { exhausted = false; break; }
    cursor = pageNewest + 1;
  }
  const trades = [...tradesById.values()].sort((a, b) => timestampOf(a) - timestampOf(b) || String(a.id).localeCompare(String(b.id)));
  return { trades, pages, rawFetched, uniqueTrades: trades.length, newestTimestamp, exhausted, pageLimitReached: !exhausted && pages >= maxPages };
}

export function normalizeExchangeTrade(exchangeId, trade, eventSchema, makeId) {
  if (!trade?.id || !trade.symbol || !['buy', 'sell'].includes(trade.side) || !(Number(trade.amount) > 0) || !(Number(trade.price) > 0)) return null;
  const [base, quote] = String(trade.symbol).split('/');
  if (!base || !quote) return null;
  const fee = trade.fee || {};
  const timestamp = timestampOf(trade);
  if (!timestamp) return null;
  const parsed = eventSchema.parse({
    source: exchangeId, eventType: 'fill', externalId: String(trade.id), accountId: exchangeId,
    symbol: trade.symbol, side: trade.side, quantity: Number(trade.amount), price: Number(trade.price),
    fee: Number(fee.cost || 0), feeCurrency: fee.currency || quote,
    occurredAt: new Date(timestamp).toISOString(),
    metadata: { base, quote, orderId: String(trade.order || ''), tradeId: String(trade.id), tradeType: String(trade.type || '') }
  });
  return { id: makeId(), kind: 'ledger-transaction', ...parsed, ingestedAt: new Date().toISOString() };
}
