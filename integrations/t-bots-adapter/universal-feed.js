import { LiveFeed } from './live-feed.js';

// Combines multi-chain DEX discovery with a user-configured JPTI centralized spot watchlist.
// It remains a paper feed: no exchange order or private trading permission is requested.
export class UniversalFeed extends LiveFeed {
  constructor({ bridge, ...options } = {}) {
    super({ maxTracked:150, ...options });
    this.bridge = bridge;
    this.kind = 'live-universal-paper';
    this.lastCexRefresh = 0;
    this.lastDexRefresh = 0;
    this.cexRefreshMs = 15000;
  }

  async tick() {
    await super.tick();
    if (!this.bridge?.enabled) return;
    const now = Date.now();
    if (now - this.lastDexRefresh >= this.cexRefreshMs) {
      this.lastDexRefresh = now;
      const dexResult = await this.bridge.refreshDexWatchlist();
      for (const pair of dexResult?.pairs || []) {
        const chain = String(pair.chain || 'unknown').toLowerCase();
        const address = pair.base?.address;
        if (!address) continue;
        const id = chain + ':' + address;
        let token = this.tokens.get(id);
        if (!token) {
          token = { id, chainId:chain, tokenAddress:address, source:'jpti-watchlist', tracked:true, hist:[], liqMax:0,
            security:undefined, holdHist:[], view:null, order:this.ticks };
          this.tokens.set(id, token);
        }
        token.source = 'jpti-watchlist';
        token.order = this.ticks;
        const mapped = {
          symbol:pair.base?.symbol || '?', dex:pair.dex || 'unknown',
          ageMin:pair.ageHours == null ? Infinity : pair.ageHours * 60,
          price:pair.priceUsd, change1hPct:pair.priceChange1hPercent ?? 0,
          liquidityUsd:pair.liquidityUsd ?? 0, volume5mUsd:pair.volume5mUsd ?? 0,
          volume5mAvgUsd:(pair.volume1hUsd ?? 0) / 12,
          buyRatio:(pair.txns?.m5?.buys || 0)+(pair.txns?.m5?.sells || 0)>0
            ? (pair.txns.m5.buys || 0)/((pair.txns.m5.buys || 0)+(pair.txns.m5.sells || 0)) : null,
          volume1hUsd:pair.volume1hUsd ?? 0, volume24hUsd:pair.volume24hUsd ?? 0,
          buys1h:pair.txns?.h1?.buys ?? 0, sells1h:pair.txns?.h1?.sells ?? 0,
          quoteAddress:pair.quote?.address || null, quoteSymbol:pair.quote?.symbol || null,
          pairAddress:pair.pairAddress
        };
        this._apply(token, mapped);
        if (token.view) Object.assign(token.view, {
          chain, tokenAddress:address, quoteAddress:mapped.quoteAddress, quoteSymbol:mapped.quoteSymbol,
          marketType:'dex', assetClass:'dex_token', volume1hUsd:mapped.volume1hUsd,
          volume24hUsd:mapped.volume24hUsd, buys1h:mapped.buys1h, sells1h:mapped.sells1h,
          fetchedAt:new Date(now).toISOString()
        });
      }
    }
    if (now - this.lastCexRefresh >= this.cexRefreshMs) {
      this.lastCexRefresh = now;
      const result = await this.bridge.refreshCexMarkets();
      for (const market of result?.markets || []) {
        const id = market.id;
        if (!id) continue;
        let token = this.tokens.get(id);
        if (!token) {
          token = { id, chainId:'cex', tokenAddress:market.base, tracked:true, hist:[], liqMax:0,
            security:{exchangeListed:true}, holdHist:[], view:null, order:this.ticks };
          this.tokens.set(id,token);
        }
        token.order=this.ticks;
        token.security={exchangeListed:true};
        token.m={...market};
        const prior=token.view;
        const high=Math.max(market.price||0,...token.hist.map(x=>x.price));
        if(Number.isFinite(market.price)&&market.price>0){
          token.hist.push({at:now,price:market.price});
          token.hist=token.hist.filter(x=>now-x.at<=3600000);
        }
        token.view={
          id,chain:'cex',tokenAddress:market.base,quoteAddress:market.quote,quoteSymbol:market.quote,
          marketType:'cex',assetClass:'crypto_spot',exchange:market.exchange,symbol:market.symbol,
          dex:market.exchange,ageMin:Infinity,price:market.price,change1hPct:market.change1hPct??0,
          pullbackPct:high>0?(1-market.price/high)*100:0,liquidityUsd:market.liquidityUsd??0,
          volume5mUsd:market.volume5mUsd??0,volume5mAvgUsd:market.volume5mAvgUsd??0,
          volume1hUsd:(market.volume5mUsd??0)*12,volume24hUsd:market.quoteVolume24h??0,rsi14:market.rsi14??null,
          buys1h:0,sells1h:0,buyRatio:null,holders:null,holderGrowth10mPct:null,
          smartWallets10m:null,kolBought:null,spreadPct:market.spreadPct,
          quoteVolume24h:market.quoteVolume24h,exchangeMarketActive:market.exchangeMarketActive===true,
          security:token.security,events:{devSold:false,lpPulled:false},dead:false,
          fetchedAt:market.fetchedAt,previousPrice:prior?.price??null
        };
      }
    }
  }
}
