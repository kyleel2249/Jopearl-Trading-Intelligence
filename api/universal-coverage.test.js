import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUniversalCoverage } from './universal-coverage.js';

test('coverage registry distinguishes public providers from unconfigured API providers', () => {
  const report=buildUniversalCoverage({},[]);
  assert.equal(report.assessment,'configuration_and_catalog_only');
  assert.equal(report.providers.dexscreener.public,true);
  assert.equal(report.providers.alpaca.configured,false);
  assert.equal(report.assetClasses.find(x=>x.id==='equities_etfs').status,'not_configured');
});

test('coverage registry reports configured equity and on-chain sources without claiming live health', () => {
  const report=buildUniversalCoverage({
    JPTI_ALPACA_API_KEY:'configured',JPTI_ALPACA_API_SECRET:'configured',
    JPTI_FINNHUB_API_KEY:'configured',JPTI_HELIUS_API_KEY:'configured'
  },[{id:'binance',capabilities:{fetchFundingRate:true}},{id:'kraken',capabilities:{fetchTicker:true}}]);
  const equity=report.assetClasses.find(x=>x.id==='equities_etfs');
  assert.equal(equity.status,'partial');
  assert.ok(equity.availableSources.includes('alpaca'));
  assert.ok(equity.missingSources.includes('twelvedata'));
  assert.equal(report.assetClasses.find(x=>x.id==='onchain').status,'partial');
  assert.equal(report.exchangeCatalog.supportedVenueCount,2);
  assert.equal(report.exchangeCatalog.derivativeCapableVenueCount,1);
  assert.ok(report.caveats.some(x=>x.includes('does not perform provider health checks')));
});

test('coverage registry counts configured watchlists but never exposes credential values', () => {
  const report=buildUniversalCoverage({
    JPTI_TBOTS_CEX_MARKETS:'binance:BTC/USDT,bitget:ETH/USDT',
    JPTI_TBOTS_DEX_WATCHLIST:'solana:So11111111111111111111111111111111111111112',
    JPTI_FINNHUB_API_KEY:'do-not-return-this'
  },[]);
  assert.equal(report.watchlists.cexEntriesConfigured,2);
  assert.equal(report.watchlists.dexEntriesConfigured,1);
  assert.equal(JSON.stringify(report).includes('do-not-return-this'),false);
});
