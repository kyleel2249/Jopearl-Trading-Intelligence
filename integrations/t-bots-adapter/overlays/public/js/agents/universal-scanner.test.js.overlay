import test from 'node:test';
import assert from 'node:assert/strict';
import { ScannerAgent } from './scanner.js';
import { RugCheckAgent } from './rug-check.js';
import { DEFAULT_CONFIG, cloneConfig } from '../config.js';

const bus={emit(){}};
const cex={id:'cex:binance:BTC/USDT',symbol:'BTC/USDT',marketType:'cex',exchangeMarketActive:true,
  quoteVolume24h:1000000,liquidityUsd:50000,spreadPct:0.03,price:65000,change1hPct:1.5,
  volume5mUsd:20000,volume5mAvgUsd:10000,security:{exchangeListed:true},ageMin:Infinity};

test('CEX spot instruments use exchange liquidity and spread gates, not DEX mint checks',()=>{
  const cfg=cloneConfig(DEFAULT_CONFIG);cfg.scanner.assetProfile='established_token';
  const scanner=new ScannerAgent(bus,cfg);
  assert.equal(scanner.universe(cex).pass,true);
  assert.equal(scanner.universe({...cex,spreadPct:1}).pass,false);
  assert.equal(new RugCheckAgent(bus,cfg).check(cex).pass,true);
});

test('established token profile does not apply the new-pair age ceiling',()=>{
  const cfg=cloneConfig(DEFAULT_CONFIG);cfg.scanner.assetProfile='established_token';
  const scanner=new ScannerAgent(bus,cfg);
  const token={...cex,marketType:'dex',ageMin:60*24*365,security:{holders:500,devPct:1,top10Pct:20,lpLockedDays:60,
    bundledLaunch:false,honeypot:false,frozenMint:false,mintAuthorityOpen:false,lpUnlocked:false}};
  token.liquidityUsd=100000;token.volume5mUsd=30000;token.holders=500;
  assert.equal(scanner.universe(token).pass,true);
});

test('mean-reversion requires JPTI RSI evidence and DeFi rotation fails closed without protocol mapping',()=>{
  const meanCfg=cloneConfig(DEFAULT_CONFIG);meanCfg.scanner.assetProfile='mean_reversion';
  const scanner=new ScannerAgent(bus,meanCfg);
  const token={...cex,jptiEvidence:{score:80,rsi14:25}};
  assert.equal(scanner.universe(token).pass,true);
  assert.ok(scanner.signals(token).some(signal=>signal.key==='rsi-oversold'));
  assert.equal(scanner.universe({...cex,jptiEvidence:{score:80}}).pass,false);
  const defiCfg=cloneConfig(DEFAULT_CONFIG);defiCfg.scanner.assetProfile='defi_rotation';
  assert.equal(new ScannerAgent(bus,defiCfg).universe({...cex,jptiEvidence:{score:80}}).pass,false);
});
