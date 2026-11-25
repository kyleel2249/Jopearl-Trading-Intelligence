import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Columns2, Grid2X2, Layout, Save, SlidersHorizontal, Trash2 } from 'lucide-react';
import LiveCandlestickChart from './LiveCandlestickChart.jsx';

const EXCHANGES = ['bitget', 'binance', 'bybit', 'okx'];
const SYMBOLS = ['BTC/USDT','ETH/USDT','SOL/USDT','BNB/USDT','XRP/USDT','DOGE/USDT','ADA/USDT','AVAX/USDT','LINK/USDT','SOPH/USDT'];
const TIMEFRAMES = ['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M'];
const STORAGE_KEY = 'jpti.market-workstation.v1';
const makeTile = (index, mode) => ({ id: 'chart-' + index, exchange: index === 0 && mode === 'spot' ? 'binance' : 'bitget', symbol: index === 0 ? 'BTC/USDT' : ['ETH/USDT','SOL/USDT','BNB/USDT'][index % 3], timeframe: ['15m','1h','4h','1d'][index % 4], marketType: mode === 'futures' ? 'futures' : 'spot' });

function readSaved(mode) {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (raw?.tiles?.length) return { ...raw, mode };
  } catch {}
  return { layout: 2, height: 560, syncSymbol: false, syncTimeframe: false, tiles: [makeTile(0, mode), makeTile(1, mode)] };
}

export default function MultiChartWorkstation({ mode = 'spot', symbol = 'BTC/USDT', onSymbolChange, terminalFocus = false, dedicatedTerminal = false }) {
  const [config, setConfig] = useState(() => readSaved(mode));
  const [sharedCrosshair, setSharedCrosshair] = useState(null);
  const [crosshairSync, setCrosshairSync] = useState(true);
  const [savedAt, setSavedAt] = useState('');
  useEffect(() => { setConfig(current => ({ ...current, mode, tiles: current.tiles.map(tile => ({ ...tile, marketType: mode === 'futures' ? 'futures' : tile.marketType === 'futures' ? 'spot' : tile.marketType })) })); }, [mode]);
  useEffect(() => { if (symbol && config.tiles[0]?.symbol !== symbol) updateTile(config.tiles[0]?.id, 'symbol', symbol); }, [symbol]);
  const updateTile = useCallback((id, key, value) => setConfig(current => ({ ...current, tiles: current.tiles.map(tile => tile.id === id ? { ...tile, [key]: value } : tile) })), []);
  const visibleTiles = useMemo(() => config.tiles.slice(0, config.layout), [config.tiles, config.layout]);
  const setLayout = (layout) => setConfig(current => {
    const tiles = [...current.tiles];
    while (tiles.length < layout) tiles.push(makeTile(tiles.length, mode));
    return { ...current, layout, tiles };
  });
  const saveLayout = () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); setSavedAt(new Date().toLocaleTimeString()); }
    catch { setSavedAt('Storage unavailable'); }
  };
  const resetLayout = () => setConfig({ layout: 2, height: 560, syncSymbol: false, syncTimeframe: false, tiles: [makeTile(0, mode), makeTile(1, mode)] });
  const changeTile = (id, key, value) => {
    setConfig(current => {
      const source = current.tiles.find(tile => tile.id === id);
      if (!source) return current;
      const updates = current.syncSymbol && key === 'symbol' ? { symbol: value } : current.syncTimeframe && key === 'timeframe' ? { timeframe: value } : { [key]: value };
      return { ...current, tiles: current.tiles.map(tile => current.syncSymbol && key === 'symbol' || current.syncTimeframe && key === 'timeframe' ? { ...tile, ...updates } : tile.id === id ? { ...tile, ...updates } : tile) };
    });
    if (key === 'symbol' && id === config.tiles[0]?.id) onSymbolChange?.(value);
  };
  if (dedicatedTerminal) {
    const primary = config.tiles[0] || makeTile(0, mode);
    const quickMarkets = ['BTC/USDT','ETH/USDT','SOL/USDT','BNB/USDT','XRP/USDT','SOPH/USDT'];
    return <section className="jpti-multi-workstation jpti-dedicated-chart-terminal" aria-label="Full-screen market chart terminal">
      <header className="jpti-dedicated-terminal-toolbar">
        <div className="jpti-dedicated-terminal-market">
          <span className="jpti-terminal-live-indicator" />
          <div><b>{primary.symbol}</b><small>{primary.exchange.toUpperCase()} · {primary.timeframe.toUpperCase()} · {mode === 'futures' ? 'DERIVATIVES' : 'SPOT'}</small></div>
        </div>
        <div className="jpti-dedicated-terminal-actions">
          <label>VENUE<select value={primary.exchange} onChange={e => changeTile(primary.id, 'exchange', e.target.value)}>{EXCHANGES.map(x => <option key={x} value={x}>{x.toUpperCase()}</option>)}</select></label>
          <button type="button" onClick={saveLayout}><Save size={13}/> Save setup</button>
          <button type="button" onClick={() => { resetLayout(); setSavedAt(''); }}>Reset</button>
        </div>
      </header>
      <nav className="jpti-terminal-watchstrip" aria-label="Quick market watchlist">
        <span>QUICK MARKETS</span>
        {quickMarkets.map(item => <button type="button" key={item} className={primary.symbol === item ? 'active' : ''} onClick={() => changeTile(primary.id, 'symbol', item)}>{item}</button>)}
      </nav>
      <div className="jpti-dedicated-chart-stage">
        <LiveCandlestickChart terminalFocus exchange={primary.exchange} symbol={primary.symbol} onSymbolChange={value => changeTile(primary.id, 'symbol', value)} initialTimeframe={primary.timeframe} onTimeframeChange={value => changeTile(primary.id, 'timeframe', value)} initialMarketType={primary.marketType} onMarketTypeChange={value => changeTile(primary.id, 'marketType', value)} onExchangeChange={value => changeTile(primary.id, 'exchange', value)} />
      </div>
      <footer className="jpti-dedicated-terminal-foot"><span>ONE CHART · MAXIMUM WORKSPACE</span><span>Indicators, SMC structure, liquidity, signals and strategy overlays remain linked to the active candle feed</span><span>{savedAt ? 'SETUP SAVED ' + savedAt : 'LOCAL SETUP · SAVE TO KEEP'}</span></footer>
    </section>;
  }
  return <section className="jpti-multi-workstation">
    <header className="jpti-workstation-toolbar">
      <div className="jpti-workstation-title"><span className="jpti-workstation-icon"><Activity size={17}/></span><div><b>MARKET WORKSTATION</b><small>{mode === 'futures' ? 'DERIVATIVES MULTI-CHART' : 'SPOT MULTI-CHART'} · LIVE EXCHANGE FEEDS</small></div></div>
      <div className="jpti-workstation-actions">
        <div className="jpti-layout-picker" aria-label="Chart layout">
          <button className={config.layout === 1 ? 'active' : ''} onClick={() => setLayout(1)} title="Single chart"><Layout size={14}/>1</button>
          <button className={config.layout === 2 ? 'active' : ''} onClick={() => setLayout(2)} title="Two charts"><Columns2 size={14}/>2</button>
          <button className={config.layout === 4 ? 'active' : ''} onClick={() => setLayout(4)} title="Four charts"><Grid2X2 size={14}/>4</button>
        </div>
        <button className="jpti-workstation-save" onClick={saveLayout}><Save size={13}/> Save layout</button>
        <button className="jpti-workstation-reset" onClick={resetLayout}>Reset</button>
      </div>
    </header>
    <div className="jpti-workstation-controls">
      <label><input type="checkbox" checked={config.syncSymbol} onChange={e => setConfig(v => ({ ...v, syncSymbol: e.target.checked }))}/> Sync symbols</label>
      <label><input type="checkbox" checked={config.syncTimeframe} onChange={e => setConfig(v => ({ ...v, syncTimeframe: e.target.checked }))}/> Sync timeframes</label>
      <label><input type="checkbox" checked={crosshairSync} onChange={e => { setCrosshairSync(e.target.checked); if (!e.target.checked) setSharedCrosshair(null); }}/> Synchronized crosshair</label>
      <label className="jpti-chart-height"><SlidersHorizontal size={13}/> Panel height <input type="range" min="360" max="900" step="20" value={config.height} onChange={e => setConfig(v => ({ ...v, height: Number(e.target.value) }))}/><b>{config.height}px</b></label>
      {savedAt && <span className="jpti-saved-label">Saved {savedAt}</span>}
    </div>
    <div className={'jpti-chart-grid layout-' + config.layout} style={{ '--jpti-chart-height': config.height + 'px' }}>
      {visibleTiles.map((tile, index) => <article className="jpti-chart-tile" key={tile.id}>
        <header className="jpti-chart-tile-head">
          <div><span className="jpti-chart-number">0{index + 1}</span><b>{tile.symbol}</b><small>{tile.exchange.toUpperCase()} · {tile.timeframe.toUpperCase()}</small></div>
          <div className="jpti-chart-tile-controls">
            <select aria-label={'Exchange for chart ' + (index + 1)} value={tile.exchange} onChange={e => changeTile(tile.id, 'exchange', e.target.value)}>{EXCHANGES.map(x => <option key={x} value={x}>{x.toUpperCase()}</option>)}</select>
            <select aria-label={'Symbol for chart ' + (index + 1)} value={tile.symbol} onChange={e => changeTile(tile.id, 'symbol', e.target.value)}>{[...new Set([...SYMBOLS, tile.symbol])].map(x => <option key={x} value={x}>{x}</option>)}</select>
            <select aria-label={'Timeframe for chart ' + (index + 1)} value={tile.timeframe} onChange={e => changeTile(tile.id, 'timeframe', e.target.value)}>{TIMEFRAMES.map(x => <option key={x} value={x}>{x.toUpperCase()}</option>)}</select>
            <button title="Remove chart" disabled={config.layout === 1} onClick={() => setConfig(v => ({ ...v, tiles: v.tiles.filter(x => x.id !== tile.id) }))}><Trash2 size={12}/></button>
          </div>
        </header>
        <div className="jpti-chart-tile-body">
          <LiveCandlestickChart terminalFocus={terminalFocus} exchange={tile.exchange} symbol={tile.symbol} onSymbolChange={value => changeTile(tile.id, 'symbol', value)} initialTimeframe={tile.timeframe} onTimeframeChange={value => changeTile(tile.id, 'timeframe', value)} initialMarketType={tile.marketType} onMarketTypeChange={value => changeTile(tile.id, 'marketType', value)} onExchangeChange={value => changeTile(tile.id, 'exchange', value)} synchronizedCrosshair={crosshairSync ? sharedCrosshair : null} onCrosshairChange={value => { if (crosshairSync) setSharedCrosshair(value); }}/>
        </div>
      </article>)}
    </div>
    <footer className="jpti-workstation-foot"><span>{visibleTiles.length} active chart panel{visibleTiles.length === 1 ? '' : 's'} · each chart maintains its own market feed and indicators</span><span>Layout is saved on this device only when you select Save layout.</span></footer>
  </section>;
}
