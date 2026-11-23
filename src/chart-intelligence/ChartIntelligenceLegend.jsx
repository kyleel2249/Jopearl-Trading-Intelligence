import React, { useState } from 'react';
import './ChartIntelligence.css';

const NAMES = { signals: 'Signals', plan: 'Entry/TP/SL', liquidation: 'Liquidation', profile: 'POC/VA', vwap: 'VWAP', sr: 'S/R', orderflow: 'Order flow', structure: 'BOS/CHoCH', orderBlocks: 'Order blocks', fvg: 'FVG', liquidity: 'Liquidity', sweeps: 'Sweeps', smc: 'Prem/Disc' };
const SWATCH = { signals: '#20c997', plan: '#dbe7f5', liquidation: '#ff9f43', profile: '#e5b85c', vwap: '#38bdf8', sr: '#f07883', orderflow: '#b38aff', structure: '#60b8ff', orderBlocks: '#20c997', fvg: '#9b8cf5', liquidity: '#e5b85c', sweeps: '#f07883', smc: '#8392a8' };
const BASIS = { 'estimated-model': 'est.', 'ohlcv-estimate': 'est.', 'ohlcv-distributed': 'ohlcv', 'measured-feed': 'live', 'measured-aggressor': 'live' };

export default function ChartIntelligenceLegend({ ci, hook }) {
  const [open, setOpen] = useState(false);
  const { settings, update, alerts, clearAlerts, requestNotifications } = hook;
  const r = ci;
  if (!settings.enabled) return <div className="ci-legend ci-off"><button type="button" onClick={() => update({ enabled: true })}>Enable chart intelligence</button></div>;
  if (!r || r.status !== 'ready') return <div className="ci-legend"><b>CHART INTELLIGENCE</b> <span>{r ? (r.reason || 'Unavailable') : 'Waiting for candles…'}</span><button type="button" onClick={() => update({ enabled: false })}>Disable</button></div>;
  const prov = Object.fromEntries(r.provenance.map((p) => [p.layer, p]));
  const d = r.display, tone = d.state === 'BUY' ? 'up' : d.state === 'SELL' ? 'down' : d.state === 'CONFLICT' ? 'warn' : '';
  return <div className="ci-legend" data-ci-legend="ready">
    <div className="ci-head">
      <b>CHART INTELLIGENCE</b>
      <strong className={'ci-state ' + tone}>{d.state}{r.grade ? ' · ' + r.grade.grade : ''}</strong>
      <span>Confluence <b className={r.confluence.score > 0 ? 'up' : r.confluence.score < 0 ? 'down' : ''}>{r.confluence.score > 0 ? '+' : ''}{r.confluence.score}</b> ({r.confluence.agreeing}/{r.confluence.total})</span>
      <span>Regime <b>{r.regime.state}</b></span>
      {r.orderFlow && <span>Flow <b>{r.orderFlow.bias}</b> <i className="ci-basis">{BASIS[r.orderFlow.basis]}</i></span>}
      {r.liquidation.cascade && <span>Liq risk <b>{r.liquidation.cascade.level}</b> <i className="ci-basis">{BASIS[r.liquidation.basis]}</i></span>}
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide details' : 'Details'}</button>
      <button type="button" onClick={() => update({ enabled: false })}>Off</button>
    </div>
    <div className="ci-chips" role="group" aria-label="Chart intelligence layers">
      {Object.keys(NAMES).map((k) => <button key={k} type="button" aria-pressed={settings.layers[k]} className={'ci-chip' + (settings.layers[k] ? ' on' : '')} onClick={() => update({ layers: { [k]: !settings.layers[k] } })} title={(prov[k] ? prov[k].methods.join(', ') : '') || NAMES[k]}><i style={{ background: SWATCH[k] }} />{NAMES[k]} <small>{(prov[k] && prov[k].count) || 0}</small>{prov[k] && prov[k].bases.some((b) => BASIS[b] === 'est.') && <em>est.</em>}</button>)}
    </div>
    {r.conflicts.length > 0 && <ul className="ci-conflicts">{r.conflicts.map((c) => <li key={c.id}>⚠ {c.detail}</li>)}</ul>}
    {r.plan && <div className="ci-plan">Plan: entry {r.plan.entry} · SL {r.plan.stopLoss} ({r.plan.riskAtr} ATR) · {r.plan.targets.map((t) => t.name + ' ' + t.price + ' (' + t.rr + 'R' + (t.hit ? ' ✓' : '') + ')').join(' · ')}{r.plan.rrOptimized ? ' · best R:R ' + r.plan.rrOptimized.name : ''}</div>}
    {alerts.length > 0 && <div className="ci-alerts"><b>Alerts</b> <button type="button" onClick={clearAlerts}>Clear</button><ul>{alerts.slice(0, 4).map((a) => <li key={a.id} className={a.severity}>{a.message}</li>)}</ul></div>}
    {open && <div className="ci-details">
      <div className="ci-grid">{r.confluence.components.map((c) => <div key={c.key} className={c.available ? '' : 'na'}><small>{c.key}</small><b className={c.value > 0 ? 'up' : c.value < 0 ? 'down' : ''}>{c.available ? c.value : 'n/a'}</b></div>)}</div>
      <p>MTF: {r.mtf.length ? r.mtf.map((m) => m.timeframe + ' ' + (m.status === 'fresh' ? m.bias : m.status)).join(' · ') : 'unavailable'}. Min score {r.confluence.minScore} (adaptive, {r.regime.state}). ATR {r.atr}. Expectancy: {r.expectancy && r.expectancy.reliable ? r.expectancy.expectancy + 'R over ' + r.expectancy.n + ' outcomes' : 'sample too small'}.</p>
      <p className="ci-basis-note">Data basis — {r.provenance.filter((p) => p.count).map((p) => NAMES[p.layer] + ': ' + p.bases.join('/')).join(' · ')}. “est.” layers are modelled from OHLCV, not exchange tick or liquidation data.</p>
      <div className="ci-controls">
        <label>Label density <select value={settings.density} onChange={(e) => update({ density: e.target.value })}><option value="auto">Auto</option><option value="full">Full</option><option value="minimal">Minimal</option></select></label>
        <label><input type="checkbox" checked={settings.alerts.notify} onChange={(e) => (e.target.checked ? requestNotifications() : update({ alerts: { notify: false } }))} /> Browser alerts</label>
        <button type="button" onClick={() => hook.reset()}>Reset layers</button>
      </div>
    </div>}
  </div>;
}
