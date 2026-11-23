import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from './lib/api.js';

const macroSeries = [
  ['FEDFUNDS', 'Fed funds rate'], ['CPIAUCSL', 'US CPI'], ['UNRATE', 'US unemployment'],
  ['DGS10', 'US 10Y Treasury'], ['DTWEXBGS', 'US dollar index proxy']
];
const fmt = (value, digits = 2) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
const usd = (value) => value == null ? '—' : '$' + fmt(value, 0);

export default function FinancialIntelligence() {
  const [overview, setOverview] = useState(null);
  const [macro, setMacro] = useState({});
  const [address, setAddress] = useState('');
  const [chain, setChain] = useState('ethereum');
  const [wallet, setWallet] = useState(null);
  const [walletError, setWalletError] = useState('');
  const [loading, setLoading] = useState(false);
  const [scoreInput, setScoreInput] = useState({ priceChangePct: '', volumeChangePct: '', netExchangeFlow: '', stablecoinSupplyChangePct: '', macroBias: 'neutral' });
  const [score, setScore] = useState(null);
  const [scoreError, setScoreError] = useState('');
  const [error, setError] = useState('');
  const [providerStatus, setProviderStatus] = useState(null);
  const [providerError, setProviderError] = useState('');

  const loadProviders = useCallback(async () => { try { const response = await apiFetch('/api/providers'); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Provider registry unavailable'); setProviderStatus(data); setProviderError(''); } catch (e) { setProviderError(e.message); } }, []);

  const loadOverview = useCallback(async () => {
    try {
      const response = await apiFetch('/api/intelligence/overview', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Market intelligence request failed');
      setOverview(payload);
      setError('');
    } catch (e) { setError(e.message); }
  }, []);

  const loadMacro = useCallback(async () => {
    const entries = await Promise.all(macroSeries.map(async ([id, label]) => {
      try {
        const response = await apiFetch('/api/intelligence/macro/' + id + '?limit=2');
        const data = await response.json();
        if (!response.ok) return [id, { label, error: data.error || 'Unavailable' }];
        return [id, { label, latest: data.observations?.[0], previous: data.observations?.[1], source: data.source }];
      } catch (e) { return [id, { label, error: e.message }]; }
    }));
    setMacro(Object.fromEntries(entries));
  }, []);

  useEffect(() => {
    loadOverview();
    loadMacro();
    loadProviders();
    const timer = setInterval(loadOverview, 60000);
    return () => clearInterval(timer);
  }, [loadOverview, loadMacro, loadProviders]);

  const inspectWallet = async (event) => {
    event.preventDefault();
    setLoading(true); setWallet(null); setWalletError('');
    try {
      const path = chain === 'solana'
        ? '/api/intelligence/onchain/solana/' + encodeURIComponent(address) + '/transactions?limit=30'
        : '/api/intelligence/onchain/evm/' + chain + '/' + encodeURIComponent(address) + '/transfers?limit=30';
      const response = await apiFetch(path, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Wallet query failed');
      setWallet(data);
    } catch (e) { setWalletError(e.message); }
    finally { setLoading(false); }
  };

  const global = overview?.global;
  const market = global?.market_cap_percentage || {};
  return <section className="intel-page">
    <div className="intel-intro"><div><b>GLOBAL FINANCIAL & ON-CHAIN INTELLIGENCE</b><p>Cross-market context from public data providers, macroeconomic series and address-level blockchain history.</p></div><button onClick={() => { loadOverview(); loadMacro(); loadProviders(); }}>Refresh data</button></div>
    {error && <div className="intel-warning">{error}</div>}
    <div className="intel-grid">
      <article className="intel-card"><small>GLOBAL CRYPTO MARKET CAP</small><strong>{usd(global?.total_market_cap?.usd)}</strong><span>24h change: {fmt(global?.market_cap_change_percentage_24h_usd)}%</span></article>
      <article className="intel-card"><small>24H GLOBAL VOLUME</small><strong>{usd(global?.total_volume?.usd)}</strong><span>Aggregate provider-reported volume</span></article>
      <article className="intel-card"><small>BTC DOMINANCE</small><strong>{fmt(market.btc)}%</strong><span>ETH: {fmt(market.eth)}%</span></article>
      <article className="intel-card"><small>DATA SNAPSHOT</small><strong>{overview?.generatedAt ? new Date(overview.generatedAt).toLocaleTimeString() : '—'}</strong><span>Refreshes every 60 seconds</span></article>
    </div>
    <div className="intel-columns">
      <article className="intel-card"><div className="intel-head"><b>MACROECONOMIC DASHBOARD</b><span>FRED · US reference indicators</span></div><div className="macro-grid">{macroSeries.map(([id]) => { const item = macro[id] || {}; return <div className="macro-item" key={id}><small>{item.label || id}</small>{item.error ? <span className="intel-muted">{item.error}</span> : <><strong>{item.latest?.value ?? '—'}{id === 'FEDFUNDS' || id === 'UNRATE' || id === 'DGS10' ? '%' : ''}</strong><span>{item.latest?.date || 'Awaiting data'}{item.previous?.value && item.latest?.value ? ' · prev ' + item.previous.value : ''}</span></>}</div>; })}</div><p className="intel-note">Requires a server-side FRED API key. Values are published observations, not real-time market quotes. CPI is an index level, not a percentage.</p></article>
      <article className="intel-card"><div className="intel-head"><b>DEFI & LIQUIDITY LANDSCAPE</b><span>DeFiLlama</span></div><div className="intel-list"><div><span>Stablecoin circulating supply (USD)</span><strong>{usd(overview?.stablecoins?.totalCirculatingUsd)}</strong></div>{(overview?.chains || []).slice(0, 8).map((item) => <div key={item.name}><span>{item.name} TVL</span><strong>{usd(item.tvl)}</strong></div>)}</div><p className="intel-note">TVL and stablecoin supply are ecosystem context measures; they are not direct evidence of imminent price direction.</p></article>
    </div>
    <div className="intel-columns">
      <article className="intel-card"><div className="intel-head"><b>PROTOCOL FEES LEADERS</b><span>24-hour provider totals</span></div><div className="intel-list">{(overview?.protocolFees || []).slice(0, 8).map((item) => <div key={item.name}><span>{item.name}</span><strong>{usd(item.total24h)}</strong></div>)}{!overview?.protocolFees?.length && <span className="intel-muted">Waiting for provider data</span>}</div></article>
      <article className="intel-card"><div className="intel-head"><b>ON-CHAIN ADDRESS INTELLIGENCE</b><span>Read-only address lookup</span></div><form className="wallet-form" onSubmit={inspectWallet}><select value={chain} onChange={(e) => { setChain(e.target.value); setWallet(null); }}><option value="ethereum">Ethereum</option><option value="base">Base</option><option value="polygon">Polygon</option><option value="arbitrum">Arbitrum</option><option value="optimism">Optimism</option><option value="solana">Solana</option></select><input value={address} onChange={(e) => setAddress(e.target.value.trim())} placeholder={chain === 'solana' ? 'Solana wallet address' : '0x wallet address'} required/><button disabled={loading || !address}>{loading ? 'Querying…' : 'Inspect address'}</button></form>{walletError && <p className="intel-warning">{walletError}</p>}{wallet && <><p className="intel-note">{wallet.count} records · {wallet.source?.name} · {wallet.source?.coverage}</p><div className="wallet-results">{(wallet.transfers || wallet.transactions || []).slice(0, 12).map((tx, i) => <div key={tx.uniqueId || tx.signature || tx.hash || i}><b>{tx.asset || tx.type || tx.description || 'Transaction'}</b><span>{tx.value ?? tx.amount ?? ''} {tx.category || tx.type || ''}</span><a href={chain === 'solana' ? 'https://solscan.io/tx/' + (tx.signature || '') : 'https://' + (chain === 'ethereum' ? 'etherscan.io' : chain === 'base' ? 'basescan.org' : chain === 'polygon' ? 'polygonscan.com' : chain === 'arbitrum' ? 'arbiscan.io' : 'optimistic.etherscan.io') + '/tx/' + (tx.hash || '')} target="_blank" rel="noreferrer">View transaction</a></div>)}</div></>}</article>
    </div>

    <article className="intel-card"><div className="intel-head"><b>EXPLAINABLE STRATEGY CONTEXT LAB</b><span>Research scoring · no orders</span></div><p className="intel-note">Enter measured changes from your selected market and validated wallet/flow sources. Leave unavailable fields blank; JPTI will not invent missing evidence.</p><form className="score-form" onSubmit={async (event) => { event.preventDefault(); setScoreError(''); setScore(null); const body = { macroBias: scoreInput.macroBias }; for (const key of ['priceChangePct','volumeChangePct','netExchangeFlow','stablecoinSupplyChangePct']) if (scoreInput[key] !== '') body[key] = Number(scoreInput[key]); try { const response = await apiFetch('/api/intelligence/score', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Scoring request failed'); setScore(data); } catch (e) { setScoreError(e.message); } }}><label>Price change %<input type="number" step="any" value={scoreInput.priceChangePct} onChange={e=>setScoreInput(v=>({...v,priceChangePct:e.target.value}))} placeholder="e.g. 2.4"/></label><label>Volume change %<input type="number" step="any" value={scoreInput.volumeChangePct} onChange={e=>setScoreInput(v=>({...v,volumeChangePct:e.target.value}))} placeholder="e.g. 35"/></label><label>Net exchange flow<input type="number" step="any" value={scoreInput.netExchangeFlow} onChange={e=>setScoreInput(v=>({...v,netExchangeFlow:e.target.value}))} placeholder="Negative = net outflow"/></label><label>Stablecoin supply change %<input type="number" step="any" value={scoreInput.stablecoinSupplyChangePct} onChange={e=>setScoreInput(v=>({...v,stablecoinSupplyChangePct:e.target.value}))} placeholder="e.g. 1.2"/></label><label>Macro regime<select value={scoreInput.macroBias} onChange={e=>setScoreInput(v=>({...v,macroBias:e.target.value}))}><option value="neutral">Neutral / unknown</option><option value="risk-on">Risk-on</option><option value="risk-off">Risk-off</option></select></label><button>Calculate evidence score</button></form>{scoreError && <p className="intel-warning">{scoreError}</p>}{score && <div className="score-result"><b>{score.direction.toUpperCase()}</b><strong>Score {score.score} · {score.confidence} evidence confidence</strong>{score.evidence.map((item)=><div key={item.factor}><span>{item.factor}: {String(item.value)}</span><em>{item.contribution > 0 ? '+' : ''}{item.contribution}</em></div>)}<p>{score.caveat}</p></div>}</article>

    <article className="intel-card provider-registry"><div className="intel-head"><b>CONNECTED DATA PROVIDER REGISTRY</b><span>Server-side adapters · credentials never exposed</span></div>
      {providerError && <p className="intel-warning">{providerError}</p>}
      <div className="provider-grid">{(providerStatus?.providers || []).map((item) => <div className="provider-item" key={item.id}><div><b>{item.name}</b><span className={item.status === 'credentials-configured-not-verified' || item.status === 'public-or-no-key' ? 'provider-ready' : 'provider-missing'}>{item.status === 'credentials-configured-not-verified' ? 'KEY CONFIGURED · VERIFY CONNECTION' : item.status === 'public-or-no-key' ? 'PUBLIC / NO KEY' : 'NEEDS API KEY'}</span></div><small>{item.capabilities.join(' · ')}</small><a href={item.docs} target="_blank" rel="noreferrer">Provider documentation ↗</a>{item.caveat && <small>{item.caveat}</small>}</div>)}</div>
      <div className="interval-grid"><b>OPERATIONAL INTERVALS</b>{Object.entries(providerStatus?.intervals || {}).filter(([key]) => key !== 'schedulerEnabled').map(([key,value]) => <div key={key}><span>{key.replace(/([A-Z])/g,' $1')}</span><strong>{value}s</strong></div>)}</div>
      <p className="intel-note">Intervals are server configuration values. They do not assert that a market-making engine, portfolio reconciler or investor-monitor worker is active. Live provider verification, account permissions, plan entitlements and rate limits are checked at request time.</p>
    </article>

    <article className="intel-card"><div className="intel-head"><b>DATA SOURCE HEALTH & COVERAGE</b><span>Provenance attached to each provider response</span></div><div className="source-grid">{(overview?.sources || []).map((item) => <div key={item.name}><i className={item.status === 'live' ? 'source-live' : 'source-down'}/><b>{item.name}</b><span>{item.status} · {new Date(item.fetchedAt).toLocaleTimeString()}</span>{item.error && <small>{item.error}</small>}</div>)}</div><p className="intel-note">Address history requires your own Alchemy or Helius API key. A wallet address is pseudonymous: JPTI cannot infer its owner, intent, complete portfolio or off-chain identity. Provider indexing may omit records or apply limits.</p></article>
  </section>;
}
