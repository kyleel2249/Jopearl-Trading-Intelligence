import React, { useEffect, useMemo, useState } from 'react';
import LiveCandlestickChart from './LiveCandlestickChart.jsx';
import { apiFetch } from './lib/api.js';

const NO_LEVELS = [];

export default function ExchangeConnectivity({ symbol, onSymbolChange, alphaLevels = NO_LEVELS, onExchangeChange, onMarketTypeChange, initialExchange = 'binance', initialMarketType = 'spot', compact = false }) {
  const [health, setHealth] = useState(null);
  const [exchanges, setExchanges] = useState([]);
  const [exchange, setExchange] = useState(initialExchange || 'binance');
  useEffect(() => { if (initialExchange && initialExchange !== exchange) setExchange(initialExchange); }, [initialExchange]);
  const [marketType, setMarketType] = useState(initialMarketType || 'spot');
  useEffect(() => { if (initialMarketType && initialMarketType !== marketType) setMarketType(initialMarketType); }, [initialMarketType]);
  useEffect(() => { if (typeof onExchangeChange === 'function') onExchangeChange(exchange); }, [exchange, onExchangeChange]);
  useEffect(() => { if (typeof onMarketTypeChange === 'function') onMarketTypeChange(marketType); }, [marketType, onMarketTypeChange]);
  const [ticker, setTicker] = useState(null);
  const [error, setError] = useState('');

  const selected = useMemo(() => exchanges.find((item) => item.id === exchange), [exchanges, exchange]);

  useEffect(() => {
    let active = true;
    const refreshGatewayCatalog = async () => {
      try {
        const [healthResponse, catalogResponse] = await Promise.all([
          apiFetch('/api/health', { cache: 'no-store' }),
          apiFetch('/api/exchanges', { cache: 'no-store' })
        ]);
        if (!healthResponse.ok || !catalogResponse.ok) throw new Error('Gateway or exchange catalog is unavailable');
        const [status, catalog] = await Promise.all([healthResponse.json(), catalogResponse.json()]);
        if (!active) return;
        setHealth(status);
        setExchanges(catalog.exchanges || []);
        setError('');
      } catch (e) { if (active) setError(e.message); }
    };
    refreshGatewayCatalog();
    const timer = setInterval(refreshGatewayCatalog, 300000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await apiFetch('/api/exchanges/' + exchange + '/ticker/' + symbol.replace('/', '-') + '?type=' + encodeURIComponent(marketType));
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Ticker request failed');
        if (active) { setTicker(data); setError(''); }
      } catch (e) {
        if (active) { setTicker(null); setError(e.message); }
      }
    };
    if (health) {
      load();
      const timer = setInterval(load, 20000);
      return () => { active = false; clearInterval(timer); };
    }
    return () => { active = false; };
  }, [exchange, symbol, health, marketType]);

  return <section className="exchange-workspace">
    <div className="exchange-statusbar">
      <div className="exchange-selectors">
        <label htmlFor="jpti-exchange">EXCHANGE</label>
        <select id="jpti-exchange" value={exchange} onChange={(e) => setExchange(e.target.value)}>
          {(exchanges.length ? exchanges : [{id:'binance',name:'Binance'}]).map((item) =>
            <option key={item.id} value={item.id}>{item.name || item.id}</option>
          )}
        </select>
        <span className={selected?.configured ? 'connected' : 'not-connected'}>
          {selected?.configured ? 'PRIVATE API CONFIGURED' : 'PUBLIC MARKET DATA'}
        </span>
      </div>
      <div className="exchange-status-meta">
        <i className={health ? 'running' : 'standby'}>{health ? 'GATEWAY ONLINE' : 'GATEWAY OFFLINE'}</i>
        <span>{health ? 'Mode: ' + health.mode.toUpperCase() : error || 'Start the JPTI API service'}</span>
      </div>
    </div>
    <div className="exchange-market-strip">
      <span><small>{symbol} · LAST PRICE</small><strong>{ticker?.last == null ? '—' : Number(ticker.last).toLocaleString(undefined,{maximumFractionDigits:8})}</strong></span>
      <span><small>24H CHANGE</small><strong className={Number(ticker?.percentage) >= 0 ? 'up' : 'down'}>{ticker?.percentage == null ? '—' : Number(ticker.percentage).toFixed(2) + '%'}</strong></span>
      <span><small>24H HIGH</small><strong>{ticker?.high == null ? '—' : Number(ticker.high).toLocaleString()}</strong></span>
      <span><small>24H LOW</small><strong>{ticker?.low == null ? '—' : Number(ticker.low).toLocaleString()}</strong></span>
      <span><small>24H VOLUME</small><strong>{ticker?.quoteVolume == null ? '—' : Number(ticker.quoteVolume).toLocaleString(undefined,{maximumFractionDigits:0})}</strong></span>
    </div>
    <LiveCandlestickChart exchange={exchange} symbol={symbol} onSymbolChange={onSymbolChange} initialMarketType={marketType} onMarketTypeChange={setMarketType} alphaLevels={alphaLevels} compact={compact}/>
  </section>;
}
