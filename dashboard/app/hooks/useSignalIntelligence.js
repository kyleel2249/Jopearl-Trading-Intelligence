import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../../src/lib/api.js';
import { analyzeSignal } from '../engines/signal-engine.js';
import { classifyMarketRegime, detectSignalCollisions, rankOpportunities } from '../engines/advanced-intelligence.js';

const WATCHLIST = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT'];
const EXCHANGES = ['bitget', 'binance', 'bybit', 'okx'];
const HISTORY_KEY = 'jpti.signal-intelligence.history.v1';
const MARKET_TYPES = ['spot', 'margin', 'futures', 'coin-futures', 'usdc-futures'];

function readHistory() {
  try { const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
}

export function useSignalIntelligence({ initialSymbol = 'BTC/USDT' } = {}) {
  const [exchange, setExchange] = useState('bitget');
  const [marketType, setMarketType] = useState('spot');
  const [symbol, setSymbol] = useState(initialSymbol);
  const [timeframe, setTimeframe] = useState('1h');
  const [watchlist, setWatchlist] = useState(WATCHLIST);
  const [snapshots, setSnapshots] = useState({});
  const [signals, setSignals] = useState([]);
  const [history, setHistory] = useState(readHistory);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const targets = [...new Set([symbol, ...watchlist])].slice(0, 12);
    const results = await Promise.allSettled(targets.map(async (pair) => {
      const path = pair.replace('/', '-');
      const query = '?timeframe=' + encodeURIComponent(timeframe) + '&limit=240&type=' + encodeURIComponent(marketType);
      const [candlesResponse, tickerResponse] = await Promise.all([
        apiFetch('/api/exchanges/' + exchange + '/ohlcv/' + encodeURIComponent(path) + query, { cache: 'no-store' }),
        apiFetch('/api/exchanges/' + exchange + '/ticker/' + encodeURIComponent(path) + '?type=' + encodeURIComponent(marketType), { cache: 'no-store' })
      ]);
      const [candleData, ticker] = await Promise.all([candlesResponse.json(), tickerResponse.json()]);
      if (!candlesResponse.ok) throw new Error(candleData.error || pair + ' candle request failed');
      if (!tickerResponse.ok) throw new Error(ticker.error || pair + ' ticker request failed');
      return { pair, candles: candleData.candles || [], ticker, signal: analyzeSignal(candleData.candles || [], { symbol: pair, exchange, timeframe }) };
    }));
    const nextSnapshots = {}, nextSignals = [];
    results.forEach((result) => {
      if (result.status !== 'fulfilled') return;
      nextSnapshots[result.value.pair] = result.value;
      if (result.value.signal.score != null) nextSignals.push(result.value.signal);
    });
    setSnapshots(nextSnapshots);
    setSignals(nextSignals.sort((a, b) => b.score - a.score));
    const failures = results.filter((item) => item.status === 'rejected');
    if (failures.length === results.length) setError(failures[0].reason?.message || 'Market data unavailable');
    else if (failures.length) setError(failures.length + ' market(s) could not be refreshed. Available results remain usable.');
    setLastUpdated(new Date().toISOString());
    setLoading(false);
  }, [exchange, marketType, symbol, timeframe, watchlist]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [autoRefresh, load]);

  useEffect(() => {
    if (!signals.length) return;
    setHistory((current) => {
      const map = new Map(current.map((item) => [item.signalId, item]));
      signals.forEach((signal) => map.set(signal.signalId, { ...signal, observedAt: new Date().toISOString() }));
      const next = [...map.values()].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)).slice(0, 500);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* browser storage can be disabled */ }
      return next;
    });
  }, [signals]);

  const selected = snapshots[symbol] || null;
  const collisions = useMemo(() => detectSignalCollisions(signals), [signals]);
  const regime = useMemo(() => classifyMarketRegime(signals), [signals]);
  const topSignals = useMemo(() => rankOpportunities(signals).slice(0, 10), [signals]);
  const addToWatchlist = useCallback((pair) => setWatchlist((current) => current.includes(pair) ? current : [...current, pair].slice(0, 12)), []);
  const removeFromWatchlist = useCallback((pair) => setWatchlist((current) => current.length > 1 ? current.filter((item) => item !== pair) : current), []);
  return { exchange, setExchange, marketType, setMarketType, symbol, setSymbol, timeframe, setTimeframe, watchlist, addToWatchlist, removeFromWatchlist, snapshots, selected, signals, topSignals, collisions, regime, history, loading, error, lastUpdated, autoRefresh, setAutoRefresh, refresh: load, exchanges: EXCHANGES, marketTypes: MARKET_TYPES };
}
