import React, { useEffect, useMemo, useState } from 'react';
import { apiFetch, getApiSource, subscribeApiSource } from './lib/api.js';
import { detectSmartMoney } from './smartMoney.js';
import { getSessionSnapshot, analyzeSessionCandles } from './session-intelligence.js';
import { sessionForecastAdjustment, detectSessionLiquiditySweeps, sessionRiskAssessment, sessionPerformanceComparison, readSessionMemory, recordSessionOutcome, summarizeSessionMemory } from './session-trading-intelligence.js';
import { analyzeGainzAlphaInspired } from './gainz-alpha-intelligence.js';
import { useGainzAlpha } from './gainz-alpha/useGainzAlpha.js';
import GainzAlphaPanel from './gainz-alpha/GainzAlphaPanel.jsx';
import GainzAlphaOverlays from './gainz-alpha/GainzAlphaOverlays.jsx';
import { useChartIntelligence } from './chart-intelligence/useChartIntelligence.js';
import ChartIntelligenceOverlays from './chart-intelligence/ChartIntelligenceOverlays.jsx';
import ChartIntelligenceLegend from './chart-intelligence/ChartIntelligenceLegend.jsx';
import LiveOrderFlowPanel from './LiveOrderFlowPanel.jsx';
import { resolvePrecision, roundToTick, formatInstrumentPrice } from './chart-intelligence/precision.js';

const TIMEFRAMES = [
  ['1m', '1m'], ['3m', '3m'], ['5m', '5m'], ['15m', '15m'], ['30m', '30m'],
  ['1h', '1H'], ['2h', '2H'], ['4h', '4H'], ['6h', '6H'], ['8h', '8H'],
  ['12h', '12H'], ['1d', '1D'], ['3d', '3D'], ['1w', '1W'], ['1M', '1M']
];
const SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT', 'DOGE/USDT', 'ADA/USDT', 'AVAX/USDT', 'LINK/USDT'];

function ema(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  let previous = values[0];
  return values.map((value, index) => {
    previous = index === 0 ? value : value * k + previous * (1 - k);
    return previous;
  });
}
function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    gains += Math.max(delta, 0);
    losses += Math.max(-delta, 0);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(delta, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function bollinger(values, period = 20, multiplier = 2) {
  const upper = [], lower = [];
  values.forEach((value, index) => {
    if (index < period - 1) { upper.push(Number.NaN); lower.push(Number.NaN); return; }
    const window = values.slice(index - period + 1, index + 1);
    const mean = window.reduce((sum, item) => sum + item, 0) / period;
    const variance = window.reduce((sum, item) => sum + (item - mean) ** 2, 0) / period;
    const deviation = Math.sqrt(variance) * multiplier;
    upper.push(mean + deviation); lower.push(mean - deviation);
  });
  return { upper, lower };
}
function macd(values) {
  if (values.length < 35) return null;
  const fast = ema(values, 12), slow = ema(values, 26);
  const line = fast.map((value, index) => value - slow[index]);
  const signal = ema(line, 9);
  return { line: line[line.length - 1], signal: signal[signal.length - 1], histogram: line[line.length - 1] - signal[signal.length - 1] };
}
function atr(candles, period = 14) {
  if (candles.length <= period) return null;
  const ranges = candles.slice(1).map((c, i) => Math.max(c[2] - c[3], Math.abs(c[2] - candles[i][4]), Math.abs(c[3] - candles[i][4])));
  return ranges.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

const fmt = (value) => Number(value).toLocaleString(undefined, { maximumFractionDigits: 8 });
function pipIncrementFor(symbol, price) {
  const pair = String(symbol || '').replace(/[^A-Z]/g, '');
  const fiat = new Set(['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD']);
  const base = pair.slice(0,3), quote = pair.slice(3,6);
  if (pair.length === 6 && fiat.has(base) && fiat.has(quote)) return quote === 'JPY' ? 0.01 : 0.0001;
  if (price >= 1000) return 1;
  if (price >= 100) return 0.1;
  if (price >= 10) return 0.01;
  if (price >= 1) return 0.001;
  if (price >= 0.1) return 0.0001;
  if (price >= 0.01) return 0.00001;
  return 0.000001;
}
function calibratedPriceTicks(min, max, symbol, meta = {}) {
  const range = max - min, center = (min + max) / 2;
  const precision = resolvePrecision(meta);
  let step = precision.tickSize || pipIncrementFor(symbol, center);
  if (!Number.isFinite(step) || step <= 0) step = range / 20;
  while (range / step > 40) step *= 10;
  const first = Math.ceil((min - step * 1e-10) / step) * step, ticks = [];
  for (let value = first; value <= max + step * 1e-8 && ticks.length < 45; value += step) ticks.push(precision.tickSize ? roundToTick(value, precision) : Number(value.toPrecision(12)));
  return ticks;
}
const timeLabel = (stamp, timeframe) => {
  const date = new Date(stamp);
  return ['1d', '3d', '1w', '1M'].includes(timeframe)
    ? date.toLocaleDateString([], { month: 'short', day: 'numeric' })
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export default function LiveCandlestickChart({ exchange, symbol, onSymbolChange, initialTimeframe, initialMarketType = 'futures', onTimeframeChange, onMarketTypeChange, onMarketSideChange, alphaLevels = [] }) {
  const [timeframe, setTimeframe] = useState(initialTimeframe || '1h');
  const [candles, setCandles] = useState([]);
  const [marketSymbols, setMarketSymbols] = useState(SYMBOLS);
  const [marketInstrumentIds, setMarketInstrumentIds] = useState({});
  const [marketPrecisionMetadata, setMarketPrecisionMetadata] = useState({});
  const [supportedTimeframes, setSupportedTimeframes] = useState(null);
  const [marketType, setMarketType] = useState(initialMarketType || 'futures');
  const [marketSide, setMarketSide] = useState('buy');
  const [directMode, setDirectMode] = useState(() => ['direct', 'cloudflare-edge'].includes(getApiSource().mode));
  const [cloudflareMode, setCloudflareMode] = useState(() => getApiSource().mode === 'cloudflare-edge');
  const [marketSearch, setMarketSearch] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [marketCounts, setMarketCounts] = useState(null);
  const [drawMode, setDrawMode] = useState('off');
  const [drawings, setDrawings] = useState([]);
  const [showVwap, setShowVwap] = useState(false);
  const [showObv, setShowObv] = useState(false);
  const [showStochRsi, setShowStochRsi] = useState(false);
  const [showSupertrend, setShowSupertrend] = useState(false);
  const [showFvg, setShowFvg] = useState(true);
  const [showSweeps, setShowSweeps] = useState(true);
  const [showStructure, setShowStructure] = useState(true);
  const [showOrderBlocks, setShowOrderBlocks] = useState(true);
  const [swingLength, setSwingLength] = useState(3);
  const [ticker, setTicker] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showEma20, setShowEma20] = useState(false);
  const [showEma50, setShowEma50] = useState(false);
  const [showBollinger, setShowBollinger] = useState(false);
  const [showVolume, setShowVolume] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [candleSpacing, setCandleSpacing] = useState(1.35);
  const [candleBodyPct, setCandleBodyPct] = useState(88);
  const [volumeHeight, setVolumeHeight] = useState(78);
  const [marketContext, setMarketContext] = useState(null);
  const [contextError, setContextError] = useState('');
  const [crosshair, setCrosshair] = useState(null);
  const [sessionClock, setSessionClock] = useState(Date.now());
  useEffect(() => {
    const syncSource = () => {
      const mode = getApiSource().mode;
      const direct = ['direct', 'cloudflare-edge'].includes(mode);
      setDirectMode(direct);
      setCloudflareMode(mode === 'cloudflare-edge');
      if (mode === 'direct') setMarketType('spot');
    };
    syncSource();
    return subscribeApiSource(syncSource);
  }, []);
  useEffect(() => { const timer = setInterval(() => setSessionClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const sessionSnapshot = useMemo(() => getSessionSnapshot(sessionClock), [sessionClock]);
  const sessionAnalytics = useMemo(() => analyzeSessionCandles(candles, sessionClock), [candles, sessionClock]);
  const sessionForecast = useMemo(() => sessionForecastAdjustment(candles, {symbol, timeframe, now:sessionClock}), [candles, symbol, timeframe, sessionClock]);
  const sessionSweeps = useMemo(() => detectSessionLiquiditySweeps(candles, {now:sessionClock}), [candles, sessionClock]);
  const sessionRisk = useMemo(() => sessionRiskAssessment(candles, {now:sessionClock, baseRiskPercent:1}), [candles, sessionClock]);
  const sessionComparison = useMemo(() => sessionPerformanceComparison(candles, {now:sessionClock}), [candles, sessionClock]);
  const [sessionMemory, setSessionMemory] = useState(() => readSessionMemory());
  const [sessionMemoryStatus, setSessionMemoryStatus] = useState('loading');
  const [memoryStrategy, setMemoryStrategy] = useState('');
  const [memoryOutcome, setMemoryOutcome] = useState('win');
  const [memoryReturnR, setMemoryReturnR] = useState('');
  const memorySummary = useMemo(() => summarizeSessionMemory(sessionMemory), [sessionMemory]);
  const gainzAlpha = useMemo(() => analyzeGainzAlphaInspired(candles.slice(0, -1), { symbol, timeframe, historicalOutcomes: sessionMemory, now: sessionClock }), [candles, symbol, timeframe, sessionMemory, sessionClock]);
  const [gaOverlaysMounted, setGaOverlaysMounted] = useState(false);
  const ga = useGainzAlpha({ exchange, symbol, timeframe, candles });
  const ci = useChartIntelligence({ exchange, symbol, timeframe, candles, ga, externalLevels: alphaLevels, clock: sessionClock });
  const ciReady = Boolean(ci.settings.enabled && ci.result && ci.result.status === 'ready');
  const [ciOverlaysMounted, setCiOverlaysMounted] = useState(false);
  const [compactChart, setCompactChart] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 600px)').matches : false));
  useEffect(() => { if (typeof window === 'undefined' || !window.matchMedia) return undefined; const mq = window.matchMedia('(max-width: 600px)'), on = () => setCompactChart(mq.matches); mq.addEventListener ? mq.addEventListener('change', on) : mq.addListener(on); return () => { mq.removeEventListener ? mq.removeEventListener('change', on) : mq.removeListener(on); }; }, []);
  const ciPlanPrices = useMemo(() => { const p = ciReady && ci.settings.layers.plan ? ci.result.plan : null; if (!p) return []; const a = ci.result.atr || 0; return [p.entry, p.stopLoss, ...p.targets.filter((t) => Math.abs(t.price - p.entry) <= a * 8).slice(0, 3).map((t) => t.price)].filter(Number.isFinite); }, [ci.result, ci.settings.layers.plan, ciReady]);
  const recordCurrentOutcome = async () => { const active = sessionSnapshot.sessions.filter(x=>x.active).map(x=>x.name); const record={session:active.join('+')||'Off-session',symbol,strategy:memoryStrategy||'Unspecified',volatility:sessionRisk.mode,outcome:memoryOutcome,returnR:memoryReturnR===''?null:Number(memoryReturnR)}; try { const response=await apiFetch('/api/session/memory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(record)}); const data=await response.json(); if(!response.ok||!data.ok)throw new Error(data.error||'Session memory save failed'); setSessionMemory(prev=>[data.record,...prev].slice(0,2000)); setSessionMemoryStatus('saved to backend'); } catch(error) { const local=recordSessionOutcome(record); if(local.ok)setSessionMemory(readSessionMemory()); setSessionMemoryStatus('backend unavailable · saved locally'); } };

  useEffect(() => { let active=true; const legacy=readSessionMemory(); apiFetch('/api/session/memory').then(response=>response.ok?response.json():null).then(async data=>{if(!active||!Array.isArray(data?.records))return; if(legacy.length){const migrated=await apiFetch('/api/session/memory/batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({records:legacy})});if(!migrated.ok)throw new Error('legacy session memory migration failed');if(typeof localStorage!=='undefined')localStorage.removeItem('jpti.session-memory.v1');const refreshed=await apiFetch('/api/session/memory');const result=await refreshed.json();if(active&&Array.isArray(result.records)){setSessionMemory(result.records);setSessionMemoryStatus('legacy memory migrated');}return;} setSessionMemory(data.records);setSessionMemoryStatus('backend synced');}).catch(()=>{if(active)setSessionMemoryStatus('backend unavailable · local memory retained');}); return ()=>{active=false;}; }, []);
  useEffect(() => { if (initialTimeframe && initialTimeframe !== timeframe) setTimeframe(initialTimeframe); }, [initialTimeframe]);
  useEffect(() => { if (onTimeframeChange) onTimeframeChange(timeframe); }, [timeframe, onTimeframeChange]);
  const marketInstrumentId = exchange === 'bitget' ? String(marketInstrumentIds[symbol] || '') : '';
  const marketInstrumentQuery = marketInstrumentId ? '&instrumentId=' + encodeURIComponent(marketInstrumentId) : '';
  const marketSideQuery = marketType === 'cfd' ? '&side=' + encodeURIComponent(marketSide) : '';

  useEffect(() => { if (initialMarketType && initialMarketType !== marketType) setMarketType(initialMarketType); }, [initialMarketType, marketType]);
  useEffect(() => { if (onMarketTypeChange) onMarketTypeChange(marketType); }, [marketType, onMarketTypeChange]);
  useEffect(() => { if (onMarketSideChange) onMarketSideChange(marketSide); }, [marketSide, onMarketSideChange]);

  useEffect(() => {
    if (directMode && exchange !== 'bitget' && marketType !== 'spot') setMarketType('spot');
    let active = true;
    const refreshCatalog = async () => {
      try {
        const response = await apiFetch('/api/exchanges/' + exchange + '/markets?type=' + marketType + '&search=' + encodeURIComponent(marketSearch));
        const data = await response.json();
        if (!active) return;
        if (!response.ok) {
          const message = data.error || 'Bitget market catalogue is unavailable for this product.';
          if (marketType === 'cfd') { setMarketSymbols([]); setMarketInstrumentIds({}); setMarketCounts(null); setSupportedTimeframes(null); setCatalogError(message); }
          return;
        }
        const markets = Array.isArray(data.markets) ? data.markets : [];
        setCatalogError('');
        const symbols = markets.map((market) => market.symbol);
        setMarketInstrumentIds(Object.fromEntries(markets.filter((market) => market.symbol && market.id).map((market) => [market.symbol, market.id])));
        setMarketPrecisionMetadata(Object.fromEntries(markets.filter((market) => market.symbol).map((market) => {
          const info = market.info || {};
          const tickSize = market.tickSize ?? market.priceIncrement ?? market.minPriceIncrement ?? info.tickSize ?? info.priceIncrement ?? info.minPriceIncrement;
          const priceDecimals = market.priceDecimals ?? (Number.isInteger(market.precision?.price) ? market.precision.price : undefined) ?? info.pricePrecision ?? info.pricePlace;
          const pipSize = market.pipSize ?? market.pip ?? info.pipSize ?? info.pointSize;
          return [market.symbol, { symbol: market.symbol, marketType, tickSize, priceDecimals, pipSize, quote: market.quote, type: market.type }];
        })));
        setMarketSymbols(symbols);
        setMarketCounts(data.counts || null);
        if (symbols.length && !symbols.includes(symbol)) {
          const preferred = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT'];
          onSymbolChange(preferred.find((item) => symbols.includes(item)) || symbols[0]);
        }
        const frames = Array.isArray(data.timeframes) && data.timeframes.length ? data.timeframes : null;
        setSupportedTimeframes(frames);
        if (frames && !frames.includes(timeframe)) setTimeframe(frames.includes('1h') ? '1h' : frames[0]);
      } catch (error) { if (active && marketType === 'cfd') setCatalogError(error.message || 'Bitget CFD instrument catalogue is unavailable.'); /* Keep the last successful crypto catalogue visible during temporary exchange outages. */ }
    };
    refreshCatalog();
    const timer = setInterval(refreshCatalog, 300000);
    return () => { active = false; clearInterval(timer); };
  }, [exchange, marketType, marketSearch, directMode]);

  const load = async () => {
    if (marketType === 'cfd' && catalogError) { setError(catalogError); setCandles([]); setLoading(false); return; }
    if (marketType === 'cfd' && marketSymbols.length && !marketSymbols.includes(symbol)) { setError('Select a listed Bitget CFD instrument before loading its chart.'); setCandles([]); setLoading(false); return; }
    setLoading(true);
    const encodedSymbol = symbol.replace('/', '-');
    const request = async (path) => {
      try {
        const response = await apiFetch(path);
        return { ok: response.ok, data: await response.json() };
      } catch (error) { return { ok: false, error }; }
    };
    const candlePromise = request('/api/exchanges/' + exchange + '/ohlcv/' + encodedSymbol + '?timeframe=' + timeframe + '&limit=200&type=' + encodeURIComponent(marketType) + marketInstrumentQuery + marketSideQuery);
    const tickerPromise = request('/api/exchanges/' + exchange + '/ticker/' + encodedSymbol + '?type=' + encodeURIComponent(marketType) + marketInstrumentQuery);
    const contextPromise = request('/api/intelligence/market/' + exchange + '/' + encodedSymbol + '/context?timeframe=' + timeframe + '&type=' + encodeURIComponent(marketType) + marketInstrumentQuery + marketSideQuery);
    try {
      const candleResult = await candlePromise;
      if (!candleResult.ok) throw new Error(candleResult.data?.error || candleResult.error?.message || 'Candlestick data unavailable for this market and timeframe.');
      setCandles((candleResult.data.candles || []).filter((row) => row.length >= 6).map((row) => row.map(Number)));
      setError('');
      tickerPromise.then((result) => { if (result.ok) setTicker(result.data); });
      contextPromise.then((result) => {
        if (result.ok) { setMarketContext(result.data); setContextError(''); }
        else setContextError(result.data?.error || result.error?.message || 'Context analysis unavailable');
      });
    } catch (error) {
      setError(error.message);
      setCandles([]);
    } finally { setLoading(false); }
  };

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let controller = null;
    const refresh = async () => {
      if (inFlight) return;
      if (marketType === 'cfd' && catalogError) { setError(catalogError); setCandles([]); setLoading(false); return; }
      if (marketType === 'cfd' && marketSymbols.length && !marketSymbols.includes(symbol)) { setError('Select a listed Bitget CFD instrument before loading its chart.'); setCandles([]); setLoading(false); return; }
      inFlight = true;
      controller = new AbortController();
      const { signal } = controller;
      const encodedSymbol = symbol.replace('/', '-');
      const request = async (path) => {
        try {
          const response = await apiFetch(path, { signal });
          const data = await response.json();
          return { ok: response.ok, data };
        } catch (error) {
          return { ok: false, error };
        }
      };
      try {
        // Start all requests together, but let the chart depend only on OHLCV.
        const candlePromise = request('/api/exchanges/' + exchange + '/ohlcv/' + encodedSymbol + '?timeframe=' + timeframe + '&limit=200&type=' + encodeURIComponent(marketType) + marketInstrumentQuery + marketSideQuery);
        const tickerPromise = request('/api/exchanges/' + exchange + '/ticker/' + encodedSymbol + '?type=' + encodeURIComponent(marketType) + marketInstrumentQuery);
        const contextPromise = request('/api/intelligence/market/' + exchange + '/' + encodedSymbol + '/context?timeframe=' + timeframe + '&type=' + encodeURIComponent(marketType) + marketInstrumentQuery);

        const candleResult = await candlePromise;
        if (!active || signal.aborted) return;
        if (!candleResult.ok) throw new Error(candleResult.data?.error || candleResult.error?.message || 'Candlestick data unavailable for this market and timeframe.');
        setCandles((candleResult.data.candles || []).filter((row) => row.length >= 6).map((row) => row.map(Number)));
        setError('');
        setLoading(false);

        // Secondary panels update independently and cannot hold back candle rendering.
        tickerPromise.then((result) => {
          if (active && !signal.aborted && result.ok) setTicker(result.data);
        });
        contextPromise.then((result) => {
          if (!active || signal.aborted) return;
          if (result.ok) { setMarketContext(result.data); setContextError(''); }
          else setContextError(result.data?.error || result.error?.message || 'Context analysis unavailable');
        });
      } catch (error) {
        if (active && !signal.aborted) setError(error.message);
      } finally {
        if (active && !signal.aborted) setLoading(false);
        inFlight = false;
      }
    };
    setLoading(true);
    refresh();
    const timer = setInterval(refresh, 20000);
    return () => {
      active = false;
      clearInterval(timer);
      controller?.abort();
    };
  }, [exchange, symbol, timeframe, marketType, marketInstrumentId, marketSide, marketSymbols, catalogError]);

  const metrics = useMemo(() => {
    const closes = candles.map((c) => c[4]);
    const last = candles[candles.length - 1];
    const previous = candles[candles.length - 2];
    return {
      ema20: ema(closes, 20), ema50: ema(closes, 50),
      bollinger: bollinger(closes), macd: macd(closes),
      rsi: rsi(closes), atr: atr(candles),
      last, previous,
      change: last && previous ? ((last[4] - previous[4]) / previous[4]) * 100 : null,
      volume: candles.slice(-20).reduce((sum, c) => sum + c[5], 0) / Math.min(20, candles.length),
      vwap: (() => { const rows = candles.slice(-100); const pv = rows.reduce((sum,c) => sum + ((c[2]+c[3]+c[4])/3)*c[5],0); const vol = rows.reduce((sum,c) => sum+c[5],0); return vol ? pv/vol : null; })(),
      obv: candles.reduce((sum,c,i) => i === 0 ? 0 : sum + (c[4] > candles[i-1][4] ? c[5] : c[4] < candles[i-1][4] ? -c[5] : 0),0),
      stochRsi: (() => { if (closes.length < 28) return null; const values=[]; for(let i=27;i<closes.length;i++) { const value=rsi(closes.slice(0,i+1)); if(value!=null) values.push(value); } const current=rsi(closes); if(current==null||!values.length)return null; const lo=Math.min(...values.slice(-14)),hi=Math.max(...values.slice(-14)); return hi===lo?50:(current-lo)/(hi-lo)*100; })(),
      supertrend: (() => { if(candles.length<15)return null; const last=candles[candles.length-1]; const range=atr(candles,14); return range==null?null:(last[4] >= (last[2]+last[3])/2 ? 'Bullish bias' : 'Bearish bias'); })()
    };
  }, [candles]);

  const smartMoney = useMemo(() => detectSmartMoney(candles.slice(0, -1), swingLength), [candles, swingLength]);

  const geometry = useMemo(() => {
    if (!candles.length) return null;
    const count = Math.max(25, Math.min(candles.length, Math.floor(candles.length / (zoom * candleSpacing))));
    const rows = candles.slice(-count);
    const levelPrices = [...(alphaLevels || []).map(level => Number(level.price)).filter(Number.isFinite), ...ciPlanPrices];
    const min = Math.min(...rows.map((c) => c[3]), ...levelPrices);
    const max = Math.max(...rows.map((c) => c[2]), ...levelPrices);
    const padding = (max - min || max * 0.002 || 1) * 0.09;
    const low = min - padding, high = max + padding;
    const left = 12, right = 920, top = 18, priceBottom = 280, volumeBottom = 378;
    const x = (i) => left + (i + 0.5) * ((right - left) / rows.length);
    const y = (price) => top + ((high - price) / (high - low)) * (priceBottom - top);
    const maxVol = Math.max(1, ...rows.map((c) => c[5]));
    const points = (values) => values.slice(candles.length - count).map((value, i) => Number.isFinite(value) ? x(i) + ',' + y(value) : null).filter(Boolean).join(' ');
    return { rows, count, min: low, max: high, left, right, top, priceBottom, volumeBottom, x, y, maxVol, points };
  }, [candles, zoom, candleSpacing, alphaLevels, ciPlanPrices]);

  const activeCandle = crosshair !== null && geometry ? geometry.rows[crosshair] : metrics.last;
  const candleSlot = geometry ? (geometry.right - geometry.left) / geometry.count : 6;
  const candleWidth = Math.max(2, Math.min(36, candleSlot * candleBodyPct / 100));

  return <section className="panel exchange-connect trading-chart-panel">
    <div className="panelhead">
      <span><b>Live market chart</b><small>OHLCV exchange data · {exchange.toUpperCase()}</small></span>
      <i className={candles.length ? "running" : "standby"}>{candles.length ? "LIVE MARKET DATA" : loading ? "CONNECTING" : "NO DATA"}</i>
    </div>
    <div className="jpti-chart-session-strip" aria-label="Live trading session context" style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))',gap:8,margin:'10px 0 12px'}}>
      {sessionSnapshot.sessions.map(session => <article key={session.id} style={{padding:'9px 11px',borderRadius:9,border:'1px solid '+(session.active?'#29b6a4':'#283548'),background:session.active?'rgba(32,201,151,.09)':'rgba(18,27,42,.72)',minWidth:0}}>
        <div style={{display:'flex',justifyContent:'space-between',gap:6,alignItems:'center'}}><strong style={{fontSize:11}}>{session.name}</strong><span style={{fontSize:9,fontWeight:700,color:session.active?'#34d399':'#8393a8'}}>{session.active?'OPEN · LIVE':session.phase.toUpperCase()}</span></div>
        <div style={{fontSize:10,color:'#9aabc2',marginTop:5}}>{session.localTime} local · {session.timezone}</div>
        <div style={{height:3,background:'#263448',borderRadius:4,marginTop:7,overflow:'hidden'}}><i style={{display:'block',height:'100%',width:session.progressPercent+'%',background:session.active?'#34d399':'#6686a8'}}/></div>
        <div style={{fontSize:9,color:'#8b9bb0',marginTop:5}}>{session.active?session.elapsedMinutes+'m elapsed · '+session.remainingMinutes+'m remaining':session.focus}</div>
      </article>)}
    </div>
    <div style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:8,fontSize:10,color:'#a3b3c7'}}>
      <span style={{padding:'5px 8px',border:'1px solid #334257',borderRadius:7}}>Market overlap: <b>{sessionSnapshot.overlapName||'None active'}</b></span>
      <span style={{padding:'5px 8px',border:'1px solid #334257',borderRadius:7}}>Active killzones: <b>{sessionSnapshot.killzones.join(' · ')||'None'}</b></span>
      <span style={{padding:'5px 8px',border:'1px solid #334257',borderRadius:7}}>Chart: <b>{symbol} · {timeframe}</b></span>
    </div>
    <GainzAlphaPanel ga={ga} symbol={symbol} timeframe={timeframe} candleCount={candles.length} overlaysLoaded={gaOverlaysMounted} />
    <section aria-label="Adaptive Alpha setup intelligence" style={{margin:'12px 0',padding:12,border:'1px solid #26384f',borderRadius:12,background:'#101a2b',color:'#dbe7f5'}}>
      <header><b>ADAPTIVE ALPHA SETUP</b><span style={{marginLeft:8,fontSize:10,color:'#93a6bd'}}>GainzAlgo-inspired · {gainzAlpha.status}</span></header>
      <div style={{display:'flex',flexWrap:'wrap',gap:8,marginTop:9}}>
       <span style={{padding:8,background:'#18263a',borderRadius:8}}>Signal <b>{gainzAlpha.signal||'WAIT'}</b> · Confidence <b>{gainzAlpha.confidence||0}%</b></span>
       <span style={{padding:8,background:'#18263a',borderRadius:8}}>Setup <b>{gainzAlpha.setup?.phase||'none'}</b></span>
       <span style={{padding:8,background:'#18263a',borderRadius:8}}>Expectancy <b>{gainzAlpha.expectancy?.averageR??'—'} R</b> · {gainzAlpha.expectancy?.samples||0} records</span>
       <span style={{padding:8,background:'#18263a',borderRadius:8}}>Stop <b>{gainzAlpha.riskPlan?.stopLoss==null?'—':fmt(gainzAlpha.riskPlan.stopLoss)}</b> · TP1 <b>{gainzAlpha.riskPlan?.takeProfit1==null?'—':fmt(gainzAlpha.riskPlan.takeProfit1)}</b> · TP2 <b>{gainzAlpha.riskPlan?.takeProfit2==null?'—':fmt(gainzAlpha.riskPlan.takeProfit2)}</b></span>
      </div>
      <div style={{display:'flex',flexWrap:'wrap',gap:5,marginTop:8,fontSize:10}}>{(gainzAlpha.components||[]).map(c=><span key={c.key} style={{padding:'4px 6px',background:'#202f45',borderRadius:5}}>{c.key} {c.value>0?'+':''}{c.value}</span>)}</div>
      {gainzAlpha.setup&&<small style={{display:'block',marginTop:7,color:'#9bb1ca'}}>Level {fmt(gainzAlpha.setup.level)} · sweep {gainzAlpha.setup.sweepTimestamp?new Date(gainzAlpha.setup.sweepTimestamp).toLocaleString():'—'} · reclaim {gainzAlpha.setup.reclaimTimestamp?new Date(gainzAlpha.setup.reclaimTimestamp).toLocaleString():'pending'} · displacement {gainzAlpha.setup.displacementTimestamp?new Date(gainzAlpha.setup.displacementTimestamp).toLocaleString():'pending'}</small>}
      <small style={{display:'block',marginTop:7,color:'#8297b0'}}>Closed-candle heuristic only; confidence is not a probability and does not authorize orders.</small>
    </section>
    <section className="jpti-session-ai" aria-label="Session-integrated trading intelligence">
      <header><b>SESSION-DRIVEN INTELLIGENCE</b><small>Forecast · liquidity · risk · memory · comparative analytics</small></header>
      <div className="jpti-session-ai-grid">
        <article><small>FORECAST TILT</small><strong>{sessionForecast.status==='ready'?sessionForecast.direction.toUpperCase():'WAIT FOR DATA'}</strong><span>Confidence {sessionForecast.confidence}% · {sessionForecast.adjustment>0?'+':''}{sessionForecast.adjustment} pts</span><span>Session vol factor {sessionForecast.sessionVolatilityRatio??'—'}x</span></article>
        <article><small>SESSION RISK</small><strong>{sessionRisk.mode.toUpperCase()} · {sessionRisk.riskPercent}%</strong><span>Risk multiplier {sessionRisk.multiplier}x</span><span>{sessionRisk.reasons.join(' / ')||'Standard session conditions'}</span></article>
        <article><small>LIQUIDITY SWEEP RADAR</small><strong>{sessionSweeps.events.length} event(s) detected</strong><span>{sessionSweeps.events.slice(-2).map(e=>e.type.replaceAll('-',' ')+' @ '+Number(e.level).toPrecision(5)).join(' · ')||'No recent session range sweep'}</span><span>{sessionSweeps.levels.slice(-2).map(l=>l.session+' H/L '+Number(l.high).toPrecision(5)+' / '+Number(l.low).toPrecision(5)).join(' · ')||'Session levels waiting on data'}</span></article>
        <article><small>SESSION PERFORMANCE</small><strong>{sessionComparison.status==='ready'?'Comparing '+Object.values(sessionComparison.sessions).filter(x=>x.observations>0).length+' sessions':'Awaiting candles'}</strong><span>{Object.values(sessionComparison.sessions).filter(x=>x.observations>0).sort((a,b)=>(b.averageRangePercent||0)-(a.averageRangePercent||0)).slice(0,2).map(x=>x.name+' '+(x.averageRangePercent||0).toFixed(2)+'% range').join(' · ')||'Historical sample not available'}</span></article>
      </div>
      <div className="jpti-session-memory"><div><b>SESSION MEMORY</b><small>{sessionMemory.length} recorded outcomes · {sessionMemoryStatus} · backend persistence</small></div><input aria-label="Strategy tag" value={memoryStrategy} onChange={e=>setMemoryStrategy(e.target.value)} placeholder="Strategy / setup tag"/><select aria-label="Outcome" value={memoryOutcome} onChange={e=>setMemoryOutcome(e.target.value)}><option value="win">Win</option><option value="loss">Loss</option><option value="breakeven">Breakeven</option></select><input aria-label="Return in R" type="number" step="0.1" value={memoryReturnR} onChange={e=>setMemoryReturnR(e.target.value)} placeholder="Return (R)"/><button type="button" onClick={recordCurrentOutcome}>Record result</button></div>
      {memorySummary.length>0&&<div className="jpti-session-memory-summary">{memorySummary.slice(0,4).map(g=><span key={[g.session,g.symbol,g.strategy,g.volatility].join('|')}>{g.session} · {g.symbol} · {g.strategy}: {g.winRate.toFixed(0)}% win ({g.trades}) · {g.averageR.toFixed(2)}R avg</span>)}</div>}
      <small className="jpti-session-ai-foot">Research signals only. Risk panel is informational; it does not submit orders or override the trading risk gate. Outcome memory is stored in JPTI backend storage when connected.</small>
    </section>
    <div className="jpti-session-candle-intel" style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(120px,1fr))',gap:7,margin:'0 0 10px'}}>
      {sessionSnapshot.sessions.map(session=>{const today=sessionAnalytics.today?.[session.id];const prior=sessionAnalytics.history?.[session.id];return <div key={'session-stat-'+session.id} style={{border:'1px solid #283548',borderRadius:8,padding:'7px 9px',background:'#101a29'}}>
        <small style={{fontSize:9,color:'#8798ae',display:'block'}}>{session.name} · TODAY RANGE</small><b style={{fontSize:12}}>{today?.range==null?'No session candles':Number(today.range).toPrecision(5)}</b>
        <small style={{display:'block',marginTop:4,color:'#8192a8',fontSize:9}}>Avg prior range: {prior?.averageRange==null?'—':Number(prior.averageRange).toPrecision(5)} · {prior?.observations||0} sessions</small>
      </div>})}
    </div>
    <div className="chart-toolbar">
      <label>Product</label>
      <select aria-label="Market type" value={marketType} onChange={(e) => setMarketType(e.target.value)}>
        <option value="spot">Spot</option>
        <option value="futures" disabled={directMode && exchange !== 'bitget'}>USDT-M Futures</option>
        <option value="coin-futures" disabled={directMode && exchange !== 'bitget'}>Coin-M Futures</option>
        <option value="usdc-futures" disabled={directMode && exchange !== 'bitget'}>USDC-M Futures</option>
        <option value="margin" disabled={directMode && exchange !== 'bitget'}>Margin</option>
        <option value="cfd" disabled={exchange !== 'bitget' || !cloudflareMode}>CFD · Cloudflare UTA read-only key required</option>
        <option value="options" disabled>Options (not enabled in this adapter)</option>
      </select>
      {directMode && <span className="subtle-note" role="status">{exchange === 'bitget' ? (marketType === 'cfd' ? (cloudflareMode ? 'Bitget CFD chart data uses the separate signed UTA read-only API. Configure the three Bitget credentials as Cloudflare Pages secrets. CFD candle history is side-specific and does not provide traded volume.' : 'Bitget CFD requires the Cloudflare Pages edge API and its encrypted read-only credentials; browser-direct fallback cannot access this signed feed.') : 'Bitget public instruments: Spot, Margin, USDT-M, Coin-M and USDC-M. CFD is available through the separate authenticated Cloudflare feed.') : 'This direct adapter currently exposes spot markets for this exchange. Select Bitget for supported derivatives, margin and CFD markets.'}</span>}
      {catalogError && marketType === 'cfd' && <span className="subtle-note" role="alert">{catalogError}</span>}
      {marketType === 'cfd' && <label>CFD quote side <select aria-label="CFD candle side" value={marketSide} onChange={(e) => setMarketSide(e.target.value)}><option value="buy">Buy / Ask-side</option><option value="sell">Sell / Bid-side</option></select></label>}
      <input className="market-search" aria-label="Search markets" placeholder="Search pair…" value={marketSearch} onChange={(e) => setMarketSearch(e.target.value)} />
      <label htmlFor="jpti-symbol">Pair</label>
      <select id="jpti-symbol" value={symbol} onChange={(e) => onSymbolChange(e.target.value)}>
        {marketSymbols.map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
      <div className="timeframe-list" role="group" aria-label="Chart timeframe">
        {TIMEFRAMES.filter(([value]) => !supportedTimeframes || supportedTimeframes.includes(value)).map(([value, label]) => <button key={value} className={timeframe === value ? 'active' : ''} onClick={() => setTimeframe(value)}>{label}</button>)}
      </div>
      <div className="chart-actions">
        <button onClick={() => setZoom((v) => Math.min(4, v * 1.35))} title="Zoom in">＋</button>
        <button onClick={() => setZoom((v) => Math.max(0.5, v / 1.35))} title="Zoom out">－</button>
        <button onClick={() => setZoom(1)} title="Fit all candles">Fit</button>
        <button onClick={load} title="Refresh chart">{loading ? '…' : '↻'}</button>
      </div>
    </div>
    <div className="chart-size-controls" aria-label="Chart sizing controls">
      <label><span>Candle spacing <b>{candleSpacing.toFixed(2)}×</b></span><input aria-label="Candle spacing" type="range" min="0.65" max="10" step="0.05" value={candleSpacing} onChange={(e) => setCandleSpacing(Number(e.target.value))}/></label>
      <label><span>Candle body width <b>{candleBodyPct}%</b></span><input aria-label="Candle body width" type="range" min="35" max="100" step="1" value={candleBodyPct} onChange={(e) => setCandleBodyPct(Number(e.target.value))}/></label>
      <label><span>Volume height <b>{volumeHeight}px</b></span><input aria-label="Volume height" type="range" min="20" max="90" step="1" value={volumeHeight} onChange={(e) => setVolumeHeight(Number(e.target.value))}/></label>
      <button type="button" onClick={() => { setCandleSpacing(1.35); setCandleBodyPct(88); setVolumeHeight(78); setZoom(1); }}>Reset chart sizing</button>
    </div>
    <div className="chart-indicator-controls">
      <label><input type="checkbox" checked={showEma20} onChange={(e) => setShowEma20(e.target.checked)}/> EMA 20</label>
      <label><input type="checkbox" checked={showEma50} onChange={(e) => setShowEma50(e.target.checked)}/> EMA 50</label>
      <label><input type="checkbox" checked={showBollinger} onChange={(e) => setShowBollinger(e.target.checked)}/> Bollinger</label>
      <label><input type="checkbox" checked={showVolume} onChange={(e) => setShowVolume(e.target.checked)}/> Volume</label>
      <label><input type="checkbox" checked={showVwap} onChange={(e) => setShowVwap(e.target.checked)}/> VWAP</label>
      <label><input type="checkbox" checked={showStochRsi} onChange={(e) => setShowStochRsi(e.target.checked)}/> Stoch RSI</label>
      <label><input type="checkbox" checked={showObv} onChange={(e) => setShowObv(e.target.checked)}/> OBV</label>
      <label><input type="checkbox" checked={showSupertrend} onChange={(e) => setShowSupertrend(e.target.checked)}/> Price trend bias</label>
      <label className="smc-toggle"><input type="checkbox" checked={showFvg} onChange={(e) => setShowFvg(e.target.checked)}/> FVG</label>
      <label className="smc-toggle"><input type="checkbox" checked={showSweeps} onChange={(e) => setShowSweeps(e.target.checked)}/> Liquidity sweeps</label>
      <label className="smc-toggle"><input type="checkbox" checked={showStructure} onChange={(e) => setShowStructure(e.target.checked)}/> BOS / CHoCH</label>
      <label className="smc-toggle"><input type="checkbox" checked={showOrderBlocks} onChange={(e) => setShowOrderBlocks(e.target.checked)}/> Order blocks</label>
      <label className="smc-sensitivity">Swing <select aria-label="SMC swing sensitivity" value={swingLength} onChange={(e) => setSwingLength(Number(e.target.value))}><option value={2}>Fast (2)</option><option value={3}>Normal (3)</option><option value={5}>Strict (5)</option><option value={8}>Wide (8)</option></select></label>
      <label>Draw <select value={drawMode} onChange={(e) => setDrawMode(e.target.value)}><option value="off">Off</option><option value="horizontal">S/R level</option><option value="trend">Trend line (2 clicks)</option></select></label>
      <span>RSI(14): <b className={metrics.rsi > 70 ? 'down' : metrics.rsi < 30 ? 'up' : ''}>{metrics.rsi == null ? '—' : metrics.rsi.toFixed(1)}</b></span>
      <span>ATR(14): <b>{metrics.atr == null ? '—' : fmt(metrics.atr)}</b></span>
      <span>MACD: <b className={metrics.macd?.histogram >= 0 ? 'up' : 'down'}>{metrics.macd ? metrics.macd.histogram.toFixed(5) : '—'}</b></span>
      <span>Avg vol: <b>{metrics.volume ? fmt(metrics.volume) : '—'}</b></span>
      {showStochRsi && <span>Stoch RSI: <b>{metrics.stochRsi == null ? '—' : metrics.stochRsi.toFixed(1)}</b></span>}
      {showObv && <span>OBV: <b>{fmt(metrics.obv)}</b></span>}
      {showSupertrend && <span>Trend bias: <b>{metrics.supertrend || '—'}</b></span>}
      {marketCounts && <span>Listed: <b>{marketCounts[marketType] ?? '—'}</b></span>}
    </div>
    <div className="chart-ohlc-strip">
      <b>{symbol}</b>
      <span>O <strong>{activeCandle ? fmt(activeCandle[1]) : '—'}</strong></span>
      <span>H <strong className="up">{activeCandle ? fmt(activeCandle[2]) : '—'}</strong></span>
      <span>L <strong className="down">{activeCandle ? fmt(activeCandle[3]) : '—'}</strong></span>
      <span>C <strong>{activeCandle ? fmt(activeCandle[4]) : '—'}</strong></span>
      <span>V <strong>{activeCandle ? fmt(activeCandle[5]) : '—'}</strong></span>
      {ticker?.last != null && <strong className="chart-last-price">{fmt(ticker.last)}</strong>}
    </div>
    {error ? <div className="chart-error">{error}</div> : !geometry ? <div className="chart-wait">{loading ? 'Loading live OHLC candles…' : 'Waiting for exchange candle data…'}</div> :
      <div className="candlestick-svg-wrap">
        <svg viewBox="0 0 1000 420" preserveAspectRatio="none" role="img" aria-label={symbol + ' live candlestick chart'} onClick={(event) => { if (drawMode === 'off' || !geometry) return; const rect=event.currentTarget.getBoundingClientRect(); const px=(event.clientX-rect.left)/rect.width*1000; const py=(event.clientY-rect.top)/rect.height*420; const price=geometry.max-(py-geometry.top)/(geometry.priceBottom-geometry.top)*(geometry.max-geometry.min); if(drawMode==='horizontal') setDrawings(v=>[...v,{kind:'level',price}]); else setDrawings(v=>v.length%2===0?[...v,{kind:'start',x:px,price}]:[...v,{kind:'end',x:px,price}]); }} onMouseLeave={() => setCrosshair(null)} onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const relative = (event.clientX - rect.left) / rect.width;
          const index = Math.max(0, Math.min(geometry.count - 1, Math.floor(((relative * 1000) - geometry.left) / (geometry.right - geometry.left) * geometry.count)));
          setCrosshair(index);
        }}>
          {calibratedPriceTicks(geometry.min, geometry.max, symbol, marketPrecisionMetadata[symbol] || { symbol, marketType }).map((value) => {
            const y = geometry.y(value);
            return <g key={'pip-'+value}><line x1={geometry.left} y1={y} x2="925" y2={y} stroke="#263247" strokeDasharray="3 4"/><text x="935" y={y + 3.5} fill="#8392a8" fontSize="9.5">{formatInstrumentPrice(value, marketPrecisionMetadata[symbol] || { symbol, marketType }, { maximumFractionDigits: 12 })}</text></g>;
          })}
          {geometry.rows.map((c, i) => {
            const up = c[4] >= c[1], color = up ? '#20c997' : '#f07883';
            const x = geometry.x(i), bodyTop = geometry.y(Math.max(c[1], c[4])), bodyBottom = geometry.y(Math.min(c[1], c[4]));
            const bodyHeight = Math.max(1.4, bodyBottom - bodyTop);
            const volHeight = c[5] / geometry.maxVol * volumeHeight;
            return <g key={c[0]}>
              <line x1={x} y1={geometry.y(c[2])} x2={x} y2={geometry.y(c[3])} stroke={color} strokeWidth="1.3"/>
              <rect x={x - candleWidth/2} y={bodyTop} width={candleWidth} height={bodyHeight} fill={color} stroke={color} rx=".5"/>
              {showVolume && <rect x={x - candleWidth/2} y={geometry.volumeBottom - volHeight} width={candleWidth} height={volHeight} fill={color} opacity=".42"/>}
              {i % Math.max(1, Math.floor(geometry.count / 7)) === 0 && <text x={x} y="405" textAnchor="middle" fill="#78889e" fontSize="10">{timeLabel(c[0], timeframe)}</text>}
            </g>;
          })}

          {gainzAlpha.setup&&geometry&&(()=>{const marks=[{timestamp:gainzAlpha.setup.sweepTimestamp,label:'SWEEP',color:'#e8b65d'},{timestamp:gainzAlpha.setup.reclaimTimestamp,label:'RECLAIM',color:'#60b8ff'},{timestamp:gainzAlpha.setup.displacementTimestamp,label:'DISPLACE',color:'#b38aff'}].filter(m=>m.timestamp);return marks.map(m=>{const index=geometry.rows.findIndex(c=>c[0]===m.timestamp);if(index<0)return null;const candle=geometry.rows[index],cx=geometry.x(index),cy=geometry.y(m.label==='SWEEP'?candle[2]:candle[4]);return <g key={'alpha-'+m.label}><circle cx={cx} cy={cy} r="5" fill={m.color} stroke="#0b1320" strokeWidth="1.5"/><text x={cx+7} y={cy-7} fill={m.color} fontSize="9" fontWeight="700">{m.label}</text></g>;});})()}
          <GainzAlphaOverlays ga={ga} geometry={geometry} onMount={setGaOverlaysMounted} suppress={ciReady ? ['fvg', 'structure', 'equalLevels', 'liquidity', 'signal', 'risk'] : []} />
          <ChartIntelligenceOverlays ci={ci.result} settings={ci.settings} geometry={geometry} compact={compactChart} onMount={setCiOverlaysMounted} />
          {showFvg && !ciReady && smartMoney.fairValueGaps.filter(z => z.end >= candles.length - geometry.count).map((z,i) => { const offset=candles.length-geometry.count; const x1=geometry.x(Math.max(0,z.start-offset)), x2=geometry.x(Math.min(geometry.count-1,z.end-offset)); const y1=geometry.y(z.top), y2=geometry.y(z.bottom); return <g key={'fvg'+i}><rect x={x1} y={Math.min(y1,y2)} width={Math.max(3,x2-x1)} height={Math.max(2,Math.abs(y2-y1))} fill={z.direction==='bullish'?'#20c997':'#f07883'} fillOpacity={z.mitigatedAt == null ? '.13' : '.045'} stroke={z.direction==='bullish'?'#20c997':'#f07883'} strokeOpacity={z.mitigatedAt == null ? '.55' : '.22'} strokeDasharray="3 3"/><text x={x1+3} y={Math.min(y1,y2)-3} fill={z.direction==='bullish'?'#20c997':'#f07883'} fontSize="9">{z.direction==='bullish'?'Bull FVG':'Bear FVG'}{z.mitigatedAt != null?' · filled':''}</text></g>; })}
          {showOrderBlocks && !ciReady && smartMoney.orderBlocks.filter(z => z.end >= candles.length - geometry.count).map((z,i) => { const offset=candles.length-geometry.count; const x1=geometry.x(Math.max(0,z.start-offset)), x2=geometry.x(Math.min(geometry.count-1,z.end-offset)); const y1=geometry.y(z.top), y2=geometry.y(z.bottom); return <g key={'ob'+i}><rect x={x1} y={Math.min(y1,y2)} width={Math.max(4,x2-x1)} height={Math.max(2,Math.abs(y2-y1))} fill={z.direction==='bullish'?'#20c997':'#f07883'} fillOpacity={z.mitigatedAt == null ? '.10' : '.04'} stroke={z.direction==='bullish'?'#20c997':'#f07883'} strokeWidth="1.2"/><text x={x1+3} y={Math.min(y1,y2)-3} fill={z.direction==='bullish'?'#20c997':'#f07883'} fontSize="9">{z.direction==='bullish'?'Bull OB':'Bear OB'}{z.mitigatedAt != null?' · invalidated':''}</text></g>; })}
          {showStructure && !ciReady && smartMoney.structureBreaks.filter(e => e.index >= candles.length - geometry.count).map((e,i) => { const x=geometry.x(e.index-(candles.length-geometry.count)), y=geometry.y(e.level); return <g key={'struct'+i}><line x1={geometry.left} y1={y} x2={x} y2={y} stroke={e.direction==='bullish'?'#20c997':'#f07883'} strokeWidth="1.2" strokeDasharray="5 3"/><text x={Math.max(geometry.left,x-42)} y={y+(e.direction==='bullish'?-5:12)} fill={e.direction==='bullish'?'#20c997':'#f07883'} fontSize="10">{e.kind} {e.direction==='bullish'?'↑':'↓'}</text></g>; })}
          {showSweeps && !ciReady && smartMoney.liquiditySweeps.filter(e => e.index >= candles.length - geometry.count).map((e,i) => { const x=geometry.x(e.index-(candles.length-geometry.count)), y=geometry.y(e.level); return <g key={'sweep'+i}><circle cx={x} cy={y} r="3.5" fill="#e5b85c"/><text x={x+4} y={y-6} fill="#e5b85c" fontSize="9">{e.direction==='buy-side'?'BSL sweep':'SSL sweep'}</text></g>; })}
          {showVwap && !ciReady && metrics.vwap && <line x1={geometry.left} y1={geometry.y(metrics.vwap)} x2={geometry.right} y2={geometry.y(metrics.vwap)} stroke="#38bdf8" strokeWidth="1.6" strokeDasharray="6 3"/>}
          {drawings.filter(d=>d.kind==='level').map((d,i)=><g key={'level'+i}><line x1={geometry.left} y1={geometry.y(d.price)} x2={geometry.right} y2={geometry.y(d.price)} stroke="#e5b85c" strokeDasharray="5 4"/><text x={geometry.left+5} y={geometry.y(d.price)-4} fill="#e5b85c" fontSize="10">S/R {fmt(d.price)}</text></g>)}
          {(alphaLevels || []).filter(level => Number.isFinite(Number(level.price))).map((level,i) => { const y=geometry.y(Number(level.price)); return <g key={'alpha-'+level.label+'-'+i}><line x1={geometry.left} y1={y} x2={geometry.right} y2={y} stroke={level.color || '#e5b85c'} strokeWidth="1.5" strokeDasharray="6 4"/><text x={geometry.left+6} y={y-5} fill={level.color || '#e5b85c'} fontSize="10">ALPHA {level.label}: {fmt(level.price)}</text></g>; })}
          {drawings.filter(d=>d.kind==='start').map((d,i)=>{const end=drawings.filter(x=>x.kind==='end')[i];return end?<line key={'trend'+i} x1={d.x} y1={geometry.y(d.price)} x2={end.x} y2={geometry.y(end.price)} stroke="#a78bfa" strokeWidth="2"/>:null;})}
          {showEma20 && <polyline points={geometry.points(metrics.ema20)} fill="none" stroke="#e5b85c" strokeWidth="1.7" vectorEffect="non-scaling-stroke"/>}
          {showEma50 && <polyline points={geometry.points(metrics.ema50)} fill="none" stroke="#9b8cf5" strokeWidth="1.7" vectorEffect="non-scaling-stroke"/>}
          {showBollinger && <><polyline points={geometry.points(metrics.bollinger.upper)} fill="none" stroke="#58a6ff" strokeWidth="1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke"/><polyline points={geometry.points(metrics.bollinger.lower)} fill="none" stroke="#58a6ff" strokeWidth="1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke"/></> }
          {crosshair !== null && <g><line x1={geometry.x(crosshair)} y1="10" x2={geometry.x(crosshair)} y2="385" stroke="#a9b7c9" strokeDasharray="3 4"/><line x1="12" y1={geometry.y(geometry.rows[crosshair][4])} x2="925" y2={geometry.y(geometry.rows[crosshair][4])} stroke="#a9b7c9" strokeDasharray="3 4"/></g>}
        </svg>
      </div>}
    <ChartIntelligenceLegend ci={ci.result} hook={ci} />
    <LiveOrderFlowPanel exchange={exchange} symbol={symbol} marketType={marketType} instrumentId={marketInstrumentId} candles={candles} />
    <div className="market-context-panel">
      <div className="market-context-heading"><b>MARKET CONFLUENCE INTELLIGENCE</b><span>{marketContext?.generatedAt ? 'Updated ' + new Date(marketContext.generatedAt).toLocaleTimeString() : 'Awaiting evidence'}</span></div>
      {marketContext ? <>
        <div className="market-context-summary"><strong className={marketContext.score.score > 0 ? 'up' : marketContext.score.score < 0 ? 'down' : ''}>{marketContext.score.direction.toUpperCase()}</strong><span>Evidence score {marketContext.score.score}</span><span>Confidence: {marketContext.score.confidence}</span><span>20-bar momentum: {marketContext.market.priceChangePct}%</span><span>Relative volume: {marketContext.market.volumeChangePct == null ? '—' : marketContext.market.volumeChangePct + '%'}</span><span>Global crypto market 24h: {marketContext.broadContext.globalMarketCapChange24hPct == null ? '—' : marketContext.broadContext.globalMarketCapChange24hPct.toFixed(2) + '%'}</span><span>Order-book imbalance: {marketContext.market.orderBookImbalancePct == null ? 'Not supported' : marketContext.market.orderBookImbalancePct + '%'}</span><span>Funding: {marketContext.market.fundingRate == null ? 'Not supported' : (marketContext.market.fundingRate * 100).toFixed(4) + '%'}</span></div>
        <div className="market-context-evidence">Timeframes: {marketContext.multiTimeframe.map((item) => item.timeframe + ' ' + item.bias + (item.changePct == null ? '' : ' (' + item.changePct + '%)')).join(' · ')}</div>
        <div className="market-context-evidence">{marketContext.score.evidence.map((item) => <span key={item.factor}>{item.factor}: <b>{item.contribution > 0 ? '+' : ''}{item.contribution}</b></span>)}</div>
        <div className="market-context-sources">{marketContext.sources.map((item) => <span key={item.name}><i className={item.status === 'live' ? 'source-live' : 'source-down'}/>{item.name}: {item.status}</span>)}</div>
        <p>{marketContext.limitations[0]} {marketContext.limitations[1]}</p>
      </> : <p>{contextError || 'Calculating exchange and global market context…'}</p>}
    </div>
    <div className="smc-event-strip">
      <div><small>FVG zones</small><strong>{smartMoney.fairValueGaps.length}</strong></div>
      <div><small>Liquidity sweeps</small><strong>{smartMoney.liquiditySweeps.length}</strong></div>
      <div><small>BOS / CHoCH</small><strong>{smartMoney.structureBreaks.length}</strong></div>
      <div><small>Order blocks</small><strong>{smartMoney.orderBlocks.length}</strong></div>
      <div className="smc-last-event"><small>Latest structure</small><strong>{smartMoney.structureBreaks.length ? smartMoney.structureBreaks[smartMoney.structureBreaks.length - 1].kind + ' · ' + smartMoney.structureBreaks[smartMoney.structureBreaks.length - 1].direction : 'Waiting for confirmation'}</strong></div>
    </div>
    <div className="smc-method-note">SMC analysis uses closed candles and confirmed swing points. Zones are rule-based technical estimates, not verified institutional orders or trade recommendations.</div>
    <div className="chart-footer">
      <span>{candles.length} candles · {timeframe} · Auto-refresh 20s · SMC uses closed candles · BOS/CHoCH {smartMoney.structureBreaks.length} · FVG {smartMoney.fairValueGaps.length}</span>
      <button type="button" onClick={() => setDrawings([])}>Clear drawings</button>
      <span>EMA 20 <i className="ema20-key"/> EMA 50 <i className="ema50-key"/> Bullish <i className="bull-key"/> Bearish <i className="bear-key"/></span>
    </div>
  </section>;
}
