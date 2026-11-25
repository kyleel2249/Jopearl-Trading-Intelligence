import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LiveCandlestickChart from './LiveCandlestickChart.jsx';
import { apiFetch, getApiSource } from './lib/api.js';
import { PRODUCTS, productLabel, buildSearchIndex, searchMarkets, resolveSymbol } from './lib/bitget-search.js';
import { fetchProductCatalog } from './lib/bitget-instruments.js';
import { fetchDerivativesSnapshot, FUTURES_PRODUCTS } from './lib/bitget-derivatives.js';
import { evaluateFuturesRisk, DEFAULT_LIMITS } from './lib/futures-risk.js';
import { MAX_PANELS, STORAGE_KEY, defaultStore, parseStore, serializeStore, saveLayout, deleteLayout, presetPanels, addPanel, removePanel, updatePanel } from './lib/workbench-layout.js';

const n = (value, digits = 2) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString(undefined, { maximumFractionDigits: digits }));
const pct = (value, digits = 4) => (value === null || value === undefined ? '—' : (value * 100).toFixed(digits) + '%');

function DerivativesPanel({ panel, instrumentId, onSnapshot }) {
  const [snap, setSnap] = useState(null);
  const futures = panel.exchange === 'bitget' && FUTURES_PRODUCTS.has(panel.product);
  useEffect(() => {
    if (!futures) { setSnap(null); return undefined; }
    let active = true;
    const run = async () => { const result = await fetchDerivativesSnapshot({ product: panel.product, pair: panel.symbol, instrumentId }); if (active) { setSnap(result); onSnapshot(panel.id, result); } };
    run();
    const timer = setInterval(run, 30000);
    return () => { active = false; clearInterval(timer); };
  }, [futures, panel.product, panel.symbol, instrumentId, panel.id, onSnapshot]);
  if (!futures) return <p className="wb-note">Funding, open interest and basis apply to Bitget futures products. Select a futures product to see them.</p>;
  if (!snap) return <p className="wb-note">Loading derivatives data…</p>;
  if (!snap.ok) return <p className="wb-note wb-warn">{snap.reason || 'Derivatives data is unavailable.'} {Object.entries(snap.errors || {}).map(([k, v]) => k + ': ' + v).join(' · ')}</p>;
  const f = snap.funding, b = snap.basis;
  return <div className="wb-deriv" aria-label="Derivatives data">
    <div><small>MARK</small><b>{n(snap.prices.mark, 6)}</b></div>
    <div><small>INDEX</small><b>{n(snap.prices.index, 6)}</b></div>
    <div><small>FUNDING</small><b className={f.rate > 0 ? 'wb-up' : f.rate < 0 ? 'wb-down' : ''}>{pct(f.rate)}</b><span>{f.intervalHours ? 'every ' + f.intervalHours + 'h' : 'interval unknown'}</span></div>
    <div><small>ANNUALISED</small><b>{pct(f.annualized, 1)}</b>{f.annualizedAssumesEightHours && f.rate !== null && <span>assumes 8h</span>}</div>
    <div><small>OPEN INTEREST</small><b>{n(snap.openInterest, 2)}</b></div>
    <div><small>BASIS vs {snap.prices.spotSymbol || 'spot'}</small><b className={b && b.pct > 0 ? 'wb-up' : b && b.pct < 0 ? 'wb-down' : ''}>{b ? b.pct.toFixed(3) + '%' : '—'}</b>{b && <span>{n(b.absolute, 4)}</span>}</div>
    <small className="wb-foot">Bitget public API · {new Date(snap.fetchedAt).toLocaleTimeString()}{Object.keys(snap.errors || {}).length ? ' · partial: ' + Object.keys(snap.errors).join(', ') + ' unavailable' : ''}</small>
  </div>;
}

function RiskPanel({ panel, lastPrice }) {
  const [form, setForm] = useState({ side: 'long', entry: '', stop: '', target: '', equity: '10000', riskPercent: '1', leverage: '5', takerFeeBps: '6', maintenanceMarginPercent: '0.5', maxLeverage: String(DEFAULT_LIMITS.maxLeverage) });
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const result = useMemo(() => evaluateFuturesRisk({ product: panel.product, side: form.side, entry: form.entry, stop: form.stop, target: form.target, equity: form.equity, riskPercent: form.riskPercent, leverage: form.leverage, takerFeeBps: form.takerFeeBps, maintenanceMarginRate: Number(form.maintenanceMarginPercent) / 100, limits: { maxLeverage: Number(form.maxLeverage) || DEFAULT_LIMITS.maxLeverage } }), [panel.product, form]);
  const entered = form.entry !== '' && form.stop !== '';
  const unit = panel.product === 'coin-futures' ? 'in margin coin' : 'in quote currency';
  return <section className="wb-card" aria-label="Product-aware risk gate">
    <div className="wb-head"><b>RISK GATE</b><small>{productLabel(panel.product)} · {panel.symbol}</small></div>
    <div className="wb-form">
      <label>Side<select value={form.side} onChange={set('side')}><option value="long">Long</option><option value="short">Short</option></select></label>
      <label>Entry<input inputMode="decimal" value={form.entry} onChange={set('entry')} placeholder="price"/></label>
      <label>Stop<input inputMode="decimal" value={form.stop} onChange={set('stop')} placeholder="price"/></label>
      <label>Target<input inputMode="decimal" value={form.target} onChange={set('target')} placeholder="optional"/></label>
      <label>Equity <small>{unit}</small><input inputMode="decimal" value={form.equity} onChange={set('equity')}/></label>
      <label>Risk %<input inputMode="decimal" value={form.riskPercent} onChange={set('riskPercent')}/></label>
      <label>Leverage<input inputMode="decimal" value={form.leverage} onChange={set('leverage')} disabled={panel.product === 'spot'}/></label>
      <label>Fee bps<input inputMode="decimal" value={form.takerFeeBps} onChange={set('takerFeeBps')}/></label>
      <label>Maint. margin %<input inputMode="decimal" value={form.maintenanceMarginPercent} onChange={set('maintenanceMarginPercent')}/></label>
      <label>Max leverage<input inputMode="decimal" value={form.maxLeverage} onChange={set('maxLeverage')}/></label>
    </div>
    {lastPrice ? <button type="button" className="wb-btn" onClick={() => setForm((current) => ({ ...current, entry: String(lastPrice) }))}>Use last price {n(lastPrice, 6)}</button> : null}
    {!entered ? <p className="wb-note">Enter an entry and a stop to size the trade.</p> : result.decision === 'unsupported' ? <p className="wb-note wb-warn">{result.reason}</p> :
      <div className="wb-result" role="status">
        <div className={'wb-verdict wb-' + result.decision}>{result.decision === 'eligible' ? 'WITHIN LIMITS' : 'BLOCKED'}</div>
        {result.sizing && <div className="wb-deriv">
          <div><small>RISK AMOUNT</small><b>{n(result.sizing.riskAmount, 4)}</b></div>
          <div><small>SIZE ({result.sizing.quantityUnit})</small><b>{n(result.sizing.quantity, 6)}</b></div>
          <div><small>NOTIONAL</small><b>{n(result.sizing.notional, 2)}</b></div>
          <div><small>INITIAL MARGIN</small><b>{n(result.sizing.initialMargin, 4)}</b><span>{n(result.sizing.marginUtilizationPercent, 1)}% of equity</span></div>
          {result.liquidation && <div><small>EST. LIQUIDATION</small><b>{result.liquidation.price === null ? '—' : n(result.liquidation.price, 6)}</b>{result.liquidation.bufferRatio !== undefined && <span>{result.liquidation.bufferRatio.toFixed(2)}× stop distance</span>}</div>}
          {result.liquidation?.safeMaxLeverage !== undefined && <div><small>SAFE MAX LEVERAGE</small><b>{result.liquidation.safeMaxLeverage === null ? 'none' : result.liquidation.safeMaxLeverage + '×'}</b></div>}
          {result.rewardRisk ? <div><small>REWARD : RISK</small><b>{result.rewardRisk.toFixed(2)} : 1</b></div> : null}
        </div>}
        <ul className="wb-checks">{result.checks.map((c) => <li key={c.id} className={c.passed ? 'wb-pass' : 'wb-fail'}><b>{c.passed ? 'PASS' : 'FAIL'}</b> {c.detail}</li>)}</ul>
        {result.liquidation?.note && <p className="wb-note">{result.liquidation.note}</p>}
        <small className="wb-foot">{result.assumptions.join(' ')} Analysis only; this does not place or authorize an order.</small>
      </div>}
  </section>;
}

export default function BitgetWorkbench() {
  const [store, setStore] = useState(() => { try { return parseStore(localStorage.getItem(STORAGE_KEY)); } catch { return defaultStore(); } });
  const [panels, setPanels] = useState(() => store.layouts[store.active].panels);
  const [activeId, setActiveId] = useState(() => store.layouts[store.active].panels[0].id);
  const [catalogs, setCatalogs] = useState({});
  const [catalogErrors, setCatalogErrors] = useState({});
  const [query, setQuery] = useState('');
  const [layoutName, setLayoutName] = useState('');
  const [message, setMessage] = useState('');
  const [snapshots, setSnapshots] = useState({});
  const resolved = useRef(new Set());

  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, serializeStore(store)); } catch { /* storage may be unavailable */ } }, [store]);
  useEffect(() => {
    let active = true;
    const cloudflare = getApiSource().mode === 'cloudflare-edge';
    PRODUCTS.filter((p) => p.id !== 'cfd' || cloudflare).forEach(async ({ id }) => {
      try { const { markets } = await fetchProductCatalog(apiFetch, id); if (active) setCatalogs((current) => ({ ...current, [id]: markets })); }
      catch (error) { if (active) setCatalogErrors((current) => ({ ...current, [id]: error.message })); }
    });
    return () => { active = false; };
  }, []);

  const index = useMemo(() => buildSearchIndex(catalogs), [catalogs]);
  const results = useMemo(() => (query.trim().length >= 2 ? searchMarkets(index, query, { limit: 12 }) : []), [index, query]);

  const patchPanel = useCallback((id, patch) => setPanels((prev) => {
    const current = prev.find((panel) => panel.id === id);
    if (!current || Object.entries(patch).every(([key, value]) => current[key] === value)) return prev;
    return updatePanel(prev, id, patch);
  }), []);

  // Map the loose default pair (BTC/USDT) onto each product's exact listed symbol once its catalogue arrives.
  useEffect(() => {
    if (!index.length) return;
    panels.forEach((panel) => {
      const mark = panel.id + '|' + panel.product + '|' + panel.symbol;
      if (resolved.current.has(mark)) return;
      resolved.current.add(mark);
      const exact = resolveSymbol(index, panel.product, panel.symbol);
      if (exact && exact !== panel.symbol) setPanels((prev) => { const cur = prev.find((p) => p.id === panel.id); return cur ? updatePanel(prev, panel.id, { symbol: exact, nonce: cur.nonce + 1 }) : prev; });
    });
  }, [index, panels]);

  const ids = panels.map((p) => p.id).join('|');
  const handlers = useMemo(() => Object.fromEntries(panels.map((p) => [p.id, {
    onSymbolChange: (symbol) => patchPanel(p.id, { symbol }),
    onMarketTypeChange: (product) => patchPanel(p.id, { product }),
    onTimeframeChange: (timeframe) => patchPanel(p.id, { timeframe }),
    onMarketSideChange: (side) => patchPanel(p.id, { side })
  }])), [ids, patchPanel]); // eslint-disable-line react-hooks/exhaustive-deps
  const onSnapshot = useCallback((id, snap) => setSnapshots((current) => ({ ...current, [id]: snap })), []);

  const applyResult = (entry) => { setPanels((prev) => { const cur = prev.find((p) => p.id === activeId) || prev[0]; return updatePanel(prev, cur.id, { product: entry.product, symbol: entry.symbol, nonce: cur.nonce + 1 }); }); resolved.current.add(activeId + '|' + entry.product + '|' + entry.symbol); setQuery(''); };
  const active = panels.find((p) => p.id === activeId) || panels[0];
  const instrumentFor = (panel) => index.find((e) => e.product === panel.product && e.symbol === panel.symbol)?.id || '';
  const loadLayout = (name) => { const layout = store.layouts[name]; if (!layout) return; setStore((s) => ({ ...s, active: name })); setPanels(layout.panels); setActiveId(layout.panels[0].id); setMessage('Loaded "' + name + '".'); };
  const doSave = () => { const { store: next, error } = saveLayout(store, layoutName || store.active, panels); if (error) { setMessage(error); return; } setStore(next); setMessage('Saved "' + next.active + '".'); setLayoutName(''); };
  const doDelete = () => { const next = deleteLayout(store, store.active); if (next === store) { setMessage('At least one layout must remain.'); return; } setStore(next); setPanels(next.layouts[next.active].panels); setActiveId(next.layouts[next.active].panels[0].id); setMessage('Deleted layout.'); };
  const preset = (count) => { const next = presetPanels(count, active); setPanels(next); setActiveId(next[0].id); };
  const failed = Object.keys(catalogErrors);

  return <div className="wb-root">
    <section className="wb-card wb-toolbar" aria-label="Workbench controls">
      <div className="wb-search">
        <label htmlFor="wb-search">Search all Bitget products</label>
        <input id="wb-search" type="search" autoComplete="off" placeholder="e.g. btc perp, eth spot, xau cfd, BTCUSDT" value={query} onChange={(e) => setQuery(e.target.value)} />
        {results.length > 0 && <ul className="wb-results" role="listbox" aria-label="Search results">{results.map((r) => <li key={r.product + r.symbol}><button type="button" role="option" aria-selected="false" onClick={() => applyResult(r)}><b>{r.symbol}</b><span>{productLabel(r.product)}</span></button></li>)}</ul>}
        {query.trim().length >= 2 && results.length === 0 && <small className="wb-note">{index.length ? 'No market matches.' : 'Catalogues are still loading or unavailable.'}</small>}
        <small className="wb-note">A result opens in the highlighted chart ({productLabel(active.product)} · {active.symbol}).</small>
      </div>
      <div className="wb-layouts">
        <label>Layout<select value={store.active} onChange={(e) => loadLayout(e.target.value)}>{Object.keys(store.layouts).map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
        <input aria-label="Layout name" placeholder="Save as…" value={layoutName} maxLength={40} onChange={(e) => setLayoutName(e.target.value)} />
        <button type="button" className="wb-btn" onClick={doSave}>Save</button>
        <button type="button" className="wb-btn" onClick={doDelete}>Delete</button>
        <span className="wb-sep" />
        {[1, 2, 4].map((count) => <button key={count} type="button" className="wb-btn" onClick={() => preset(count)}>{count} chart{count > 1 ? 's' : ''}</button>)}
        <button type="button" className="wb-btn" disabled={panels.length >= MAX_PANELS} onClick={() => setPanels((prev) => addPanel(prev))}>＋ Add chart</button>
      </div>
      {message && <small className="wb-note" role="status">{message}</small>}
      {failed.length > 0 && <small className="wb-note wb-warn">Catalogue unavailable for: {failed.map(productLabel).join(', ')}. {failed.includes('cfd') ? '' : 'Check the API connection.'}</small>}
      {panels.length > 2 && <small className="wb-note">Each chart polls live data and runs its own analytics; four charts use noticeably more bandwidth and CPU.</small>}
    </section>
    <div className={'wb-grid wb-cols-' + Math.min(panels.length, 2)}>
      {panels.map((panel) => <article key={panel.id} className={'wb-panel' + (panel.id === active.id ? ' wb-active' : '')} onClickCapture={() => setActiveId(panel.id)} aria-label={'Chart ' + panel.id}>
        <div className="wb-head wb-panel-head"><b>{panel.symbol}</b><span>{productLabel(panel.product)} · {panel.timeframe}</span>{panels.length > 1 && <button type="button" className="wb-x" aria-label={'Remove chart ' + panel.id} onClick={(e) => { e.stopPropagation(); setPanels((prev) => removePanel(prev, panel.id)); if (activeId === panel.id) setActiveId(panels.find((p) => p.id !== panel.id).id); }}>×</button>}</div>
        <LiveCandlestickChart key={panel.id + ':' + panel.nonce} exchange={panel.exchange} symbol={panel.symbol} initialMarketType={panel.product} initialTimeframe={panel.timeframe} {...handlers[panel.id]} />
        <DerivativesPanel panel={panel} instrumentId={instrumentFor(panel)} onSnapshot={onSnapshot} />
      </article>)}
    </div>
    <RiskPanel key={active.product} panel={active} lastPrice={snapshots[active.id]?.prices?.last ?? null} />
  </div>;
}
