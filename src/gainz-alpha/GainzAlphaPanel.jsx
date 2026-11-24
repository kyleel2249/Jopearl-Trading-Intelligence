import React, { useState } from 'react';
import { PRESETS } from './presets.js';
import { MIN_SAMPLE } from './learning.js';

const box = { padding: '8px 10px', background: '#18263a', borderRadius: 8, minWidth: 0 };
const small = { fontSize: 10, color: '#93a6bd' };
const fmt = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 8 }));
const sigColor = (s) => (s === 'BUY' ? '#20c997' : s === 'SELL' ? '#f07883' : s === 'INVALIDATED' ? '#e5b85c' : '#9bb1ca');
const OVERLAYS = [['liquidity', 'Liquidity'], ['equalLevels', 'Equal H/L'], ['setup', 'Setup markers'], ['fvg', 'FVG'], ['signal', 'Signal'], ['risk', 'Risk lines'], ['structure', 'BOS / CHoCH']];

export default function GainzAlphaPanel({ ga, symbol, timeframe, candleCount, overlaysLoaded }) {
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState(true);
  const [diag, setDiag] = useState(null);
  const [transfer, setTransfer] = useState('');
  const [learningRevision, setLearningRevision] = useState(0);
  const { settings, update, reset, hub } = ga;
  const data = ga.result;
  const c = data && data.confirmed, p = data && data.preview && data.preview.status === 'ready' ? data.preview : null;
  const ready = c && c.status === 'ready';
  const ex = ready ? c.setupExpectancy : null, all = ready ? c.expectancy : null, rp = ready ? c.riskPlan : null;
  const status = hub.status();
  const learningState = hub.getState();
  const learningModel = learningState.model || {};
  const learningCount = learningState.outcomes?.length || 0;
  const age = ready && c.setup ? c.setup.ageBars : null;
  const runDiag = () => setDiag(ga.diagnose({ candleCount, timeframe, symbol, lastCandleTs: ready ? c.asOf : null, now: Date.now(), alphaConsumer: true, overlaysLoaded, status, state: hub.getState() }));
  const num = (key, label, min, max, step) => <label style={{ ...small, display: 'flex', flexDirection: 'column', gap: 2 }}>{label}<input aria-label={label} type="number" min={min} max={max} step={step} value={(settings.overrides[key] ?? '')} placeholder={String(PRESETS[settings.preset][key])} onChange={(e) => update({ overrides: { ...settings.overrides, [key]: e.target.value === '' ? undefined : Number(e.target.value) } })} style={{ width: 84 }} /></label>;
  const flag = (key, label) => <label style={{ ...small, display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={settings.overrides[key] ?? PRESETS[settings.preset][key]} onChange={(e) => update({ overrides: { ...settings.overrides, [key]: e.target.checked } })} />{label}</label>;

  return <section aria-label="GainzAlpha intelligence" style={{ margin: '12px 0', padding: 12, border: '1px solid #2b4263', borderRadius: 12, background: '#0f1a2c', color: '#dbe7f5' }}>
    <header style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
      <span><b>GAINZALPHA INTELLIGENCE</b><span style={{ ...small, marginLeft: 8 }}>{symbol} · {timeframe} · preset {settings.preset} · {ready ? c.modelVersion : 'waiting'}</span></span>
      <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <label style={small}><input type="checkbox" checked={settings.enabled} onChange={(e) => update({ enabled: e.target.checked })} /> enabled</label>
        <button type="button" onClick={() => setOpen(!open)}>{open ? 'Hide settings' : 'Settings'}</button>
        <button type="button" onClick={runDiag}>Diagnostics</button>
      </span>
    </header>
    {!settings.enabled && <p style={small}>GainzAlpha is disabled for all charts.</p>}
    {settings.enabled && !ready && <p style={small}>{data && data.error ? 'Engine error: ' + data.error : c && c.reason ? c.reason : 'Waiting for candle data…'}</p>}
    {ready && <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 8, marginTop: 10 }}>
        <div style={box}><small style={small}>SIGNAL · CLOSED CANDLE</small><div style={{ fontSize: 20, fontWeight: 800, color: sigColor(c.signal) }}>{c.signal}</div><small style={small}>confidence {c.confidence} · strength {c.strength}</small></div>
        <div style={box}><small style={small}>SETUP</small><div style={{ fontWeight: 700 }}>{c.stage}</div><small style={small}>quality {c.setupQuality} · {c.signalKind || c.setup?.type || 'none'}{age != null ? ' · age ' + age + ' bars' : ''}</small></div>
        <div style={box}><small style={small}>CONFLUENCE</small><div style={{ fontWeight: 700 }}>{c.confluence.count}/{c.confluence.required}</div><small style={small}>agreement {Math.round(c.directionalAgreement * 100)}%</small></div>
        <div style={box}><small style={small}>REGIME · SESSION</small><div style={{ fontWeight: 700 }}>{c.market.regime} · {c.market.volRegime} vol</div><small style={small}>{c.market.session}</small></div>
        <div style={box}><small style={small}>EXPECTANCY (n={ex ? ex.n : 0})</small><div style={{ fontWeight: 700 }}>{ex && ex.reliable ? ex.expectancy + ' R' : 'insufficient'}</div><small style={small}>win {ex && ex.winRate != null ? Math.round(ex.winRate * 100) + '% [' + Math.round(ex.winRateLow * 100) + '–' + Math.round(ex.winRateHigh * 100) + ']' : '—'} · false {all && all.falseRate != null ? Math.round(all.falseRate * 100) + '%' : '—'} (n={all ? all.n : 0})</small></div>
        <div style={box}><small style={small}>HIGHER TIMEFRAMES</small><div style={{ fontWeight: 700 }}>{c.htf.length ? c.htf.map((h) => h.timeframe + ' ' + (h.status === 'fresh' ? (h.bias > 0.2 ? '▲' : h.bias < -0.2 ? '▼' : '◆') : h.status)).join(' · ') : 'not configured'}</div></div>
      </div>
      {rp && <div style={{ ...box, marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <span>Entry <b>{fmt(rp.entry)}</b></span><span>Stop <b style={{ color: '#f07883' }}>{fmt(rp.stopLoss)}</b></span><span>TP1 <b style={{ color: '#20c997' }}>{fmt(rp.takeProfit1)}</b> ({rp.tp1Source})</span><span>TP2 <b style={{ color: '#20c997' }}>{fmt(rp.takeProfit2)}</b></span>{rp.takeProfit3 != null && <span>TP3 <b>{fmt(rp.takeProfit3)}</b></span>}<span>R:R <b>{rp.rr1}</b></span><span>Invalidation <b>{fmt(rp.invalidation)}</b></span>
      </div>}
      {p && <div style={{ ...box, marginTop: 8, border: '1px dashed #5b7396' }}><b>PREVIEW (provisional, forming candle)</b> <span style={{ color: sigColor(p.signal), fontWeight: 800 }}>{p.signal}</span> <small style={small}>confidence {p.confidence}. Not confirmed, never recorded, may change until the candle closes.</small></div>}
      <button type="button" onClick={() => setWhy(!why)} style={{ marginTop: 8 }}>{why ? '▾' : '▸'} Why this signal?</button>
      {why && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 8, marginTop: 6 }}>
        <ul style={{ margin: 0, paddingLeft: 16, color: '#8fe3c4', fontSize: 11 }}>{c.explanation.positives.length ? c.explanation.positives.map((t, i) => <li key={i}>{t}</li>) : <li style={{ color: '#93a6bd' }}>No supporting factors yet</li>}</ul>
        <ul style={{ margin: 0, paddingLeft: 16, color: '#f3a2a9', fontSize: 11 }}>{c.explanation.negatives.length ? c.explanation.negatives.map((t, i) => <li key={i}>{t}</li>) : <li style={{ color: '#93a6bd' }}>No negative factors</li>}</ul>
      </div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8, fontSize: 10 }}>{c.factors.map((f) => <span key={f.key} title={'weight ' + f.weight} style={{ padding: '3px 6px', background: '#202f45', borderRadius: 5 }}>{f.key} {f.value > 0 ? '+' : ''}{f.value} → {f.contribution > 0 ? '+' : ''}{f.contribution}</span>)}</div>
      <small style={{ display: 'block', marginTop: 6, color: '#8297b0' }}>{c.confidenceNote}. {c.method}</small>
    </>}
    <section aria-label="Adaptive learning status" style={{ ...box, marginTop: 10, border: '1px solid #304765' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div><b>ADAPTIVE STRATEGY LEARNING</b><div style={small}>Model v{learningModel.version || 1} · {learningCount}/{MIN_SAMPLE} outcomes for minimum learning sample</div></div>
        <span style={{ color: learningModel.drift?.drifting ? '#f3b85b' : '#8fe3c4', fontSize: 11 }}>{learningModel.drift?.drifting ? 'Performance drift flagged' : 'No material drift flag'}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 7, fontSize: 11 }}>
        <span>Adaptive mode <b>{settings.adaptiveLearning ? 'ON' : 'OFF'}</b></span><span>Recorded outcomes <b>{learningCount}</b></span><span>Learned factors <b>{Object.keys(learningModel.weights || {}).length}</b></span><span>Previous versions <b>{learningModel.history?.length || 0}</b></span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        {Object.entries(learningModel.weights || {}).map(([key, value]) => <span key={key} style={{ padding: '3px 6px', background: '#202f45', borderRadius: 5 }}>{key}: {Number(value).toFixed(3)}×</span>)}
        <button type="button" disabled={!learningModel.history?.length} onClick={() => { const result = hub.rollbackModel(); if (result.rolledBack) setLearningRevision(result.model.version); }}>Rollback last model update</button>
        <small style={small}>Revision {learningRevision || learningModel.version || 1}. Learning does not place trades.</small>
      </div>
    </section>
    {!status.persistence.ok && <p style={{ ...small, color: '#e5b85c' }}>Storage notice: {status.persistence.error}. Learning data may not survive a refresh.</p>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 8 }} aria-label="Overlay toggles">{OVERLAYS.map(([k, l]) => <label key={k} style={{ ...small, display: 'flex', gap: 4 }}><input type="checkbox" checked={!!settings.overlays[k]} onChange={(e) => update({ overlays: { [k]: e.target.checked } })} />{l}</label>)}</div>
    {open && <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #26384f' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
        <label style={{ ...small, display: 'flex', flexDirection: 'column', gap: 2 }}>Preset<select aria-label="Preset" value={settings.preset} onChange={(e) => update({ preset: e.target.value, overrides: {} })}>{Object.values(PRESETS).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
        {num('minScore', 'Min score', 0.05, 1, 0.05)}{num('minConfidence', 'Min confidence', 0, 95, 1)}{num('minConfluence', 'Min confluence', 1, 8, 1)}{num('minRR', 'Min R:R', 0.5, 6, 0.1)}{num('cooldownBars', 'Cooldown bars', 0, 50, 1)}{num('expireBars', 'Setup expiry bars', 2, 60, 1)}
        {flag('requireTrend', 'Trend required')}{flag('requireMomentum', 'Momentum required')}{flag('requireVolume', 'Volume required')}{flag('requireSweep', 'Sweep required')}{flag('requireDisplacement', 'Displacement required')}{flag('requireHtf', 'Higher-TF alignment')}{flag('requirePositiveExpectancy', 'Positive expectancy only')}
        <label style={small}><input type="checkbox" checked={settings.intrabarPreview} onChange={(e) => update({ intrabarPreview: e.target.checked })} /> Intrabar preview</label>
        <label style={small}><input type="checkbox" checked={settings.adaptiveLearning} onChange={(e) => update({ adaptiveLearning: e.target.checked })} /> Adaptive learning</label>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
        <button type="button" onClick={reset}>Reset to defaults</button>
        <button type="button" onClick={() => setTransfer(hub.exportSettings())}>Export settings</button>
        <button type="button" onClick={() => { const r = hub.importSettings(transfer); if (r.ok) update({}); else setTransfer('Import failed: ' + r.error); }}>Import settings</button>
        <button type="button" onClick={() => { const n = window.prompt('Profile name'); if (n) { hub.saveProfile(n); update({}); } }}>Save profile</button>
        {Object.keys(settings.profiles).map((n) => <button type="button" key={n} onClick={() => { hub.loadProfile(n); update({}); }}>Load “{n}”</button>)}
        <button type="button" onClick={() => { const r = hub.rollbackModel(); setTransfer(r.rolledBack ? 'Model rolled back to v' + r.restoredFrom : 'No earlier model version to roll back to'); update({}); }}>Roll back learning</button>
      </div>
      <textarea aria-label="Settings import/export" value={transfer} onChange={(e) => setTransfer(e.target.value)} rows={2} style={{ width: '100%', marginTop: 6 }} placeholder="Exported settings JSON appears here; paste to import" />
    </div>}
    {diag && <div style={{ marginTop: 10, fontSize: 11 }}><b>Diagnostics: {diag.overall}</b>{diag.failed.length > 0 && <span style={{ color: '#e5b85c' }}> — failing: {diag.failed.join(', ')}</span>}
      <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>{diag.checks.map((k) => <li key={k.id} style={{ color: k.ok ? '#8fe3c4' : '#f3a2a9' }}>{k.ok ? '✓' : '✗'} {k.id}: {k.detail}</li>)}</ul></div>}
  </section>;
}
