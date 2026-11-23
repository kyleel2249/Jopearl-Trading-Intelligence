import test from 'node:test';
import assert from 'node:assert/strict';
import { UniversalFeed } from './universal-feed.js';

test('universal feed combines CEX spot watchlist with DEX discovery snapshot', async () => {
  const bridge={enabled:true,refreshDexWatchlist:async()=>({pairs:[{chain:'base',base:{address:'0xabc',symbol:'ABC'},quote:{address:'0xusd',symbol:'USDC'},dex:'uniswap',ageHours:48,priceUsd:1,priceChange1hPercent:2,liquidityUsd:50000,volume5mUsd:5000,volume1hUsd:30000,volume24hUsd:100000,txns:{m5:{buys:8,sells:2},h1:{buys:80,sells:20}}}]}),refreshCexMarkets:async()=>({markets:[{
    id:'cex:binance:BTC/USDT',exchange:'binance',symbol:'BTC/USDT',base:'BTC',quote:'USDT',
    price:65000,quoteVolume24h:250000000,liquidityUsd:500000,volume5mUsd:100000,
    volume5mAvgUsd:50000,change1hPct:1.2,spreadPct:0.02,exchangeMarketActive:true,fetchedAt:new Date().toISOString()
  }]})};
  const feed=new UniversalFeed({bridge,fetchImpl:async()=>({ok:true,json:async()=>[]})});
  await feed.tick();
  const market=feed.snapshot().find(x=>x.marketType==='cex');
  assert.ok(market);
  assert.equal(market.exchange,'binance');
  assert.equal(market.symbol,'BTC/USDT');
  assert.equal(market.security.exchangeListed,true);
  const dex=feed.snapshot().find(x=>x.tokenAddress==='0xabc');
  assert.ok(dex);
  assert.equal(dex.chain,'base');
  assert.equal(dex.marketType,'dex');
});

test('universal feed remains safe without a connected JPTI bridge', async () => {
  const feed=new UniversalFeed({bridge:null,fetchImpl:async()=>({ok:true,json:async()=>[]})});
  await feed.tick();
  assert.equal(feed.snapshot().length,0);
});
