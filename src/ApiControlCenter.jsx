import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, CircleAlert, CircleHelp, Database, Globe, RefreshCw, ShieldCheck, Wifi } from 'lucide-react';
import { apiFetch } from './lib/api.js';
import './ApiControlCenter.css';

const DEFAULT_SYMBOL = 'BTC/USDT';
const pretty = (value) => value == null ? '—' : typeof value === 'number' ? value.toLocaleString(undefined, { maximumFractionDigits: 8 }) : String(value);
const badgeState = (status) => ['ok','live','available','complete','public'].includes(String(status).toLowerCase()) ? 'ok' : ['partial','configured','public-or-no-key','credentials-configured-not-verified'].includes(String(status).toLowerCase()) ? 'warn' : 'bad';

export default function ApiControlCenter() {
  const [providers, setProviders] = useState([]);
  const [exchanges, setExchanges] = useState([]);
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const [symbol, setSymbol] = useState(DEFAULT_SYMBOL);
  const [snapshot, setSnapshot] = useState(null);
  const [consensus, setConsensus] = useState(null);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState('');
  const [checkedAt, setCheckedAt] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setRefreshError('');
    try {
      const [providerResponse, exchangeResponse, healthResponse] = await Promise.all([
        apiFetch('/api/providers/providers', { cache: 'no-store' }),
        apiFetch('/api/exchanges', { cache: 'no-store' }),
        apiFetch('/api/health', { cache: 'no-store' })
      ]);
      const failures = [];
      if (!providerResponse.ok) failures.push('Provider directory HTTP ' + providerResponse.status);
      if (!exchangeResponse.ok) failures.push('Exchange catalog HTTP ' + exchangeResponse.status);
      if (!healthResponse.ok) failures.push('Gateway health HTTP ' + healthResponse.status);
      const [providerData, exchangeData, healthData] = await Promise.all([
        providerResponse.ok ? providerResponse.json() : Promise.resolve(null),
        exchangeResponse.ok ? exchangeResponse.json() : Promise.resolve(null),
        healthResponse.ok ? healthResponse.json() : Promise.resolve(null)
      ]);
      setProviders(Array.isArray(providerData?.providers) ? providerData.providers : []);
      setExchanges(Array.isArray(exchangeData?.exchanges) ? exchangeData.exchanges : []);
      setHealth(healthData);
      if (failures.length) setRefreshError(failures.join(' · '));
      setCheckedAt(new Date().toISOString());
    } catch (error) {
      setRefreshError(String(error?.message || error));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadBitget = useCallback(async () => {
    const normalized = symbol.trim().toUpperCase();
    if (!/^[A-Z0-9._-]{2,20}\/[A-Z0-9._-]{2,20}$/.test(normalized)) {
      setMarketError('Use a BASE/QUOTE symbol, such as BTC/USDT.');
      return;
    }
    setMarketLoading(true);
    setMarketError('');
    setSnapshot(null);
    setConsensus(null);
    try {
      const encoded = encodeURIComponent(normalized);
      const [bitgetResponse, consensusResponse] = await Promise.all([
        apiFetch('/api/providers/bitget/market-intelligence/' + encoded, { cache: 'no-store' }),
        apiFetch('/api/providers/consensus/quote/' + encoded, { cache: 'no-store' })
      ]);
      const [bitgetData, consensusData] = await Promise.all([
        bitgetResponse.ok ? bitgetResponse.json() : Promise.resolve(null),
        consensusResponse.ok ? consensusResponse.json() : Promise.resolve(null)
      ]);
      if (!bitgetResponse.ok) throw new Error(bitgetData?.error || 'Bitget snapshot failed (' + bitgetResponse.status + ')');
      setSnapshot(bitgetData);
      setConsensus(consensusData);
      if (!consensusResponse.ok) setMarketError('Bitget snapshot succeeded, but quote consensus returned HTTP ' + consensusResponse.status);
    } catch (error) {
      setMarketError(String(error?.message || error));
    } finally {
      setMarketLoading(false);
    }
  }, [symbol]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const timer = setInterval(refresh, 60000);
    return () => clearInterval(timer);
  }, [refresh]);

  const configuredCount = useMemo(() => providers.filter(item => item.configured).length, [providers]);
  const exchangeConfigured = useMemo(() => exchanges.filter(item => item.configured).length, [exchanges]);
  const bitget = useMemo(() => exchanges.find(item => item.id === 'bitget'), [exchanges]);
  const snapshotTicker = snapshot?.snapshot?.ticker?.data;
  const book = snapshot?.snapshot?.orderBook?.data;
  const funding = snapshot?.snapshot?.fundingRate?.data;
  const interest = snapshot?.snapshot?.openInterest?.data;

  return <div className="api-center">
    <section className="api-center-hero">
      <div><span className="api-eyebrow"><Activity size={13}/> PROVIDER OPERATIONS</span><h2>API Control Center</h2><p>Provider registry, exchange adapter coverage, connection diagnostics and multi-source market checks.</p></div>
      <button className="api-refresh" onClick={refresh} disabled={loading}><RefreshCw size={15} className={loading ? 'api-spin' : ''}/>{loading ? 'Refreshing' : 'Refresh'}</button>
    </section>
    {refreshError && <div className="api-center-alert"><CircleAlert size={16}/>{refreshError}</div>}
    <section className="api-stat-grid">
      <article><span>DATA PROVIDERS</span><b>{providers.length || '—'}</b><small>{configuredCount} public/credential-ready entries</small></article>
      <article><span>EXCHANGE ADAPTERS</span><b>{exchanges.length || '—'}</b><small>{exchangeConfigured} credential configured</small></article>
      <article><span>GATEWAY STATUS</span><b className={health?.status === 'ok' || health?.status === 'healthy' ? 'api-good' : 'api-neutral'}>{health?.status || 'unknown'}</b><small>{health?.mode || 'Mode not reported'}</small></article>
      <article><span>LAST CHECK</span><b>{checkedAt ? new Date(checkedAt).toLocaleTimeString() : '—'}</b><small>Auto refresh · 60 seconds</small></article>
    </section>
    <section className="api-center-section">
      <div className="api-section-heading"><div><h3>Provider directory</h3><p>Readiness status is not a successful live-call guarantee.</p></div><span><Database size={14}/> {providers.length} entries</span></div>
      <div className="api-provider-grid">{providers.map(item => <article key={item.id} className="api-provider-card">
        <div className="api-provider-top"><b>{item.name}</b><span className={'api-state '+badgeState(item.status)}>{String(item.status || 'unknown').replaceAll('-', ' ')}</span></div>
        <p>{item.category}</p><div className="api-provider-foot"><span>{item.configured ? 'Required credentials ready' : item.env?.length ? 'Missing required credentials' : 'Public data access'}</span>{item.optionalCredentialsConfigured && <span className="api-optional-ready">Private credentials ready</span>}</div>
        {item.missingCredentials?.length > 0 && <small className="api-missing">{item.missingCredentials.length} required credential(s) missing</small>}
        {item.missingOptionalCredentials?.length > 0 && <small className="api-missing">{item.missingOptionalCredentials.length} optional credential(s) missing</small>}
        {item.docs && <a href={item.docs} target="_blank" rel="noreferrer">Provider docs ↗</a>}
      </article>)}</div>
    </section>
    <section className="api-center-section">
      <div className="api-section-heading"><div><h3>Exchange adapter coverage</h3><p>Catalog is dynamically derived from the installed CCXT adapters.</p></div><span><Globe size={14}/> {exchanges.length} venues</span></div>
      <div className="api-exchange-grid">{exchanges.map(item => <div key={item.id} className={'api-exchange-chip '+(item.id === 'bitget' ? 'api-bitget' : '')}><span className={'api-state '+badgeState(item.configured ? 'configured' : 'public')}>{item.configured ? 'credentials configured' : 'public adapter'}</span><b>{item.name || item.id}</b><small>{item.id === 'bitget' ? 'Bitget · explicit integration' : item.id}</small></div>)}</div>
    </section>
    <section className="api-center-section api-bitget-workbench">
      <div className="api-section-heading"><div><h3>Bitget live market intelligence</h3><p>Public, read-only snapshot. No trading action is performed.</p></div><span><Wifi size={14}/> {bitget?.configured ? 'Credentials available' : 'Public endpoint'}</span></div>
      <div className="api-market-controls"><label htmlFor="api-bitget-symbol">Market symbol</label><input id="api-bitget-symbol" value={symbol} onChange={event => setSymbol(event.target.value)} placeholder="BTC/USDT"/><button onClick={loadBitget} disabled={marketLoading}><RefreshCw size={14} className={marketLoading ? 'api-spin' : ''}/>{marketLoading ? 'Loading' : 'Fetch snapshot'}</button></div>
      {marketError && <div className="api-center-alert"><CircleAlert size={16}/>{marketError}</div>}
      {snapshot && <div className="api-bitget-results">
        <div className="api-snapshot-banner"><span className={'api-state '+badgeState(snapshot.status)}>{snapshot.status}</span><span>{snapshot.symbol} · {snapshot.latencyMs} ms · {snapshot.sourceQuality?.coveragePercent ?? 0}% components available</span></div>
        <div className="api-market-metrics"><article><small>LAST PRICE</small><b>{pretty(snapshotTicker?.last)}</b></article><article><small>24H CHANGE</small><b>{pretty(snapshotTicker?.percentage)}%</b></article><article><small>24H QUOTE VOLUME</small><b>{pretty(snapshotTicker?.quoteVolume)}</b></article><article><small>FUNDING RATE</small><b>{pretty(funding?.fundingRate)}</b></article><article><small>OPEN INTEREST</small><b>{pretty(interest?.openInterest ?? interest?.openInterestAmount)}</b></article><article><small>ORDER BOOK</small><b>{book ? 'Loaded' : 'Unavailable'}</b></article></div>
        <div className="api-component-status">{Object.entries(snapshot.snapshot || {}).map(([key, value]) => <span key={key} className={'api-state '+badgeState(value.status)}>{key}: {value.status}</span>)}</div>
        {consensus && <div className="api-consensus-row"><span>Multi-source median</span><b>{pretty(consensus.consensusPrice)} {consensus.currency || ''}</b><span>{consensus.sourceCount} source(s) · {consensus.confidence}</span></div>}
        <small className="api-data-foot">Fetched {snapshot.fetchedAt ? new Date(snapshot.fetchedAt).toLocaleTimeString() : '—'} · snapshot cache {snapshot.cache || '—'}</small>
      </div>}
      {!snapshot && !marketLoading && <div className="api-center-empty"><CircleHelp size={18}/><span>Fetch a snapshot to inspect ticker, depth, trade flow, funding and open interest. Unsupported components stay marked unavailable.</span></div>}
    </section>
    <footer className="api-center-footer"><ShieldCheck size={14}/> Secrets remain server-side. Provider checks and consensus are informational, never direct order triggers.</footer>
  </div>;
}
