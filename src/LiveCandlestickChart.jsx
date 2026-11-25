import React, { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, getApiSource, subscribeApiSource } from './lib/api.js';
import { detectSmartMoney } from './smartMoney.js';
import { getSessionSnapshot, analyzeSessionCandles } from './session-intelligence.js';
import { predictSessionHighLow, analyze24hLiquidity } from './session-liquidity-engine.js';
import { sessionForecastAdjustment, detectSessionLiquiditySweeps, sessionRiskAssessment, sessionPerformanceComparison, readSessionMemory, recordSessionOutcome, summarizeSessionMemory } from './session-trading-intelligence.js';
import { analyzeGainzAlphaInspired } from './gainz-alpha-intelligence.js';
import { useGainzAlpha } from './gainz-alpha/useGainzAlpha.js';
import GainzAlphaPanel from './gainz-alpha/GainzAlphaPanel.jsx';
import GainzAlphaOverlays from './gainz-alpha/GainzAlphaOverlays.jsx';
import { useChartIntelligence } from './chart-intelligence/useChartIntelligence.js';
import ChartIntelligenceOverlays from './chart-intelligence/ChartIntelligenceOverlays.jsx';
import ChartIntelligenceLegend from './chart-intelligence/ChartIntelligenceLegend.jsx';
import LiveOrderFlowPanel from './LiveOrderFlowPanel.jsx';
import { resolvePrecision, formatInstrumentPrice } from './chart-intelligence/precision.js';
import { candleCloseAt, candleCountdown, mergeLiveTick, resolvePipSize, pipDistance, axisWidthFor, applyPriceZoom } from './chart-live.js';
import { makeScale, buildScaleAxis, resolveRange } from './chart-scale.js';
import { useChartTools } from './useChartTools.js';
import { ChartToolsBar, ChartToolsSvg, pointFromEvent } from './ChartTools.jsx';
import { PRODUCT_OPTIONS, productSupport, resolveProductChoice, coerceProductForExchange } from './product-support.js';
import { getExpandedCanvasWidth, getExpandedCanvasHeight } from './chart-canvas.js';

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
const TX_EXPLORERS = { ethereum:'https://etherscan.io/tx/', eth:'https://etherscan.io/tx/', base:'https://basescan.org/tx/', arbitrum:'https://arbiscan.io/tx/', optimism:'https://optimistic.etherscan.io/tx/', bsc:'https://bscscan.com/tx/', polygon:'https://polygonscan.com/tx/', polygon_pos:'https://polygonscan.com/tx/', avalanche:'https://snowtrace.io/tx/', avax:'https://snowtrace.io/tx/', solana:'https://solscan.io/tx/' };
const transactionUrl = (trade) => TX_EXPLORERS[String(trade.chainId || '').toLowerCase()] ? TX_EXPLORERS[String(trade.chainId).toLowerCase()] + encodeURIComponent(trade.txHash) : null;
const timeLabel = (stamp, timeframe) => {
  const date = new Date(stamp);
  return ['1d', '3d', '1w', '1M'].includes(timeframe)
    ? date.toLocaleDateString([], { month: 'short', day: 'numeric' })
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export default function LiveCandlestickChart({ exchange, symbol, onSymbolChange, initialTimeframe, initialMarketType = 'futures', onTimeframeChange, onMarketTypeChange, onMarketSideChange, onExchangeChange, alphaLevels = [], synchronizedCrosshair = null, onCrosshairChange, terminalFocus = false }) {
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
  const [zoom, setZoom] = useState(1);
  const [followLatest, setFollowLatest] = useState(true);
  const [candleSpacing, setCandleSpacing] = useState(1.35);
  const [candleBodyPct, setCandleBodyPct] = useState(88);
  const [priceZoom, setPriceZoom] = useState(1);
  const [productNotice, setProductNotice] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [wrapEl, setWrapEl] = useState(null);
  const [plotSize, setPlotSize] = useState({ w: 1000, h: 420 });
  const [boundaryNonce, setBoundaryNonce] = useState(0);
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
    };
    syncSource();
    return subscribeApiSource(syncSource);
  }, [exchange]);
  useEffect(() => { const timer = setInterval(() => setSessionClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const apiMode = cloudflareMode ? 'cloudflare-edge' : directMode ? 'direct' : 'api';
  const support = useMemo(() => productSupport({ exchange, mode: apiMode, cfdReady: cloudflareMode }), [exchange, apiMode, cloudflareMode]);
  const sessionSnapshot = useMemo(() => getSessionSnapshot(sessionClock), [sessionClock]);
  const sessionAnalytics = useMemo(() => analyzeSessionCandles(candles, sessionClock), [candles, sessionClock]);
  const sessionForecast = useMemo(() => sessionForecastAdjustment(candles, {symbol, timeframe, now:sessionClock}), [candles, symbol, timeframe, sessionClock]);
  const sessionForecastBands = useMemo(() => predictSessionHighLow(candles.slice(0, -1), { symbol, timeframe, now: sessionClock, chainDex: marketContext?.chainDex || null }), [candles, symbol, timeframe, sessionClock, marketContext?.chainDex]);
  const observed24hLiquidity = useMemo(() => analyze24hLiquidity(candles.slice(0, -1), { now: sessionClock, timeframe, ticker }), [candles, sessionClock, timeframe, ticker]);
  const sessionDecisionContext = useMemo(() => ({ ...sessionForecastBands, liquidity24h: observed24hLiquidity }), [sessionForecastBands, observed24hLiquidity]);
  const chainDexTrades = useMemo(() => marketContext?.chainDex?.trades?.length ? marketContext.chainDex.trades : (marketContext?.chainDex?.history?.transactions || []), [marketContext?.chainDex]);
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
  const ci = useChartIntelligence({ exchange, symbol, timeframe, marketType, candles, ga, externalLevels: alphaLevels, institutionalContext: marketContext, chainDexContext: marketContext?.chainDex || null, sessionContext: sessionDecisionContext, clock: sessionClock });
  const ciReady = Boolean(ci.settings.enabled && ci.result && ci.result.status === 'ready');
  const [ciOverlaysMounted, setCiOverlaysMounted] = useState(false);
  const [compactChart, setCompactChart] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 600px)').matches : false));
  useEffect(() => { if (typeof window === 'undefined' || !window.matchMedia) return undefined; const mq = window.matchMedia('(max-width: 600px)'), on = () => setCompactChart(mq.matches); mq.addEventListener ? mq.addEventListener('change', on) : mq.addListener(on); return () => { mq.removeEventListener ? mq.removeEventListener('change', on) : mq.removeListener(on); }; }, []);
  const ciPlanPrices = useMemo(() => { const p = ciReady && ci.settings.layers.plan ? ci.result.plan : null; if (!p) return []; const a = ci.result.atr || 0; return [p.entry, p.stopLoss, ...p.targets.filter((t) => Math.abs(t.price - p.entry) <= a * 8).slice(0, 3).map((t) => t.price)].filter(Number.isFinite); }, [ci.result, ci.settings.layers.plan, ciReady]);
  const recordCurrentOutcome = async () => { const active = sessionSnapshot.sessions.filter(x=>x.active).map(x=>x.name); const record={session:active.join('+')||'Off-session',symbol,strategy:memoryStrategy||'Unspecified',volatility:sessionRisk.mode,outcome:memoryOutcome,returnR:memoryReturnR===''?null:Number(memoryReturnR)}; try { const response=await apiFetch('/api/session/memory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(record)}); const data=await response.json(); if(!response.ok||!data.ok)throw new Error(data.error||'Session memory save failed'); setSessionMemory(prev=>[data.record,...prev].slice(0,2000)); setSessionMemoryStatus('saved to backend'); } catch(error) { const local=recordSessionOutcome(record); if(local.ok)setSessionMemory(readSessionMemory()); setSessionMemoryStatus('backend unavailable · saved locally'); } };

  useEffect(() => { let active=true; const legacy=readSessionMemory(); apiFetch('/api/session/memory').then(response=>response.ok?response.json():null).then(async data=>{if(!active||!Array.isArray(data?.records))return; if(legacy.length){const migrated=await apiFetch('/api/session/memory/batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({records:legacy})});if(!migrated.ok)throw new Error('legacy session memory migration failed');if(typeof localStorage!=='undefined')localStorage.removeItem('jpti.session-memory.v1');const refreshed=await apiFetch('/api/session/memory');const result=await refreshed.json();if(active&&Array.isArray(result.records)){setSessionMemory(result.records);setSessionMemoryStatus('legacy memory migrated');}return;} setSessionMemory(data.records);setSessionMemoryStatus('backend synced');}).catch(()=>{if(active)setSessionMemoryStatus('backend unavailable · local memory retained');}); return ()=>{active=false;}; }, []);
  useEffect(() => { if (initialTimeframe && initialTimeframe !== timeframe) setTimeframe(initialTimeframe); }, [initialTimeframe]);
  const reportedTimeframe = useRef(null);
  useEffect(() => { if (reportedTimeframe.current === timeframe) return; reportedTimeframe.current = timeframe; if (onTimeframeChange) onTimeframeChange(timeframe); }, [timeframe, onTimeframeChange]);
  const marketInstrumentId = exchange === 'bitget' ? String(marketInstrumentIds[symbol] || '') : '';
  const marketInstrumentQuery = marketInstrumentId ? '&instrumentId=' + encodeURIComponent(marketInstrumentId) : '';
  const marketSideQuery = marketType === 'cfd' ? '&side=' + encodeURIComponent(marketSide) : '';
  const tickerKey = exchange + '|' + symbol + '|' + marketType + '|' + marketInstrumentId;

  // Product sync is one-directional per event: a new parent prop is applied once, and a user
  // selection is reported up. Re-applying the prop on every local change made the parent and the
  // chart overwrite each other, snapping the product back (to Spot) or looping.
  const appliedInitialMarketType = useRef(initialMarketType);
  useEffect(() => {
    if (initialMarketType && initialMarketType !== appliedInitialMarketType.current) {
      appliedInitialMarketType.current = initialMarketType;
      setMarketType(initialMarketType);
    }
  }, [initialMarketType]);
  const reportedMarketType = useRef(null);
  useEffect(() => {
    if (reportedMarketType.current === marketType) return;
    reportedMarketType.current = marketType;
    if (onMarketTypeChange) onMarketTypeChange(marketType);
  }, [marketType, onMarketTypeChange]);
  const reportedMarketSide = useRef(null);
  useEffect(() => {
    if (reportedMarketSide.current === marketSide) return;
    reportedMarketSide.current = marketSide;
    if (onMarketSideChange) onMarketSideChange(marketSide);
  }, [marketSide, onMarketSideChange]);

  // A product the venue cannot serve falls back to Spot visibly (never silently) when the exchange or API mode changes.
  useEffect(() => { const next = coerceProductForExchange({ exchange, marketType, mode: apiMode, cfdReady: cloudflareMode }); if (next.marketType !== marketType) { setMarketType(next.marketType); setProductNotice(next.notice); } }, [exchange, marketType, apiMode, cloudflareMode]);

  useEffect(() => {
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
      tickerPromise.then((result) => { if (result.ok) setTicker({ ...result.data, __key: tickerKey }); });
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
          if (active && !signal.aborted && result.ok) setTicker({ ...result.data, __key: tickerKey });
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
  }, [exchange, symbol, timeframe, marketType, marketInstrumentId, marketSide, marketSymbols, catalogError, boundaryNonce]);

  // Live tick feed: the ticker is polled every 4s between the 20s OHLCV refreshes and merged into the forming candle.
  useEffect(() => {
    if (marketType === 'cfd') return undefined;
    let active = true;
    let inFlight = false;
    const encodedSymbol = symbol.replace('/', '-');
    const poll = async () => {
      if (inFlight || (typeof document !== 'undefined' && document.hidden)) return;
      inFlight = true;
      try {
        const response = await apiFetch('/api/exchanges/' + exchange + '/ticker/' + encodedSymbol + '?type=' + encodeURIComponent(marketType) + marketInstrumentQuery);
        const data = await response.json();
        if (active && response.ok) setTicker({ ...data, __key: tickerKey });
      } catch { /* the next poll retries; the OHLCV refresh keeps the chart alive meanwhile */ } finally { inFlight = false; }
    };
    const timer = setInterval(poll, 4000);
    return () => { active = false; clearInterval(timer); };
  }, [exchange, symbol, marketType, marketInstrumentId]);
  // Refresh the candles right after the forming candle closes instead of waiting for the next 20s poll.
  useEffect(() => {
    if (!candles.length) return undefined;
    const close = candleCloseAt(candles[candles.length - 1][0], timeframe);
    if (close == null) return undefined;
    const wait = close - Date.now() + 1500;
    if (wait <= 0 || wait > 2147483000) return undefined;
    const timer = setTimeout(() => setBoundaryNonce((n) => n + 1), wait);
    return () => clearTimeout(timer);
  }, [candles, timeframe]);
  const livePrice = ticker && ticker.__key === tickerKey ? Number(ticker.last) : null;
  const precisionMeta = useMemo(() => marketPrecisionMetadata[symbol] || { symbol, marketType }, [marketPrecisionMetadata, symbol, marketType]);
  const toolPip = useMemo(() => resolvePipSize({ symbol, price: candles.length ? candles[candles.length - 1][4] : livePrice, precision: resolvePrecision(precisionMeta) }).pip, [symbol, candles, livePrice, precisionMeta]);
  const tools = useChartTools({ exchange, marketType, symbol, timeframe, candles, livePrice, instrumentId: marketInstrumentId, pip: toolPip });
  const streamPrice = tools.streamFresh ? tools.stream.price : null;
  const formingNow = useMemo(() => { if (!candles.length) return false; const close = candleCloseAt(candles[candles.length - 1][0], timeframe); return close != null && close > sessionClock; }, [candles, timeframe, sessionClock]);
  // sessionClock is intentionally not a dependency: formingNow already flips when the forming candle closes.
  // Replay shows history up to the cursor (no live ticks). Otherwise the exchange WebSocket price, when fresh, beats the 4s poll.
  const liveCandles = useMemo(() => {
    if (tools.replaying) return tools.applyReplay(candles);
    return formingNow && marketType !== 'cfd' ? mergeLiveTick(candles, streamPrice ?? livePrice, { timeframe, now: Date.now() }) : candles;
  }, [candles, livePrice, streamPrice, formingNow, timeframe, marketType, tools.replaying, tools.applyReplay]);
  const countdown = candles.length ? candleCountdown(candles[candles.length - 1][0], timeframe, sessionClock) : null;

  const metrics = useMemo(() => {
    const series = liveCandles;
    const closes = series.map((c) => c[4]);
    const last = series[series.length - 1];
    const previous = series[series.length - 2];
    return {
      ema20: ema(closes, 20), ema50: ema(closes, 50),
      bollinger: bollinger(closes), macd: macd(closes),
      rsi: rsi(closes), atr: atr(series),
      last, previous,
      change: last && previous ? ((last[4] - previous[4]) / previous[4]) * 100 : null,
      volume: series.slice(-20).reduce((sum, c) => sum + c[5], 0) / Math.min(20, series.length),
      vwap: (() => { const rows = series.slice(-100); const pv = rows.reduce((sum,c) => sum + ((c[2]+c[3]+c[4])/3)*c[5],0); const vol = rows.reduce((sum,c) => sum+c[5],0); return vol ? pv/vol : null; })(),
      obv: series.reduce((sum,c,i) => i === 0 ? 0 : sum + (c[4] > series[i-1][4] ? c[5] : c[4] < series[i-1][4] ? -c[5] : 0),0),
      stochRsi: (() => { if (closes.length < 28) return null; const values=[]; for(let i=27;i<closes.length;i++) { const value=rsi(closes.slice(0,i+1)); if(value!=null) values.push(value); } const current=rsi(closes); if(current==null||!values.length)return null; const lo=Math.min(...values.slice(-14)),hi=Math.max(...values.slice(-14)); return hi===lo?50:(current-lo)/(hi-lo)*100; })(),
      supertrend: (() => { if(series.length<15)return null; const last=series[series.length-1]; const range=atr(series,14); return range==null?null:(last[4] >= (last[2]+last[3])/2 ? 'Bullish bias' : 'Bearish bias'); })()
    };
  }, [liveCandles]);

  const smartMoney = useMemo(() => detectSmartMoney(candles.slice(0, -1), swingLength), [candles, swingLength]);

  const liveClose = liveCandles.length ? liveCandles[liveCandles.length - 1][4] : null;
  const pipInfo = useMemo(() => resolvePipSize({ symbol, price: liveClose, precision: resolvePrecision(precisionMeta) }), [symbol, liveClose, precisionMeta]);

  // The plot fills its container: candles run left edge to price axis and top to the time axis. No volume pane.
  const geometry = useMemo(() => {
    if (!liveCandles.length) return null;
    // Start with a readable 120-candle window; zooming out reveals progressively older history.
    const baseCount = Math.max(25, Math.min(liveCandles.length, Math.floor(120 / candleSpacing)));
    const count = Math.max(25, Math.min(liveCandles.length, Math.floor(baseCount / zoom)));
    const rows = liveCandles.slice(-count);
    const canvasWidth = getExpandedCanvasWidth(plotSize.w, count, baseCount);
    const canvasHeight = getExpandedCanvasHeight(plotSize.h, count, baseCount);
    const levelPrices = [...(alphaLevels || []).map(level => Number(level.price)).filter(Number.isFinite), ...ciPlanPrices];
    const min = Math.min(...rows.map((c) => c[3]), ...levelPrices);
    const max = Math.max(...rows.map((c) => c[2]), ...levelPrices);
    const padding = (max - min || max * 0.002 || 1) * 0.06;
    const lastClose = rows[rows.length - 1][4];
    const { low, high } = applyPriceZoom(min - padding, max + padding, priceZoom, priceZoom > 1 ? lastClose : undefined);
    const left = 4, top = 10, bottom = Math.max(top + 60, canvasHeight - 22);
    const range = resolveRange({ lo: low, hi: high }, tools.lockedRange);
    const scale = makeScale({ mode: tools.prefs.scaleMode, lo: range.lo, hi: range.hi, top, bottom });
    const axis = buildScaleAxis({ mode: scale.mode, lo: range.lo, hi: range.hi, top, bottom, pip: pipInfo.pip, ref: lastClose, minLabelPx: 14 });
    const axisW = axisWidthFor([...axis.ticks.map((t) => t.label), formatInstrumentPrice(lastClose, precisionMeta, { maximumFractionDigits: 12 })]);
    const right = Math.max(left + 80, canvasWidth - axisW);
    const x = (i) => left + (i + 0.5) * ((right - left) / rows.length);
    const y = scale.y;
    const points = (values) => values.slice(liveCandles.length - count).map((value, i) => Number.isFinite(value) ? x(i) + ',' + y(value) : null).filter(Boolean).join(' ');
    return { rows, count, min: range.lo, max: range.hi, lo: range.lo, hi: range.hi, left, right, top, priceBottom: bottom, bottom, width: canvasWidth, viewportWidth: plotSize.w, height: canvasHeight, viewportHeight: plotSize.h, axisW, axis, pip: pipInfo.pip, x, y, priceAt: scale.price, slot: (right - left) / rows.length, scaleMode: scale.mode, points };
  }, [liveCandles, zoom, candleSpacing, alphaLevels, ciPlanPrices, priceZoom, plotSize, pipInfo, precisionMeta, tools.lockedRange, tools.prefs.scaleMode]);

  const activeCandle = (crosshair !== null && geometry ? geometry.rows[crosshair.i] : null) || metrics.last;
  const candleSlot = geometry ? (geometry.right - geometry.left) / geometry.count : 6;
  const candleWidth = Math.max(2, Math.min(36, candleSlot * candleBodyPct / 100));

  // Measure the chart container so the SVG is drawn 1:1 in CSS pixels (no stretching, text stays crisp).
  useEffect(() => {
    if (!wrapEl || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 60 && height > 60) setPlotSize((current) => (current.w === Math.round(width) && current.h === Math.round(height) ? current : { w: Math.round(width), h: Math.round(height) }));
    });
    observer.observe(wrapEl);
    return () => observer.disconnect();
  }, [wrapEl]);
  // Wheel over the price axis zooms the price scale (more or fewer pips). Native listener: React's wheel handler is passive.
  const axisEdgeRef = useRef(0);
  axisEdgeRef.current = geometry ? geometry.right : 0;
  useEffect(() => {
    if (!wrapEl) return undefined;
    const onWheel = (event) => {
      const rect = wrapEl.getBoundingClientRect();
      if (!axisEdgeRef.current || event.clientX - rect.left + wrapEl.scrollLeft <= axisEdgeRef.current) return;
      event.preventDefault();
      setPriceZoom((value) => Math.max(0.5, Math.min(12, value * (event.deltaY < 0 ? 1.12 : 1 / 1.12))));
    };
    wrapEl.addEventListener('wheel', onWheel, { passive: false });
    return () => wrapEl.removeEventListener('wheel', onWheel);
  }, [wrapEl]);
  // Keep the newest candles in view after the visible history expands or contracts.
  useEffect(() => { if (wrapEl && followLatest) { wrapEl.scrollLeft = wrapEl.scrollWidth; wrapEl.scrollTop = wrapEl.scrollHeight; } }, [zoom, liveCandles.length, liveCandles.at(-1)?.[0], followLatest]);
  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') setExpanded(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const selectProduct = (value) => {
    const choice = resolveProductChoice({ exchange, requested: value, mode: apiMode, cfdReady: cloudflareMode });
    if (!choice.ok) { setProductNotice(choice.notice); return; }
    if (choice.exchange !== exchange) {
      if (typeof onExchangeChange !== 'function') { setProductNotice('This venue cannot serve that product here. Choose Bitget as the exchange to use it.'); return; }
      onExchangeChange(choice.exchange);
    }
    setProductNotice(choice.notice);
    setMarketType(choice.marketType);
  };

  return <section className={"panel exchange-connect trading-chart-panel" + (terminalFocus ? " jpti-terminal-focus-chart" : "")}>
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
      <select aria-label="Market type" value={marketType} onChange={(e) => selectProduct(e.target.value)}>
        {PRODUCT_OPTIONS.map((item) => { const entry = support[item.value]; const suffix = item.value === 'cfd' && !entry.available ? ' · Cloudflare UTA read-only key required' : entry.available && !entry.native ? ' → Bitget' : ''; return <option key={item.value} value={item.value} disabled={!entry.available} title={entry.reason}>{item.label + suffix}</option>; })}
        <option value="options" disabled>Options (not enabled in this adapter)</option>
      </select>
      {productNotice && <span className="subtle-note" role="status">{productNotice}</span>}
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
        <button onClick={() => setZoom((v) => Math.max(0.1, v / 1.35))} title="Zoom out">－</button>
        <button onClick={() => setZoom(1)} title="Fit the default candle range">Fit</button>
        <button type="button" aria-pressed={followLatest} className={followLatest ? 'active' : ''} onClick={() => setFollowLatest(value => !value)} title="Automatically keep the newest candle in view">{followLatest ? 'Following' : 'Follow'}</button>
        <button onClick={() => setPriceZoom((v) => Math.min(12, v * 1.25))} title="Zoom the price scale in (more pips visible per label)">Pip ＋</button>
        <button onClick={() => setPriceZoom((v) => Math.max(0.5, v / 1.25))} title="Zoom the price scale out">Pip －</button>
        <button onClick={() => setPriceZoom(1)} title="Auto-fit the price scale">Auto</button>
        <button onClick={() => setExpanded((v) => !v)} aria-pressed={expanded} title="Expand or restore the chart (Esc closes)">{expanded ? '⤡' : '⤢'}</button>
        <button onClick={load} title="Refresh chart">{loading ? '…' : '↻'}</button>
      </div>
    </div>
    <div className="chart-size-controls" aria-label="Chart sizing controls">
      <label><span>Candle spacing <b>{candleSpacing.toFixed(2)}×</b></span><input aria-label="Candle spacing" type="range" min="0.65" max="10" step="0.05" value={candleSpacing} onChange={(e) => setCandleSpacing(Number(e.target.value))}/></label>
      <label><span>Candle body width <b>{candleBodyPct}%</b></span><input aria-label="Candle body width" type="range" min="35" max="100" step="1" value={candleBodyPct} onChange={(e) => setCandleBodyPct(Number(e.target.value))}/></label>
      <label><span>Price scale <b>{priceZoom === 1 ? 'Auto' : priceZoom.toFixed(2) + '×'}</b></span><input aria-label="Price scale zoom" type="range" min="0.5" max="12" step="0.05" value={priceZoom} onChange={(e) => setPriceZoom(Number(e.target.value))}/></label>
      <button type="button" onClick={() => { setCandleSpacing(1.35); setCandleBodyPct(88); setPriceZoom(1); setZoom(1); }}>Reset chart sizing</button>
    </div>
    <div className="chart-indicator-controls">
      <label><input type="checkbox" checked={showEma20} onChange={(e) => setShowEma20(e.target.checked)}/> EMA 20</label>
      <label><input type="checkbox" checked={showEma50} onChange={(e) => setShowEma50(e.target.checked)}/> EMA 50</label>
      <label><input type="checkbox" checked={showBollinger} onChange={(e) => setShowBollinger(e.target.checked)}/> Bollinger</label>
      <label><input type="checkbox" checked={showVwap} onChange={(e) => setShowVwap(e.target.checked)}/> VWAP</label>
      <label><input type="checkbox" checked={showStochRsi} onChange={(e) => setShowStochRsi(e.target.checked)}/> Stoch RSI</label>
      <label><input type="checkbox" checked={showObv} onChange={(e) => setShowObv(e.target.checked)}/> OBV</label>
      <label><input type="checkbox" checked={showSupertrend} onChange={(e) => setShowSupertrend(e.target.checked)}/> Price trend bias</label>
      <label className="smc-toggle"><input type="checkbox" checked={showFvg} onChange={(e) => setShowFvg(e.target.checked)}/> FVG</label>
      <label className="smc-toggle"><input type="checkbox" checked={showSweeps} onChange={(e) => setShowSweeps(e.target.checked)}/> Liquidity sweeps</label>
      <label className="smc-toggle"><input type="checkbox" checked={showStructure} onChange={(e) => setShowStructure(e.target.checked)}/> BOS / CHoCH</label>
      <label className="smc-toggle"><input type="checkbox" checked={showOrderBlocks} onChange={(e) => setShowOrderBlocks(e.target.checked)}/> Order blocks</label>
      <label className="smc-sensitivity">Swing <select aria-label="SMC swing sensitivity" value={swingLength} onChange={(e) => setSwingLength(Number(e.target.value))}><option value={2}>Fast (2)</option><option value={3}>Normal (3)</option><option value={5}>Strict (5)</option><option value={8}>Wide (8)</option></select></label>
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
      {geometry && <span>Showing <strong>{geometry.count}/{liveCandles.length}</strong> candles</span>}
      {activeCandle && geometry && <span>Range <strong>{pipDistance(activeCandle[3], activeCandle[2], geometry.pip) ?? '—'}</strong> pips</span>}
      {tools.replaying && <span className="chart-countdown"><strong>REPLAY</strong></span>}
      {!tools.replaying && countdown && !countdown.expired && <span className="chart-countdown" title="Time until the forming candle closes">Closes in <strong>{countdown.label}</strong></span>}
      {ticker?.last != null && <strong className="chart-last-price">{fmt(ticker.last)}</strong>}
    </div>
    <div className="live-tools"><ChartToolsBar tools={tools} geoRange={geometry ? { lo: geometry.lo, hi: geometry.hi } : null} fmt={fmt} unit="pips" timeframe={timeframe} /></div>
    {error ? <div className="chart-error">{error}</div> : !geometry ? <div className="chart-wait">{loading ? 'Loading live OHLC candles…' : 'Waiting for exchange candle data…'}</div> :
      <div className={'candlestick-svg-wrap' + (expanded ? ' chart-expanded' : '')} ref={setWrapEl}>
        <svg width={geometry.width} height={geometry.height} viewBox={'0 0 ' + geometry.width + ' ' + geometry.height} role="img" aria-label={symbol + ' live candlestick chart'} onClick={(event) => { if (tools.tool === 'cursor' || !geometry) return; const point = pointFromEvent(event, geometry, timeframe); if (point.inPlot || (tools.tool === 'alert' && point.inAxis)) tools.handlePointer('click', point); }} style={tools.tool !== 'cursor' ? { cursor: 'crosshair' } : undefined} onDoubleClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); if (geometry && event.clientX - rect.left > geometry.right) setPriceZoom(1); }} onMouseLeave={() => { setCrosshair(null); onCrosshairChange?.(null); tools.broadcastCrosshair(null); }} onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const px = event.clientX - rect.left, py = event.clientY - rect.top;
          if (px > geometry.right || px < geometry.left) { setCrosshair(null); onCrosshairChange?.(null); tools.broadcastCrosshair(null); return; }
          const index = Math.max(0, Math.min(geometry.count - 1, Math.floor((px - geometry.left) / (geometry.right - geometry.left) * geometry.count)));
          setCrosshair({ i: index, py });
          const candle = geometry.rows[index];
          const price = geometry.priceAt(py);
          onCrosshairChange?.({ timestamp: candle?.[0] ?? null, price: Number.isFinite(price) ? price : null, symbol });
          const point = pointFromEvent(event, geometry, timeframe);
          if (point.inPlot) { tools.handlePointer('move', point); tools.broadcastCrosshair(point); }
        }}>
          {geometry.axis.minor.map((price) => <line key={'minor-' + price} x1={geometry.left} y1={geometry.y(price)} x2={geometry.right} y2={geometry.y(price)} stroke="#18243a" strokeWidth="0.6"/>)}
          {geometry.axis.ticks.map((tick) => {
            const y = geometry.y(tick.price);
            return <g key={'pip-' + tick.price}><line x1={geometry.left} y1={y} x2={geometry.right} y2={y} stroke={tick.major ? '#2a3850' : '#1f2b40'} strokeDasharray="3 4"/><text x={geometry.right + 8} y={y + 3.5} fill={tick.major ? '#9aabc2' : '#7a8aa1'} fontSize="10">{tick.label}</text></g>;
          })}
          <line x1={geometry.right} y1={geometry.top} x2={geometry.right} y2={geometry.bottom} stroke="#22314a"/>
          {geometry.rows.map((c, i) => {
            const up = c[4] >= c[1], color = up ? '#20c997' : '#f07883';
            const x = geometry.x(i), bodyTop = geometry.y(Math.max(c[1], c[4])), bodyBottom = geometry.y(Math.min(c[1], c[4]));
            const bodyHeight = Math.max(1.4, bodyBottom - bodyTop);
            return <g key={c[0]}>
              <line x1={x} y1={geometry.y(c[2])} x2={x} y2={geometry.y(c[3])} stroke={color} strokeWidth="1.3"/>
              <rect x={x - candleWidth/2} y={bodyTop} width={candleWidth} height={bodyHeight} fill={color} stroke={color} rx=".5"/>
              {i % Math.max(1, Math.floor(geometry.count / 7)) === 0 && <text x={x} y={geometry.height - 6} textAnchor="middle" fill="#78889e" fontSize="10">{timeLabel(c[0], timeframe)}</text>}
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
          {(alphaLevels || []).filter(level => Number.isFinite(Number(level.price))).map((level,i) => { const y=geometry.y(Number(level.price)); return <g key={'alpha-'+level.label+'-'+i}><line x1={geometry.left} y1={y} x2={geometry.right} y2={y} stroke={level.color || '#e5b85c'} strokeWidth="1.5" strokeDasharray="6 4"/><text x={geometry.left+6} y={y-5} fill={level.color || '#e5b85c'} fontSize="10">ALPHA {level.label}: {fmt(level.price)}</text></g>; })}
          {showEma20 && <polyline points={geometry.points(metrics.ema20)} fill="none" stroke="#e5b85c" strokeWidth="1.7" vectorEffect="non-scaling-stroke"/>}
          {showEma50 && <polyline points={geometry.points(metrics.ema50)} fill="none" stroke="#9b8cf5" strokeWidth="1.7" vectorEffect="non-scaling-stroke"/>}
          {showBollinger && <><polyline points={geometry.points(metrics.bollinger.upper)} fill="none" stroke="#58a6ff" strokeWidth="1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke"/><polyline points={geometry.points(metrics.bollinger.lower)} fill="none" stroke="#58a6ff" strokeWidth="1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke"/></> }
          {(() => {
            const lastRow = geometry.rows[geometry.rows.length - 1];
            const tint = lastRow[4] >= lastRow[1] ? '#20c997' : '#f07883', yLast = geometry.y(lastRow[4]);
            if (yLast < geometry.top - 2 || yLast > geometry.bottom + 2) return null;
            const tagY = Math.max(geometry.top + 9, Math.min(geometry.bottom - 9, yLast)), tagW = geometry.axisW - 2;
            return <g pointerEvents="none"><line x1={geometry.left} y1={yLast} x2={geometry.right} y2={yLast} stroke={tint} strokeDasharray="2 3" strokeOpacity=".85"/><g transform={'translate(' + (geometry.right + 1) + ' ' + (tagY - 9) + ')'}><rect width={tagW} height="18" rx="3" fill={tint}/><text x={tagW / 2} y="12.5" textAnchor="middle" fill="#06101d" fontSize="10.5" fontWeight="700">{formatInstrumentPrice(lastRow[4], precisionMeta, { maximumFractionDigits: 12 })}</text></g>{countdown && !countdown.expired && <g transform={'translate(' + (geometry.right + 1) + ' ' + (tagY + 10) + ')'}><rect width={tagW} height="15" rx="3" fill="#152238" stroke="#2c3f5c"/><text x={tagW / 2} y="11" textAnchor="middle" fill="#b8c7dc" fontSize="9.5">{countdown.label}</text></g>}</g>;
          })()}
          <ChartToolsSvg tools={tools} geo={geometry} timeframe={timeframe} symbol={symbol} fmt={fmt} unit="pips" width={geometry.width} height={geometry.height} suppressGhost={synchronizedCrosshair?.timestamp != null} />
          {(synchronizedCrosshair?.timestamp != null || crosshair !== null) && (() => {
            const sharedIndex = synchronizedCrosshair?.timestamp != null
              ? geometry.rows.reduce((best, candle, index, rows) => Math.abs(candle[0] - synchronizedCrosshair.timestamp) < Math.abs(rows[best][0] - synchronizedCrosshair.timestamp) ? index : best, 0)
              : crosshair.i;
            const sameInstrument = !synchronizedCrosshair || synchronizedCrosshair.symbol === symbol;
            const hoverPrice = sameInstrument ? (synchronizedCrosshair?.price != null ? synchronizedCrosshair.price : geometry.priceAt(crosshair.py)) : null;
            const yPrice = hoverPrice == null ? null : geometry.y(hoverPrice);
            const inside = sameInstrument && yPrice >= geometry.top && yPrice <= geometry.priceBottom, tagW = geometry.axisW - 2;
            const pips = hoverPrice == null ? null : pipDistance(geometry.rows[geometry.rows.length - 1][4], hoverPrice, geometry.pip);
            return <g pointerEvents="none"><line x1={geometry.x(sharedIndex)} y1={geometry.top} x2={geometry.x(sharedIndex)} y2={geometry.bottom} stroke="#a9b7c9" strokeDasharray="3 4"/>{inside && <><line x1={geometry.left} y1={yPrice} x2={geometry.right} y2={yPrice} stroke="#a9b7c9" strokeDasharray="3 4"/><g transform={'translate(' + (geometry.right + 1) + ' ' + (yPrice - 15) + ')'}><rect width={tagW} height="30" rx="3" fill="#24344d" stroke="#4a6385"/><text x={tagW / 2} y="12" textAnchor="middle" fill="#e6eefb" fontSize="10.5" fontWeight="700">{formatInstrumentPrice(hoverPrice, precisionMeta, { maximumFractionDigits: 12 })}</text><text x={tagW / 2} y="25" textAnchor="middle" fill={pips != null && pips < 0 ? '#f07883' : '#20c997'} fontSize="9.5">{pips == null ? '' : (pips > 0 ? '+' : '') + pips + ' pips'}</text></g></>}</g>;
          })()}
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
    <div className="market-context-panel institutional-decision-panel">
      <div className="market-context-heading"><b>INSTITUTIONAL DECISION INPUT</b><span>{ci.result?.institutional?.status === 'ready' ? 'FED INTO CHART CONFLUENCE' : ci.result?.institutional?.status === 'stale' ? 'STALE · EXCLUDED' : 'AWAITING VERIFIED INPUT'}</span></div>
      <div className="market-context-summary">
        <strong className={ci.result?.institutional?.score > 0 ? 'up' : ci.result?.institutional?.score < 0 ? 'down' : ''}>{ci.result?.institutional?.status === 'ready' ? (ci.result.institutional.score > 0 ? 'BULLISH' : ci.result.institutional.score < 0 ? 'BEARISH' : 'NEUTRAL') : 'UNAVAILABLE'}</strong>
        <span>Institutional score {ci.result?.institutional?.score ?? '—'}</span><span>Confidence {ci.result?.institutional?.confidence ?? '—'}</span>
        <span>Source coverage {ci.result?.institutional?.sourceCoverage == null ? '—' : (ci.result.institutional.sourceCoverage * 100).toFixed(0) + '%'}</span>
        <span>Chart confluence {ci.result?.confluence?.score ?? '—'}</span>
        <span>Institutional contribution {ci.result?.confluence?.components?.find(x => x.key === 'institutional')?.contribution ?? '0'}</span>
      </div>
      <div className="market-context-evidence">{(ci.result?.institutional?.evidence || []).map(item => <span key={item.factor}>{item.factor}: <b>{item.contribution > 0 ? '+' : ''}{item.contribution}</b></span>)}</div>
      <div className="market-context-evidence">
        <span>CFTC dealer net: <b>{marketContext?.institutionalSources?.cftc?.dealer?.net == null ? '—' : Number(marketContext.institutionalSources.cftc.dealer.net).toLocaleString()}</b></span>
        <span>CFTC asset-manager net: <b>{marketContext?.institutionalSources?.cftc?.assetManager?.net == null ? '—' : Number(marketContext.institutionalSources.cftc.assetManager.net).toLocaleString()}</b></span>
        <span>CFTC leveraged-fund net: <b>{marketContext?.institutionalSources?.cftc?.leveragedMoney?.net == null ? '—' : Number(marketContext.institutionalSources.cftc.leveragedMoney.net).toLocaleString()}</b></span>
        <span>COT report date: <b>{marketContext?.institutionalSources?.cftc?.reportDate || '—'}</b></span>
        <span>10Y Treasury: <b>{marketContext?.institutionalSources?.macro?.fred?.DGS10?.latest?.value ?? '—'}%</b></span>
        <span>Fed funds: <b>{marketContext?.institutionalSources?.macro?.fred?.DFF?.latest?.value ?? '—'}%</b></span>
        <span>Commercial-bank deposits: <b>{marketContext?.institutionalSources?.macro?.fred?.DPSACBW027SBOG?.latest?.value == null ? '—' : Number(marketContext.institutionalSources.macro.fred.DPSACBW027SBOG.latest.value).toLocaleString()}</b></span>
        <span>Retail Fear & Greed: <b>{marketContext?.institutionalSources?.retailSentiment?.value ?? '—'} {marketContext?.institutionalSources?.retailSentiment?.classification || ''}</b></span>
        <span>ECB USD per EUR: <b>{marketContext?.institutionalSources?.ecb?.latest?.value ?? '—'}</b></span>
      </div>
      <div className="market-context-evidence">{(marketContext?.institutionalSources?.news || []).slice(0,4).map((item,i)=><a key={i} href={item.url} target="_blank" rel="noreferrer">{item.title}</a>)}</div>
      {ci.result?.conflicts?.some(x => x.id === 'institutional-context-opposes') && <p className="quote-error">Independent institutional evidence conflicts with the active chart signal. Setup quality is reduced.</p>}
    </div>
    <div className="market-context-panel chain-dex-panel">
      <div className="market-context-heading"><b>BLOCKCHAIN & DEX TRANSACTION INTELLIGENCE</b><span>{marketContext?.chainDex?.status === 'ready' ? 'LIVE MULTI-CHAIN EVIDENCE' : 'AWAITING DEX DATA'}</span></div>
      {marketContext?.chainDex ? <>
        <div className="market-context-summary">
          <strong className={ci.result?.chainDex?.score > 0 ? 'up' : ci.result?.chainDex?.score < 0 ? 'down' : ''}>{ci.result?.chainDex?.status === 'ready' ? (ci.result.chainDex.score > 0 ? 'BUY PRESSURE' : ci.result.chainDex.score < 0 ? 'SELL PRESSURE' : 'BALANCED') : 'UNAVAILABLE'}</strong>
          <span>DEX evidence {ci.result?.chainDex?.score ?? '—'}</span><span>Confidence {ci.result?.chainDex?.confidence ?? '—'}</span>
          <span>Net swap flow {marketContext.chainDex.flow?.netUsd == null ? '—' : 'USD ' + Number(marketContext.chainDex.flow.netUsd).toLocaleString()}</span>
          <span>Pools {marketContext.chainDex.coverage?.pools ?? marketContext.chainDex.pools?.length ?? 0}</span>
          <span>Chains {marketContext.chainDex.coverage?.chains ?? '—'}</span>
          <span>Saved swaps {marketContext.chainDex.persistence?.count ?? 0}</span>
        </div>
        <div className="market-context-evidence">Token contract identity: <b>{ci.result?.chainDex?.identityVerified ? 'verified' : 'symbol match only · unverified'}</b>. Unverified pool matches have capped confidence.</div>
        <div className="market-context-sources">{(marketContext.chainDex.sources || []).map(source => <span key={source.name}><i className={source.status === 'live' ? 'source-live' : 'source-down'}/>{source.name}: {source.status}</span>)}</div>
        <div className="chain-dex-pools">{(marketContext.chainDex.pools || []).slice(0, 4).map(pool => <div key={pool.chainId + '|' + pool.pairAddress}><b>{pool.baseToken?.symbol}/{pool.quoteToken?.symbol}</b><span>{pool.chainId} · {pool.dexId}</span><span>Liquidity USD {Number(pool.liquidityUsd || 0).toLocaleString()}</span><span>24h volume USD {Number(pool.volume24hUsd || 0).toLocaleString()}</span>{pool.pairUrl && <a href={pool.pairUrl} target="_blank" rel="noreferrer">Pool details</a>}</div>)}</div>
        <div className="chain-dex-transactions"><b>Recent confirmed swaps / persisted history ({chainDexTrades.length})</b>
          {chainDexTrades.slice(0, 12).map(trade => <div key={trade.id} className="chain-dex-transaction"><span className={trade.side === 'buy' ? 'up' : 'down'}>{trade.side.toUpperCase()}</span><span>{trade.chainId} · USD {Number(trade.amountUsd || 0).toLocaleString()}</span><span>{trade.trader ? trade.trader.slice(0, 6) + '…' + trade.trader.slice(-4) : 'Wallet unavailable'}</span><time>{new Date(trade.timestamp).toLocaleTimeString()}</time>{transactionUrl(trade) && <a href={transactionUrl(trade)} target="_blank" rel="noreferrer">Tx</a>}</div>)}
        </div>
        {ci.result?.conflicts?.some(x => x.id === 'chain-dex-flow-opposes') && <p className="quote-error">Confirmed DEX swap flow opposes the active chart direction. Confluence and entry quality have been reduced.</p>}
        {(marketContext.chainDex.limitations || []).map((note,i)=><p key={i}>{note}</p>)}
      </> : <p>{contextError || 'Searching supported DEX pools and confirmed on-chain swaps…'}</p>}
    </div>
    <div className="market-context-panel session-forecast-panel">
      <div className="market-context-heading"><b>24-HOUR SESSION HIGH / LOW FORECAST</b><span>{sessionForecastBands.status === 'ready' ? 'HISTORICAL RANGE MODEL' : 'INSUFFICIENT HISTORY'}</span></div>
      <div className="market-context-summary"><span>Observed rolling 24h high: {observed24hLiquidity.levels?.high?.price == null ? '—' : fmt(observed24hLiquidity.levels.high.price)}</span><span>Observed rolling 24h low: {observed24hLiquidity.levels?.low?.price == null ? '—' : fmt(observed24hLiquidity.levels.low.price)}</span><span>Range position: {observed24hLiquidity.range?.positionPercent == null ? '—' : observed24hLiquidity.range.positionPercent.toFixed(1) + '%'}</span></div>
      <div className="session-forecast-grid">{(sessionForecastBands.sessions || []).map(session => <div key={session.id} className="session-forecast-card"><b>{session.name}</b><small>{session.phase} · {session.confidence} confidence · {session.historySamples} samples</small><span className="up">Forecast high: {session.forecast.high == null ? '—' : fmt(session.forecast.high)}</span><span className="down">Forecast low: {session.forecast.low == null ? '—' : fmt(session.forecast.low)}</span><small>Observed high / low: {session.observed.high == null ? '—' : fmt(session.observed.high)} / {session.observed.low == null ? '—' : fmt(session.observed.low)}</small></div>)}</div>
      <p>{sessionForecastBands.methodology || sessionForecastBands.reason}</p>
    </div>
    <div className="market-context-panel entry-assessment-panel">
      <div className="market-context-heading"><b>SMC ENTRY LOCATION & EXECUTION FILTER</b><span>{ci.result?.entryAssessment?.status?.replaceAll('-', ' ').toUpperCase() || 'WAITING FOR SIGNAL'}</span></div>
      {ci.result?.entryAssessment ? <>
        <div className="market-context-summary"><strong className={ci.result.entryAssessment.status === 'ready-for-review' ? 'up' : ci.result.entryAssessment.status === 'blocked-conflict' ? 'down' : ''}>{ci.result.entryAssessment.status.replaceAll('-', ' ').toUpperCase()}</strong><span>Setup checklist {ci.result.entryAssessment.qualityScore}/100</span><span>Direction {ci.result.entryAssessment.direction || '—'}</span><span>Current price {ci.result.entryAssessment.currentPrice == null ? '—' : fmt(ci.result.entryAssessment.currentPrice)}</span></div>
        {ci.result.entryAssessment.entryZone && <div className="market-context-evidence">Candidate zone: {fmt(ci.result.entryAssessment.entryZone.low)} – {fmt(ci.result.entryAssessment.entryZone.high)} · {ci.result.entryAssessment.entryZone.kind} · {ci.result.entryAssessment.inZone ? 'Price inside zone' : 'Awaiting retest'}</div>}
        <div className="market-context-evidence">Sweep {ci.result.entryAssessment.confirmations?.liquiditySweep ? '✓' : '—'} · Structure {ci.result.entryAssessment.confirmations?.structureBreak ? '✓' : '—'} · Displacement {ci.result.entryAssessment.confirmations?.displacement ? '✓' : '—'} · DEX flow {ci.result.entryAssessment.confirmations?.dexFlow ? '✓' : '—'} · Institutional {ci.result.entryAssessment.confirmations?.institutional ? '✓' : '—'}</div>
        <p>{ci.result.entryAssessment.trigger}</p><ul>{(ci.result.entryAssessment.reasons || []).map((reason,i)=><li key={i}>{reason}</li>)}</ul>
        <small>Invalidation: {ci.result.entryAssessment.invalidation == null ? 'Not established' : fmt(ci.result.entryAssessment.invalidation)} · {ci.result.entryAssessment.gradeNote}</small>
      </> : <p>Waiting for sufficient closed-candle structure and market evidence.</p>}
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
      <button type="button" onClick={tools.clearAll}>Clear drawings</button>
      <span>EMA 20 <i className="ema20-key"/> EMA 50 <i className="ema50-key"/> Bullish <i className="bull-key"/> Bearish <i className="bear-key"/></span>
    </div>
  </section>;
}
