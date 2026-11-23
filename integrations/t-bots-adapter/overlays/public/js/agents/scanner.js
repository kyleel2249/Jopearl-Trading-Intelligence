// public/js/agents/scanner.js
// SCANNER: watches new pairs, applies the universe filter and counts signals.
// It flags only. It never trades.

import { BaseAgent } from './base.js';

export class ScannerAgent extends BaseAgent {
  constructor(bus, cfg) {
    super('SCANNER', 'Scanner', bus, { badge: 'SCAN', hint: 'smart money + KOL wallets' });
    this.cfg = cfg;
  }

  /** Universe gate: age, liquidity, volume, holders, mint / LP flags. */
  universe(t) {
    const u = this.cfg.universe;
    const profile = this.cfg.scanner.assetProfile || 'meme_new_pair';
    const profiles = {
      meme_new_pair: { maxAgeHours:u.maxAgeHours, minLiquidityUsd:u.minLiquidityUsd, minVolume5mUsd:u.minVolume5mUsd, minHolders:u.minHolders },
      established_token: { maxAgeHours:Infinity, minLiquidityUsd:Math.max(40000,u.minLiquidityUsd), minVolume5mUsd:Math.max(10000,u.minVolume5mUsd/2), minHolders:Math.min(300,u.minHolders) },
      defi_rotation: { maxAgeHours:Infinity, minLiquidityUsd:Math.max(100000,u.minLiquidityUsd), minVolume5mUsd:Math.max(10000,u.minVolume5mUsd/2), minHolders:Math.min(300,u.minHolders) },
      breakout: { maxAgeHours:Infinity, minLiquidityUsd:Math.max(50000,u.minLiquidityUsd), minVolume5mUsd:Math.max(10000,u.minVolume5mUsd/2), minHolders:Math.min(300,u.minHolders) },
      mean_reversion: { maxAgeHours:Infinity, minLiquidityUsd:Math.max(75000,u.minLiquidityUsd), minVolume5mUsd:Math.max(10000,u.minVolume5mUsd/2), minHolders:Math.min(300,u.minHolders) }
    };
    const active = profiles[profile] || profiles.meme_new_pair;
    if (t.marketType === 'cex') {
      const why=[];
      if(t.exchangeMarketActive!==true)why.push('exchange market inactive or unavailable');
      if(!(t.quoteVolume24h>=100000))why.push('24h quote volume below $100k');
      if(!(t.liquidityUsd>=10000))why.push('visible order-book depth below $10k');
      if(t.spreadPct===null||t.spreadPct===undefined||t.spreadPct>0.5)why.push('spread unavailable or above 0.5%');
      if(!(t.price>0))why.push('invalid market price');
      if(profile==='mean_reversion'&&t.jptiEvidence?.rsi14==null)why.push('JPTI RSI14 unavailable for mean-reversion profile');
      if(profile==='defi_rotation')why.push('CEX instruments do not have a verified DeFi protocol mapping');
      return {pass:why.length===0,pending:false,reasons:why};
    }
    if (t.security === null || t.security === undefined) return { pass: false, pending: true, reasons: ['security data pending'] };
    const sec = t.security;
    const why = [];
    if(profile==='defi_rotation'&&(!t.jptiEvidence?.protocolVerified||t.jptiEvidence?.tvlChangePct==null||t.jptiEvidence?.feesChangePct==null||t.jptiEvidence?.protocolRiskScore==null))why.push('verified protocol mapping, TVL, fees and protocol-risk evidence required; monitor only until available');
    if(profile==='mean_reversion'&&t.jptiEvidence?.rsi14==null)why.push('JPTI RSI14 unavailable for mean-reversion profile');
    if (Number.isFinite(active.maxAgeHours) && !(t.ageMin <= active.maxAgeHours * 60)) why.push(`older than ${active.maxAgeHours}h`);
    if (!(t.liquidityUsd >= active.minLiquidityUsd)) why.push('liquidity below minimum');
    if (!(t.volume5mUsd >= active.minVolume5mUsd)) why.push('5m volume below minimum');
    if (!(t.holders >= active.minHolders)) why.push('holders below minimum');
    if (u.skipFrozenMint && sec.frozenMint) why.push('frozen mint');
    if (u.skipOpenMintAuthority && sec.mintAuthorityOpen) why.push('open mint authority');
    if (u.skipLpUnlocked && sec.lpUnlocked) why.push('LP unlocked');
    return { pass: why.length === 0, pending: false, reasons: why };
  }

  /** Returns the signals that fired. A null input means the data source cannot supply it. */
  signals(t) {
    const c = this.cfg.scanner;
    const out = [];
    const spike = t.volume5mAvgUsd > 0 ? t.volume5mUsd / t.volume5mAvgUsd : 0;
    if (spike > c.volumeSpikeX) out.push({ key: 'volume', label: `volume ${spike.toFixed(1)}×` });
    if (t.buyRatio !== null && t.buyRatio > c.buyRatioMin) out.push({ key: 'buys', label: `buys ${Math.round(t.buyRatio * 100)}% of flow` });
    if (t.holderGrowth10mPct !== null && t.holderGrowth10mPct >= c.holderGrowthMinPct) out.push({ key: 'holders', label: `holders +${t.holderGrowth10mPct.toFixed(0)}% / 10m` });
    if (t.smartWallets10m !== null && t.smartWallets10m >= c.smartWallets.min) out.push({ key: 'smart', label: `${t.smartWallets10m} smart wallets in` });
    if (t.kolBought === true) out.push({ key: 'kol', label: 'KOL bought' });
    const profile = this.cfg.scanner.assetProfile || 'meme_new_pair';
    if ((profile !== 'meme_new_pair' || t.marketType === 'cex') && Number.isFinite(t.change1hPct) && Math.abs(t.change1hPct) >= 1) out.push({ key: 'momentum', label: `1h momentum ${t.change1hPct >= 0 ? '+' : ''}${t.change1hPct.toFixed(1)}%` });
    if (t.jptiEvidence && t.jptiEvidence.score >= 45) out.push({ key: 'jpti-evidence', label: `JPTI evidence ${t.jptiEvidence.score}/100` });
    if (profile === 'mean_reversion' && Number.isFinite(t.jptiEvidence?.rsi14) && t.jptiEvidence.rsi14 <= 30) out.push({ key: 'rsi-oversold', label: `RSI14 oversold ${t.jptiEvidence.rsi14.toFixed(1)}` });
    return out;
  }

  scan(t) {
    const universe = this.universe(t);
    if (!universe.pass) return { flag: false, universe, signals: [] };
    const signals = this.signals(t);
    const flag = signals.length >= this.cfg.scanner.minSignals;
    if (flag) {
      this.bump('flags');
      this.set('live', `flagged $${t.symbol} · ${signals.length} signals`);
    }
    return { flag, universe, signals };
  }
}
