const finite = value => Number.isFinite(Number(value)) && Number(value) > 0;
const levels = input => (Array.isArray(input) ? input : []).map(row => {
  const price = Number(row?.[0]), size = Number(row?.[1]);
  return finite(price) && Number.isFinite(size) && size >= 0 ? { price, size, notional: price * size } : null;
}).filter(Boolean);

export function normalizeOrderBookMessage(message) {
  const data = Array.isArray(message?.data) ? message.data[0] : null;
  if (!data || !Array.isArray(data.bids) || !Array.isArray(data.asks)) return null;
  const bids = levels(data.bids).sort((a,b) => b.price - a.price).slice(0,5);
  const asks = levels(data.asks).sort((a,b) => a.price - b.price).slice(0,5);
  if (!bids.length || !asks.length || bids[0].price >= asks[0].price) return null;
  return { bids, asks, timestamp: Number(data.ts || message.ts || Date.now()), receivedAt: Date.now(), sequence: data.seq ?? null };
}

export function analyzeOrderBook(book) {
  if (!book?.bids?.length || !book?.asks?.length) return { status:'unavailable' };
  const bids = book.bids.slice(0,5), asks = book.asks.slice(0,5);
  const bestBid = bids[0].price, bestAsk = asks[0].price;
  if (!(bestBid > 0 && bestAsk > bestBid)) return { status:'invalid' };
  const bidNotional = bids.reduce((sum,x)=>sum+x.notional,0), askNotional = asks.reduce((sum,x)=>sum+x.notional,0);
  const total = bidNotional + askNotional;
  const imbalance = total ? (bidNotional - askNotional) / total : 0;
  const bidSize = bids[0].size, askSize = asks[0].size;
  const mid = (bestBid + bestAsk) / 2;
  const microprice = bidSize + askSize > 0 ? (bestAsk * bidSize + bestBid * askSize) / (bidSize + askSize) : mid;
  const wallCandidates = [...bids.map(x=>({...x,side:'bid'})),...asks.map(x=>({...x,side:'ask'}))];
  const median = [...wallCandidates].map(x=>x.notional).sort((a,b)=>a-b)[Math.floor(wallCandidates.length/2)] || 0;
  const wall = wallCandidates.sort((a,b)=>b.notional-a.notional)[0];
  const dominantWall = median > 0 && wall.notional >= median * 2 ? { ...wall, multiple: wall.notional/median } : null;
  const maxBid = Math.max(...bids.map(x=>x.notional),1), maxAsk = Math.max(...asks.map(x=>x.notional),1);
  const spread = bestAsk-bestBid;
  return {
    status:'ready', bestBid, bestAsk, mid, spread,
    spreadBps: spread/mid*10000,
    bidNotional, askNotional, imbalancePct: Number((imbalance*100).toFixed(2)),
    imbalanceLabel: imbalance > .12 ? 'Bid depth dominant' : imbalance < -.12 ? 'Ask depth dominant' : 'Balanced visible depth',
    microprice, micropricePremiumBps: (microprice-mid)/mid*10000,
    bids: bids.map(x=>({...x,relative:x.notional/maxBid})),
    asks: asks.map(x=>({...x,relative:x.notional/maxAsk})),
    wall: dominantWall, timestamp:book.timestamp, receivedAt:book.receivedAt
  };
}
