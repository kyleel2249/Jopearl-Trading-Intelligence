// public/js/market/live-feed.js
// Live market data for paper trading: DexScreener (pairs, price, liquidity, volume, txns)
// and RugCheck (holders, authorities, LP, bundling). Both are public HTTP APIs; if a field
// is missing the token carries `security: null` or null signals and the agents fail closed.
//
// Smart-money and KOL wallet activity is not exposed by these APIs, so those two signals
// are reported as null (unavailable) and the Scanner works with the remaining signals.
// The field mappings below follow the public API shapes and are covered by fixture tests;
// verify them against the live responses in your own environment.

const DS = 'https://api.dexscreener.com';
const RC = 'https://api.rugcheck.xyz';
const GP = 'https://api.gopluslabs.io/api/v1';
const GOPLUS_CHAIN_IDS = { ethereum: '1', bsc: '56', polygon: '137', arbitrum: '42161', optimism: '10', base: '8453', avalanche: '43114', linea: '59144', blast: '81457' };
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export function mapPair(p, now = Date.now()) {
  const buys = num(p?.txns?.m5?.buys) ?? 0;
  const sells = num(p?.txns?.m5?.sells) ?? 0;
  return {
    id: p?.baseToken?.address,
    quoteAddress: p?.quoteToken?.address,
    quoteSymbol: p?.quoteToken?.symbol,
    volume1hUsd: num(p?.volume?.h1),
    volume24hUsd: num(p?.volume?.h24),
    buys1h: num(p?.txns?.h1?.buys) ?? 0,
    sells1h: num(p?.txns?.h1?.sells) ?? 0,
    chainId: String(p?.chainId || 'unknown').toLowerCase(),
    tokenAddress: p?.baseToken?.address,
    symbol: String(p?.baseToken?.symbol || '?').slice(0, 12),
    dex: p?.dexId || 'unknown',
    ageMin: p?.pairCreatedAt ? (now - p.pairCreatedAt) / 60000 : Infinity,
    price: num(p?.priceUsd),
    liquidityUsd: num(p?.liquidity?.usd),
    volume5mUsd: num(p?.volume?.m5),
    volume5mAvgUsd: (num(p?.volume?.h1) ?? 0) / 12,
    buyRatio: buys + sells > 0 ? buys / (buys + sells) : null,
    change1hPct: num(p?.priceChange?.h1) ?? 0,
  };
}

export function mapRugCheck(report, now = Date.now()) {
  if (!report || typeof report !== 'object') return null;
  const top = Array.isArray(report.topHolders) ? report.topHolders : [];
  const risks = Array.isArray(report.risks) ? report.risks : [];
  const creator = report.creator;
  const lpPct = num(report.markets?.[0]?.lp?.lpLockedPct);
  const locked = lpPct !== null && lpPct >= 95;
  const lockRows = (report.markets || []).flatMap(m => Array.isArray(m.lp?.lockers) ? m.lp.lockers : []);
  const lockEnds = lockRows.map(row => num(row.lockedUntil ?? row.endTime ?? row.end_time)).filter(v => v !== null).map(v => v < 1e12 ? v * 1000 : v);
  const lpLockedDays = lockEnds.length ? Math.max(0, (Math.max(...lockEnds) - now) / 86400000) : 0;
  const hasRisk = (re) => risks.some((r) => re.test(`${r?.name || ''} ${r?.description || ''}`));
  return {
    holders: num(report.totalHolders),
    frozenMint: report.freezeAuthority !== null && report.freezeAuthority !== undefined,
    mintAuthorityOpen: report.mintAuthority !== null && report.mintAuthority !== undefined,
    lpUnlocked: lpPct === null ? true : !locked,
    devPct: creator ? num(top.find((h) => h?.address === creator)?.pct) ?? 0 : null,
    top10Pct: top.length ? top.slice(0, 10).reduce((a, h) => a + (num(h?.pct) ?? 0), 0) : null,
    bundledLaunch: hasRisk(/bundl|sniper/i),
    lpLockedPercent: lpPct,
    lpLockedDays, // Only explicit lock end timestamps count; a locked percentage alone does not prove duration.
    honeypot: hasRisk(/honeypot|cannot sell|unable to sell/i),
  };
}

export class LiveFeed {
  constructor({ fetchImpl, now = () => Date.now(), maxTracked = 60, profileEveryTicks = 2 } = {}) {
    this.kind = 'live';
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.now = now;
    this.maxTracked = maxTracked;
    this.profileEvery = profileEveryTicks;
    this.ticks = 0;
    this.tokens = new Map();
    this.errors = [];
  }

  async init() {}

  async _json(url) {
    try {
      const res = await this.fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      this.errors.push(`${url.split('?')[0]}: ${err.message}`);
      if (this.errors.length > 20) this.errors.shift();
      return null;
    }
  }

  async tick() {
    this.ticks++;
    if (this.ticks % this.profileEvery === 1) await this._discover();
    await this._refresh();
    await this._enrich();
  }

  async _discover() {
    const list = await this._json(`${DS}/token-profiles/latest/v1`);
    if (!Array.isArray(list)) return;
    for (const p of list) {
      if (!p.chainId || !p.tokenAddress) continue;
      const id = `${String(p.chainId).toLowerCase()}:${p.tokenAddress}`;
      if (this.tokens.has(id)) continue;
      this.tokens.set(id, { id, chainId: String(p.chainId).toLowerCase(), tokenAddress: p.tokenAddress, tracked: true, hist: [], liqMax: 0, security: undefined, holdHist: [], view: null, order: this.ticks });
    }
    const ids = [...this.tokens.values()].sort((a, b) => b.order - a.order);
    for (const stale of ids.slice(this.maxTracked)) if (stale.chainId !== 'cex' && stale.source !== 'jpti-watchlist' && !stale.view?.__open) this.tokens.delete(stale.id);
  }

  async _refresh() {
    const byChain = new Map();
    for (const token of this.tokens.values()) {
      if (token.chainId === 'cex') continue;
      const rows = byChain.get(token.chainId) || [];
      rows.push(token);
      byChain.set(token.chainId, rows);
    }
    for (const [chain, tokens] of byChain) {
      const addresses = tokens.map(t => t.tokenAddress);
      for (let i = 0; i < addresses.length; i += 30) {
        const batch = addresses.slice(i, i + 30);
        const pairs = await this._json(`${DS}/tokens/v1/${encodeURIComponent(chain)}/${batch.join(',')}`);
        if (!Array.isArray(pairs)) continue;
        const best = new Map();
        for (const pair of pairs) {
          const address = pair?.baseToken?.address;
          if (!address) continue;
          const liq = num(pair?.liquidity?.usd) ?? 0;
          if (!best.has(address) || liq > (num(best.get(address)?.liquidity?.usd) ?? 0)) best.set(address, pair);
        }
        for (const [address, pair] of best) {
          const token = this.tokens.get(`${chain}:${address}`);
          this._apply(token, mapPair(pair, this.now()));
        }
      }
    }
  }

  _apply(t, m) {
    if (!t || m.price === null) return;
    const now = this.now();
    t.hist.push({ at: now, price: m.price });
    t.hist = t.hist.filter((h) => now - h.at <= 3600000);
    const high = Math.max(...t.hist.map((h) => h.price));
    const liq = m.liquidityUsd ?? 0;
    t.liqMax = Math.max(t.liqMax, liq);
    const lpPulled = t.liqMax > 0 && liq < t.liqMax * 0.3;
    if (t.security && t.security.holders !== null) {
      t.holdHist.push({ at: now, n: t.security.holders });
      t.holdHist = t.holdHist.filter((h) => now - h.at <= 900000);
    }
    const old = t.holdHist.find((h) => now - h.at >= 600000 - 30000);
    t.m = m;
    t.view = {
      id: t.id,
      chain: t.chainId,
      tokenAddress: t.tokenAddress,
      symbol: m.symbol,
      dex: m.dex,
      ageMin: m.ageMin,
      price: m.price,
      change1hPct: m.change1hPct,
      pullbackPct: (1 - m.price / high) * 100,
      liquidityUsd: liq,
      volume5mUsd: m.volume5mUsd ?? 0,
      volume1hUsd: m.volume1hUsd ?? 0,
      volume24hUsd: m.volume24hUsd ?? 0,
      buys1h: m.buys1h ?? 0,
      sells1h: m.sells1h ?? 0,
      quoteAddress: m.quoteAddress || null,
      quoteSymbol: m.quoteSymbol || null,
      volume5mAvgUsd: m.volume5mAvgUsd,
      buyRatio: m.buyRatio,
      holders: t.security?.holders ?? 0,
      holderGrowth10mPct: old && t.security?.holders ? (t.security.holders / old.n - 1) * 100 : null,
      smartWallets10m: null,
      kolBought: null,
      security: t.security === undefined ? null : t.security,
      events: { devSold: false, lpPulled },
      dead: lpPulled,
    };
  }

  async _enrich() {
    let budget = 8;
    for (const token of this.tokens.values()) {
      if (token.chainId === 'cex') continue;
      if (budget <= 0) break;
      const market = token.m;
      if (token.security !== undefined || !market) continue;
      if ((market.liquidityUsd ?? 0) < 1 || (market.volume5mUsd ?? 0) < 1) continue;
      budget--;
      if (token.chainId === 'solana') {
        const report = await this._json(`${RC}/v1/tokens/${token.tokenAddress}/report`);
        token.security = mapRugCheck(report);
      } else if (GOPLUS_CHAIN_IDS[token.chainId]) {
        const report = await this._json(`${GP}/token_security/${GOPLUS_CHAIN_IDS[token.chainId]}?contract_addresses=${encodeURIComponent(token.tokenAddress)}`);
        const item = report?.result?.[token.tokenAddress.toLowerCase()] || report?.result?.[token.tokenAddress];
        if (item) {
          const holders = Array.isArray(item.holders) ? item.holders : [];
          const lpRows = Array.isArray(item.lp_holders) ? item.lp_holders : [];
          const locked = lpRows.some(row => row.is_locked === '1' || row.is_locked === 1);
          const lockEnds = lpRows.map(row => num(row?.locked_detail?.[0]?.end_time)).filter(Boolean);
          const lockDays = locked && lockEnds.length ? Math.max(0, (Math.max(...lockEnds) * 1000 - this.now()) / 86400000) : 0;
          const holderPercents = holders.slice(0, 10).map(row => num(row.percent)).filter(v => v !== null);
          const mintable = item.is_mintable;
          const blacklisted = item.is_blacklisted === '1';
          const honeypot = item.is_honeypot === '1' || item.cannot_sell_all === '1' || blacklisted;
          const sellTax = num(item.sell_tax);
          const buyTax = num(item.buy_tax);
          token.security = {
            holders: num(item.holder_count),
            // Treat unknown mintability as unsafe; proxy/hidden-owner/blacklist flags are conservative risk blocks.
            frozenMint: blacklisted || item.hidden_owner === '1' || item.is_proxy === '1',
            mintAuthorityOpen: mintable !== '0',
            lpUnlocked: !locked,
            devPct: num(item.creator_percent) === null ? null : Number(item.creator_percent) * 100,
            top10Pct: holderPercents.length ? holderPercents.reduce((sum, v) => sum + v * 100, 0) : null,
            bundledLaunch: false,
            lpLockedDays: lockDays,
            honeypot: honeypot || sellTax === null || sellTax > 0.10 || buyTax === null || buyTax > 0.10,
            source: 'GoPlus token security'
          };
        }
      }
      // Unknown chains or incomplete security responses fail closed in the Rug Check agent.
      if (token.security === null || token.security === undefined) token.security = {
        failedLookup: true, frozenMint: true, mintAuthorityOpen: true, lpUnlocked: true,
        devPct: null, top10Pct: null, bundledLaunch: true, lpLockedDays: 0, honeypot: true, holders: 0
      };
      if (token.view) {
        token.view.security = token.security;
        token.view.holders = token.security.holders ?? 0;
      }
    }
  }

  snapshot() {
    return [...this.tokens.values()].map((t) => t.view).filter((v) => v && v.price !== null);
  }
  get(id) {
    return this.tokens.get(id)?.view;
  }
  canSell() {
    return true;
  }
}
