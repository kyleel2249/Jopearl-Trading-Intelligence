// public/js/agents/rug-check.js
// RUG CHECK: nothing executes without a PASS. Missing data fails closed.

import { BaseAgent } from './base.js';

export class RugCheckAgent extends BaseAgent {
  constructor(bus, cfg) {
    super('RUG', 'Rug Check', bus, { badge: 'PASS', hint: 'filters suspicious tokens' });
    this.cfg = cfg;
    this.set('idle', 'nothing executes before a pass');
  }

  check(t) {
    if (t.marketType === 'cex') {
      const pass = t.exchangeMarketActive === true && t.spreadPct != null && t.spreadPct <= 0.5 && t.quoteVolume24h >= 100000 && t.liquidityUsd >= 10000;
      this.bump(pass ? 'passed' : 'filtered');
      this.set(pass ? 'pass' : 'fail', `${pass ? 'exchange market verified' : 'exchange market rejected'} ${t.symbol}`);
      return { pass, reasons: pass ? [] : ['CEX market activity, spread, quote volume or visible depth failed the exchange-market gate'] };
    }
    const r = this.cfg.rug;
    const s = t.security;
    const fail = [];
    if (!s) fail.push('no security data');
    else {
      const bad = (v) => v === null || v === undefined || Number.isNaN(v);
      if (bad(s.devPct) || s.devPct >= r.devMaxPct) fail.push(`dev wallet ${bad(s.devPct) ? 'unknown' : s.devPct.toFixed(1) + '%'} ≥ ${r.devMaxPct}%`);
      if (bad(s.top10Pct) || s.top10Pct >= r.top10MaxPct) fail.push(`top 10 hold ${bad(s.top10Pct) ? 'unknown' : s.top10Pct.toFixed(0) + '%'} ≥ ${r.top10MaxPct}%`);
      if (r.noBundled && s.bundledLaunch) fail.push('bundled launch');
      if (!(s.lpLockedDays >= r.lpLockMinDays)) fail.push('LP not burned');
      if (r.requireSellSim && s.honeypot) fail.push('honeypot on sell simulation');
    }
    const pass = fail.length === 0;
    this.bump(pass ? 'passed' : 'filtered');
    this.set(pass ? 'pass' : 'fail', `${pass ? 'passed' : 'filtered'} $${t.symbol}`);
    return { pass, reasons: fail };
  }
}
