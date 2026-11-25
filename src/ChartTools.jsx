import React, { useId, useMemo } from 'react';
import './ChartTools.css';
import { formatCountdown, timeframeMs } from './chart-live.js';
import { fibLevels, indexToTime, measureBetween, riskReward, timeToIndex } from './chart-tools.js';
import { buildRangeProfile, SCALE_MODES } from './chart-scale.js';
import { bucketDepth, fundingLabel, higherTimeframe } from './chart-market.js';
import { REPLAY_SPEEDS } from './chart-tools.js';

const UP = '#22c58b', DOWN = '#ef5361', AMBER = '#e5b85c', VIOLET = '#a78bfa', SKY = '#38bdf8';
const FONT = 'DM Sans, sans-serif';
const SCALE_LABEL = { linear: 'Linear', log: 'Log', percent: '% from last' };

/**
 * Map a pointer event on the chart SVG to a (timestamp, price) point using the chart's geometry.
 * geo = { left, right, top, bottom, slot, rows, pip, priceAt(py) }. Prices snap to the pip.
 */
export function pointFromEvent(event, geo, timeframe) {
  const el = event.currentTarget;
  const svg = el.ownerSVGElement || el;
  const box = svg.getBoundingClientRect();
  const px = event.clientX - box.left, py = event.clientY - box.top;
  const cy = Math.max(geo.top, Math.min(geo.bottom, py));
  const raw = geo.priceAt(cy);
  const price = geo.pip > 0 ? Number((Math.round(raw / geo.pip) * geo.pip).toFixed(12)) : raw;
  return {
    px, py, price,
    inPlot: px >= geo.left && px <= geo.right && py >= geo.top && py <= geo.bottom,
    inAxis: px > geo.right,
    ts: indexToTime(geo.rows, (px - geo.left) / geo.slot - 0.5, timeframeMs(timeframe))
  };
}

/* ------------------------------------------------------------------ toolbar */

const TOOLS = [
  ['cursor', '↖', 'Cursor', 'Select and drag drawings'],
  ['hline', '―', 'S/R line', 'Click to place a horizontal support/resistance line'],
  ['trend', '╱', 'Trend', 'Two clicks: trend line'],
  ['fib', 'Fib', 'Fib', 'Two clicks: Fibonacci retracement'],
  ['measure', '↔', 'Measure', 'Two clicks: pips, %, bars and time between points'],
  ['long', '▲ Long', 'Long', 'Click to place a long position (entry, stop, target) with risk/reward'],
  ['short', '▼ Short', 'Short', 'Click to place a short position with risk/reward'],
  ['alert', '🔔', 'Alert', 'Click a price to set an alert; it fires when the live price crosses it']
];

function Toggle({ on, onClick, children, title, disabled }) {
  return <button type="button" className={'ct-btn' + (on ? ' on' : '')} aria-pressed={!!on} title={title} disabled={disabled} onClick={onClick}>{children}</button>;
}

export function ChartToolsBar({ tools, geoRange, unit = 'pips', fmt = (v) => String(v), timeframe }) {
  const { prefs, setPref, replay, replayControls, replaying, stream, streamFresh, mtf, book, derivs, isFutures, alerts, drawings } = tools;
  const htf = higherTimeframe(timeframe);
  const active = alerts.filter((a) => !a.triggeredAt);
  const streamLabel = streamFresh ? 'Live WS' : stream.status === 'connecting' ? 'WS…' : prefs.stream ? 'Polling' : 'Poll only';
  const d = derivs.data;
  return <div className="ct-bar" role="toolbar" aria-label="Chart tools">
    <div className="ct-group" role="group" aria-label="Drawing tools">
      {TOOLS.map(([id, icon, label, tip]) => <button key={id} type="button" className={'ct-btn' + (tools.tool === id ? ' on' : '')} aria-pressed={tools.tool === id} title={tip} onClick={() => (id === 'cursor' ? tools.setTool(tools.tool) : tools.setTool(id))}><span aria-hidden="true">{icon}</span><span className="ct-sr">{label}</span></button>)}
      <button type="button" className="ct-btn" title="Remove every drawing, measurement and alert for this market" onClick={tools.clearAll} disabled={!drawings.length && !alerts.length}>Clear</button>
    </div>
    <div className="ct-group" role="group" aria-label="Price scale">
      <label className="ct-field">Scale <select value={prefs.scaleMode} onChange={(e) => setPref('scaleMode', e.target.value)}>{SCALE_MODES.map((m) => <option key={m} value={m}>{SCALE_LABEL[m]}</option>)}</select></label>
      <Toggle on={!!tools.lockedRange} title="Freeze the visible price range (drag-free inspection while price moves)" onClick={() => tools.setLockedRange(tools.lockedRange ? null : (geoRange && geoRange.hi > geoRange.lo ? { lo: geoRange.lo, hi: geoRange.hi } : null))}>{tools.lockedRange ? 'Locked' : 'Lock range'}</Toggle>
    </div>
    <div className="ct-group" role="group" aria-label="Chart layers">
      <Toggle on={prefs.showProfile} onClick={() => setPref('showProfile', !prefs.showProfile)} title="Volume profile of the visible candles with POC and 70% value area">Profile</Toggle>
      <Toggle on={prefs.showMtf} onClick={() => setPref('showMtf', !prefs.showMtf)} title={htf ? 'Open and previous high/low/close from the ' + htf + ' timeframe' : 'No higher timeframe available'} disabled={!htf}>{htf ? htf.toUpperCase() + ' levels' : 'HTF'}</Toggle>
      <Toggle on={prefs.showDepth} onClick={() => setPref('showDepth', !prefs.showDepth)} title="Order-book depth bars and bid/ask spread (full JPTI API)">Depth</Toggle>
      <Toggle on={prefs.link} onClick={() => setPref('link', !prefs.link)} title="Mirror the crosshair between charts showing the same market">Link</Toggle>
      <Toggle on={prefs.stream} onClick={() => setPref('stream', !prefs.stream)} title="Public exchange WebSocket for tick-by-tick prices; REST polling is the fallback">
        <i className={'ct-dot ' + (streamFresh ? 'live' : 'idle')} />{streamLabel}
      </Toggle>
    </div>
    <div className="ct-group" role="group" aria-label="Replay">
      {!replaying ? <button type="button" className="ct-btn" title="Replay history candle by candle from 60 candles back" disabled={tools.total < 40} onClick={() => replayControls.start(60)}>⏵ Replay</button> : <>
        <button type="button" className="ct-btn" onClick={() => replayControls.step(-1)} title="Back one candle">⏮</button>
        <button type="button" className={'ct-btn' + (replay.playing ? ' on' : '')} onClick={replayControls.toggle} aria-pressed={replay.playing} title={replay.playing ? 'Pause' : 'Play'}>{replay.playing ? '⏸' : '⏵'}</button>
        <button type="button" className="ct-btn" onClick={() => replayControls.step(1)} title="Forward one candle">⏭</button>
        <input className="ct-seek" type="range" min={29} max={Math.max(30, tools.total - 1)} value={replay.index} aria-label="Replay position" onChange={(e) => replayControls.seek(e.target.value)} />
        <select value={replay.speed} aria-label="Replay speed" onChange={(e) => replayControls.setSpeed(Number(e.target.value))}>{REPLAY_SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}</select>
        <button type="button" className="ct-btn" onClick={replayControls.stop} title="Exit replay and return to live">Live ⏹</button>
      </>}
    </div>
    <details className="ct-pop">
      <summary title="Position size inputs for the Long/Short tools">Risk</summary>
      <div className="ct-pop-body">
        <label>Account size <input type="number" min="0" step="100" value={prefs.account.accountSize} onChange={(e) => setPref('account', { ...prefs.account, accountSize: Number(e.target.value) })} /></label>
        <label>Risk per trade % <input type="number" min="0" max="100" step="0.25" value={prefs.account.riskPct} onChange={(e) => setPref('account', { ...prefs.account, riskPct: Number(e.target.value) })} /></label>
        <label className="ct-check"><input type="checkbox" checked={prefs.sound} onChange={(e) => setPref('sound', e.target.checked)} /> Sound on alert</label>
        <small>Hypothetical sizing for planning only. No order is placed.</small>
      </div>
    </details>
    <details className="ct-pop">
      <summary>Alerts{active.length ? ' (' + active.length + ')' : ''}</summary>
      <div className="ct-pop-body">
        {!alerts.length && <small>No alerts. Pick the 🔔 tool and click a price.</small>}
        {alerts.map((a) => <div key={a.id} className={'ct-alert-row' + (a.triggeredAt ? ' done' : '')}><span>{a.direction === 'above' ? '▲' : '▼'} {fmt(a.price)}</span><small>{a.triggeredAt ? 'fired ' + new Date(a.triggeredAt).toLocaleTimeString() : 'armed'}</small><button type="button" aria-label="Remove alert" onClick={() => tools.removeAlert(a.id)}>×</button></div>)}
      </div>
    </details>
    {prefs.showMtf && mtf.status === 'unavailable' && <small className="ct-note" role="status">{mtf.note}</small>}
    {prefs.showDepth && book.status === 'unavailable' && <small className="ct-note" role="status">{book.note}{tools.spread ? ' Spread from the live feed.' : ''}</small>}
    {isFutures && <div className="ct-derivs" aria-label="Derivatives context">
      {derivs.status === 'ready' && d ? <>
        <span title="Funding rate for the next interval">Funding <b className={d.fundingPct > 0 ? 'up' : d.fundingPct < 0 ? 'down' : ''}>{fundingLabel(d.fundingPct)}</b>{d.fundingInMs !== null && <em> in {formatCountdown(d.fundingInMs)}</em>}</span>
        {d.markPrice !== null && <span>Mark <b>{fmt(d.markPrice)}</b></span>}
        {d.basis !== null && <span title="Mark minus index">Basis <b>{fmt(d.basis)}</b></span>}
        {d.openInterestValue !== null ? <span>OI <b>{Math.round(d.openInterestValue).toLocaleString()}</b></span> : d.openInterest !== null ? <span>OI <b>{d.openInterest.toLocaleString()}</b></span> : null}
        <span title="Real liquidations are only shown when the venue reports them">Liquidations <b>{d.liquidationStatus === 'reported' ? d.liquidations.length + ' reported' : d.liquidationStatus === 'none-reported' ? 'none reported' : 'not provided by venue'}</b></span>
      </> : <span>{derivs.status === 'off' ? 'Loading derivatives context…' : derivs.note}</span>}
    </div>}
    {tools.toasts.length > 0 && <div className="ct-toasts" role="status" aria-live="polite">{tools.toasts.map((t) => <div key={t.id} className={'ct-toast ' + t.kind}>{t.text}</div>)}</div>}
  </div>;
}

/* ------------------------------------------------------------------ SVG overlay */

function Tag({ x, y, text, color = '#0d1d36', stroke = '#4a79c9', fg = '#dbe8ff', anchor = 'start', onClick, label }) {
  const w = Math.max(24, text.length * 5.9 + 10);
  const x0 = anchor === 'end' ? x - w : x;
  return <g transform={'translate(' + x0 + ' ' + (y - 8) + ')'} onClick={onClick ? (e) => { e.stopPropagation(); onClick(e); } : undefined} style={onClick ? { cursor: 'pointer' } : undefined} role={onClick ? 'button' : undefined} aria-label={label}>
    <rect width={w} height="16" rx="3" fill={color} stroke={stroke} opacity=".94" />
    <text x={w / 2} y="11.5" textAnchor="middle" fill={fg} fontSize="9.5" fontFamily={FONT} fontWeight="600">{text}</text>
  </g>;
}

export function ChartToolsSvg({ tools, geo, timeframe, symbol, fmt = (v) => String(v), unit = 'pips', width, height, suppressGhost = false }) {
  const clipId = 'ct-clip-' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const tf = timeframeMs(timeframe);
  const { rows } = geo;
  const { prefs } = tools;
  const interactive = tools.tool === 'cursor';
  const X = (ts) => { const i = timeToIndex(rows, ts, tf); return i === null ? null : geo.x(i); };
  const inView = (p) => Number.isFinite(p) && p >= geo.lo && p <= geo.hi;
  const plotW = geo.right - geo.left;
  const bins = Math.max(12, Math.min(80, Math.floor((geo.bottom - geo.top) / 7)));

  const profile = useMemo(() => (prefs.showProfile ? buildRangeProfile(rows, { bins, lo: geo.lo, hi: geo.hi }) : null), [prefs.showProfile, rows, bins, geo.lo, geo.hi]);
  const depth = useMemo(() => {
    const s = tools.book.summary;
    if (!prefs.showDepth || !s) return null;
    return { bids: bucketDepth(s.bids, { lo: geo.lo, hi: geo.hi, bins }), asks: bucketDepth(s.asks, { lo: geo.lo, hi: geo.hi, bins }) };
  }, [prefs.showDepth, tools.book.summary, geo.lo, geo.hi, bins]);

  const drag = (event, apply) => {
    event.stopPropagation(); event.preventDefault();
    const svg = event.currentTarget.ownerSVGElement;
    const move = (e) => {
      const box = svg.getBoundingClientRect();
      const py = Math.max(geo.top, Math.min(geo.bottom, e.clientY - box.top));
      const raw = geo.priceAt(py);
      apply(geo.pip > 0 ? Number((Math.round(raw / geo.pip) * geo.pip).toFixed(12)) : raw);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const hit = (y, onDown, title) => interactive ? <line x1={geo.left} x2={geo.right} y1={y} y2={y} stroke="transparent" strokeWidth="11" style={{ cursor: 'ns-resize' }} onPointerDown={onDown}><title>{title}</title></line> : null;

  const line = (price, color, dash, w = 1) => inView(price) ? <line x1={geo.left} x2={geo.right} y1={geo.y(price)} y2={geo.y(price)} stroke={color} strokeWidth={w} strokeDasharray={dash} /> : null;

  const renderDrawing = (d) => {
    if (d.kind === 'hline') {
      if (!inView(d.price)) return null;
      const y = geo.y(d.price);
      return <g key={d.id}><line x1={geo.left} x2={geo.right} y1={y} y2={y} stroke={AMBER} strokeDasharray="5 4" />{hit(y, (e) => drag(e, (p) => tools.updateDrawing(d.id, { price: p })), 'Drag to move')}
        <Tag x={geo.left + 6} y={y - 10} text={'S/R ' + fmt(d.price) + '  ×'} stroke={AMBER} fg={AMBER} onClick={() => tools.removeDrawing(d.id)} label="Remove support/resistance line" /></g>;
    }
    if (d.kind === 'trend' || d.kind === 'fib') {
      const x1 = X(d.t1), x2 = X(d.t2);
      if (x1 === null || x2 === null) return null;
      if (d.kind === 'trend') {
        const m = measureBetween({ ts: d.t1, price: d.p1 }, { ts: d.t2, price: d.p2 }, { pip: geo.pip, timeframe, rows });
        return <g key={d.id}><line x1={x1} y1={geo.y(d.p1)} x2={x2} y2={geo.y(d.p2)} stroke={VIOLET} strokeWidth="2" />
          <circle cx={x1} cy={geo.y(d.p1)} r="3" fill={VIOLET} /><circle cx={x2} cy={geo.y(d.p2)} r="3" fill={VIOLET} />
          {m && <Tag x={(x1 + x2) / 2} y={(geo.y(d.p1) + geo.y(d.p2)) / 2 - 12} text={(m.pips ?? '—') + ' ' + unit + ' · ' + m.pct.toFixed(2) + '%  ×'} stroke={VIOLET} fg="#d8ccff" onClick={() => tools.removeDrawing(d.id)} label="Remove trend line" />}</g>;
      }
      const levels = fibLevels(d.p1, d.p2), xs = Math.min(x1, x2);
      return <g key={d.id}>{levels.map((l, i) => inView(l.price) && <g key={l.ratio}><line x1={xs} x2={geo.right} y1={geo.y(l.price)} y2={geo.y(l.price)} stroke={l.ratio === 0.5 || l.ratio === 0.618 ? AMBER : '#8da2c0'} strokeOpacity=".8" strokeDasharray={l.ratio === 0 || l.ratio === 1 ? undefined : '4 3'} />
        <text x={xs + 4} y={geo.y(l.price) - 3} fill="#b9c8de" fontSize="9.5" fontFamily={FONT}>{l.ratio} · {fmt(l.price)}</text></g>)}
        <line x1={x1} y1={geo.y(d.p1)} x2={x2} y2={geo.y(d.p2)} stroke="#8da2c0" strokeDasharray="2 3" />
        <Tag x={xs} y={geo.y(d.p2) + 14} text="Fib  ×" stroke="#8da2c0" fg="#b9c8de" onClick={() => tools.removeDrawing(d.id)} label="Remove Fibonacci retracement" /></g>;
    }
    if (d.kind === 'rr') {
      const xs = X(d.t);
      if (xs === null) return null;
      const xe = Math.min(geo.right, xs + Math.max(120, geo.slot * 40));
      const r = riskReward({ side: d.side, entry: d.entry, stop: d.stop, target: d.target, accountSize: prefs.account.accountSize, riskPct: prefs.account.riskPct, pip: geo.pip });
      const yE = geo.y(d.entry), yS = geo.y(d.stop), yT = geo.y(d.target);
      const bad = !r.valid;
      return <g key={d.id}>
        <rect x={xs} y={Math.min(yE, yT)} width={Math.max(2, xe - xs)} height={Math.abs(yT - yE)} fill={UP} fillOpacity=".13" />
        <rect x={xs} y={Math.min(yE, yS)} width={Math.max(2, xe - xs)} height={Math.abs(yS - yE)} fill={DOWN} fillOpacity=".13" />
        <line x1={xs} x2={xe} y1={yE} y2={yE} stroke="#cdd8e8" strokeWidth="1.4" />
        <line x1={xs} x2={xe} y1={yT} y2={yT} stroke={UP} strokeWidth="1.2" /><line x1={xs} x2={xe} y1={yS} y2={yS} stroke={DOWN} strokeWidth="1.2" />
        {interactive && [['entry', yE], ['target', yT], ['stop', yS]].map(([k, y]) => <line key={k} x1={xs} x2={xe} y1={y} y2={y} stroke="transparent" strokeWidth="11" style={{ cursor: 'ns-resize' }} onPointerDown={(e) => drag(e, (p) => tools.updateDrawing(d.id, { [k]: p }))}><title>Drag {k}</title></line>)}
        <text x={xs + 5} y={yT + (d.side === 'long' ? 12 : -4)} fill="#9df0cc" fontSize="9.5" fontFamily={FONT}>Target {fmt(d.target)}{r.rewardPips !== null ? ' · +' + r.rewardPips + ' ' + unit : ''}{r.rr ? ' · ' + r.rr + 'R' : ''}</text>
        <text x={xs + 5} y={yS + (d.side === 'long' ? -4 : 12)} fill="#ffb3ba" fontSize="9.5" fontFamily={FONT}>Stop {fmt(d.stop)}{r.riskPips !== null ? ' · −' + r.riskPips + ' ' + unit : ''}{r.riskAmount ? ' · risk ' + r.riskAmount.toFixed(2) : ''}</text>
        <text x={xs + 5} y={yE - 4} fill="#dbe6f6" fontSize="9.5" fontFamily={FONT} fontWeight="700">{d.side === 'long' ? 'Long' : 'Short'} {fmt(d.entry)}{r.units ? ' · ' + (r.units < 1 ? r.units.toFixed(4) : r.units.toFixed(2)) + ' units' : ''}</text>
        {bad && <text x={xs + 5} y={yE + 13} fill="#ff98a2" fontSize="9.5" fontFamily={FONT}>{r.issues[0]}</text>}
        <Tag x={xe} y={yE} anchor="end" text="×" stroke="#4a6385" fg="#cdd8e8" onClick={() => tools.removeDrawing(d.id)} label="Remove position" />
      </g>;
    }
    return null;
  };

  const pendingEl = (() => {
    const p = tools.pending;
    if (!p || !p.b) return null;
    const x1 = X(p.a.ts), x2 = X(p.b.ts);
    if (x1 === null || x2 === null) return null;
    const y1 = geo.y(p.a.price), y2 = geo.y(p.b.price);
    const m = measureBetween(p.a, p.b, { pip: geo.pip, timeframe, rows });
    return <g pointerEvents="none"><line x1={x1} y1={y1} x2={x2} y2={y2} stroke={p.tool === 'measure' ? SKY : VIOLET} strokeDasharray="4 3" strokeWidth="1.6" />
      <circle cx={x1} cy={y1} r="3.5" fill={p.tool === 'measure' ? SKY : VIOLET} />
      {m && p.tool === 'measure' && <Tag x={x2 + 8} y={y2} text={m.pips + ' ' + unit + ' · ' + m.pct.toFixed(2) + '%'} stroke={SKY} fg="#bfe9ff" />}</g>;
  })();

  const measureEl = (() => {
    const mm = tools.measure;
    if (!mm) return null;
    const x1 = X(mm.a.ts), x2 = X(mm.b.ts);
    if (x1 === null || x2 === null) return null;
    const m = measureBetween(mm.a, mm.b, { pip: geo.pip, timeframe, rows });
    if (!m) return null;
    const y1 = geo.y(mm.a.price), y2 = geo.y(mm.b.price), col = m.up ? UP : DOWN;
    const text = (m.priceDelta >= 0 ? '+' : '') + fmt(m.priceDelta) + ' (' + (m.pct >= 0 ? '+' : '') + m.pct.toFixed(2) + '%) · ' + (m.pips ?? '—') + ' ' + unit + ' · ' + m.bars + ' bars · ' + m.durationLabel;
    return <g><rect x={Math.min(x1, x2)} y={Math.min(y1, y2)} width={Math.abs(x2 - x1)} height={Math.abs(y2 - y1)} fill={col} fillOpacity=".12" stroke={col} strokeOpacity=".6" pointerEvents="none" />
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={col} strokeWidth="1.5" pointerEvents="none" />
      <Tag x={Math.max(geo.left + 4, Math.min(geo.right - text.length * 5.9 - 14, (x1 + x2) / 2 - text.length * 2.9))} y={Math.min(y1, y2) - 12} text={text + '  ×'} stroke={col} fg="#eaf2ff" onClick={() => tools.setMeasure(null)} label="Clear measurement" /></g>;
  })();

  const mtfLevels = prefs.showMtf && tools.mtf.status === 'ready' ? tools.mtf.data.levels : [];
  const alertsLive = tools.alerts.filter((a) => !a.triggeredAt && inView(a.price));
  const liqs = tools.derivs.status === 'ready' ? tools.derivs.data.liquidations : [];
  const liqMax = liqs.reduce((m, l) => Math.max(m, l.value || 0), 0);
  const spread = prefs.showDepth || tools.spread ? tools.spread : null;
  const ghost = suppressGhost ? null : tools.ghost, gx = ghost ? X(ghost.ts) : null;

  return <g className="ct-overlay">
    <defs><clipPath id={clipId}><rect x={geo.left} y={geo.top} width={Math.max(0, plotW)} height={Math.max(0, geo.bottom - geo.top)} /></clipPath></defs>
    <g clipPath={'url(#' + clipId + ')'}>
      {profile && <g pointerEvents="none">{profile.bins.map((b, i) => { const w = (b.volume / profile.max) * plotW * 0.18; const inVA = b.mid >= profile.val && b.mid <= profile.vah; const yTop = geo.y(b.hi), yBot = geo.y(b.lo); return w > 0.4 && <rect key={i} x={geo.left} y={yTop} width={w} height={Math.max(1, yBot - yTop - 0.5)} fill={inVA ? SKY : '#6f819b'} fillOpacity={inVA ? 0.3 : 0.2} />; })}
        {line(profile.poc.price, AMBER, '6 3', 1.2)}{line(profile.vah, SKY, '2 4')}{line(profile.val, SKY, '2 4')}</g>}
      {depth && <g pointerEvents="none">
        {depth.bids.buckets.map((b, i) => b.notional > 0 && <rect key={'b' + i} x={geo.right - (b.notional / (Math.max(depth.bids.max, depth.asks.max) || 1)) * plotW * 0.14} y={geo.y(b.hi)} width={(b.notional / (Math.max(depth.bids.max, depth.asks.max) || 1)) * plotW * 0.14} height={Math.max(1, geo.y(b.lo) - geo.y(b.hi) - 0.5)} fill={UP} fillOpacity=".3" />)}
        {depth.asks.buckets.map((b, i) => b.notional > 0 && <rect key={'a' + i} x={geo.right - (b.notional / (Math.max(depth.bids.max, depth.asks.max) || 1)) * plotW * 0.14} y={geo.y(b.hi)} width={(b.notional / (Math.max(depth.bids.max, depth.asks.max) || 1)) * plotW * 0.14} height={Math.max(1, geo.y(b.lo) - geo.y(b.hi) - 0.5)} fill={DOWN} fillOpacity=".3" />)}</g>}
      {spread && <g pointerEvents="none">{inView(spread.bestBid) && inView(spread.bestAsk) && <rect x={geo.left} y={geo.y(spread.bestAsk)} width={plotW} height={Math.max(1, geo.y(spread.bestBid) - geo.y(spread.bestAsk))} fill="#8da2c0" fillOpacity=".08" />}{line(spread.bestBid, UP, '1 3', 0.8)}{line(spread.bestAsk, DOWN, '1 3', 0.8)}</g>}
      {mtfLevels.map((l) => inView(l.price) && <g key={l.id} pointerEvents="none"><line x1={geo.left} x2={geo.right} y1={geo.y(l.price)} y2={geo.y(l.price)} stroke={l.kind === 'open' ? SKY : '#b79cff'} strokeDasharray={l.kind === 'open' ? '8 3' : '3 4'} strokeOpacity=".85" />
        <text x={geo.right - 6} y={geo.y(l.price) - 3} textAnchor="end" fill={l.kind === 'open' ? '#9bdcff' : '#cdbbff'} fontSize="9.5" fontFamily={FONT}>{tools.mtf.data.timeframe.toUpperCase()} {l.label} {fmt(l.price)}</text></g>)}
      {tools.drawings.map(renderDrawing)}
      {alertsLive.map((a) => <g key={a.id}><line x1={geo.left} x2={geo.right} y1={geo.y(a.price)} y2={geo.y(a.price)} stroke={AMBER} strokeWidth="1.2" strokeDasharray="1 4" />
        <Tag x={geo.right - 6} y={geo.y(a.price)} anchor="end" text={'🔔 ' + fmt(a.price) + '  ×'} stroke={AMBER} fg={AMBER} onClick={() => tools.removeAlert(a.id)} label="Remove price alert" /></g>)}
      {liqs.map((l, i) => { const x = X(l.ts); if (x === null || !inView(l.price)) return null; const r = 3 + (liqMax ? Math.sqrt((l.value || 0) / liqMax) * 5 : 0), y = geo.y(l.price), long = l.side === 'long-liquidated';
        return <polygon key={i} points={long ? [x - r, y - r, x + r, y - r, x, y + r].join(' ') : [x - r, y + r, x + r, y + r, x, y - r].join(' ')} fill={long ? DOWN : UP} fillOpacity=".85"><title>{(long ? 'Long' : 'Short') + ' liquidation at ' + fmt(l.price) + (l.value ? ' · ' + Math.round(l.value).toLocaleString() : '')}</title></polygon>; })}
      {measureEl}{pendingEl}
      {ghost && gx !== null && <g pointerEvents="none"><line x1={gx} x2={gx} y1={geo.top} y2={geo.bottom} stroke={VIOLET} strokeDasharray="3 3" strokeOpacity=".7" />
        {Number.isFinite(ghost.price) && inView(ghost.price) && <line x1={geo.left} x2={geo.right} y1={geo.y(ghost.price)} y2={geo.y(ghost.price)} stroke={VIOLET} strokeDasharray="3 3" strokeOpacity=".45" />}</g>}
    </g>
    {profile && <g pointerEvents="none"><text x={geo.left + 6} y={geo.y(profile.poc.price) - 3} fill={AMBER} fontSize="9.5" fontFamily={FONT}>POC {fmt(profile.poc.price)}</text></g>}
    {spread && <g pointerEvents="none"><Tag x={geo.right - 6} y={Math.max(geo.top + 14, Math.min(geo.bottom - 14, geo.y((spread.bestBid + spread.bestAsk) / 2) + 26))} anchor="end" text={'Spread ' + (spread.spreadPips !== null ? spread.spreadPips + ' ' + unit + ' · ' : '') + spread.spreadPct.toFixed(3) + '%'} stroke="#4a6385" fg="#cdd8e8" /></g>}
    {tools.replaying && <g pointerEvents="none"><g transform={'translate(' + (geo.left + 8) + ' ' + (geo.top + 6) + ')'}><rect width="176" height="20" rx="4" fill="#3b1d24" stroke="#ef5361" /><text x="88" y="14" textAnchor="middle" fill="#ffd0d5" fontSize="10.5" fontWeight="700" fontFamily={FONT}>REPLAY · candle {tools.replay.index + 1} / {tools.total}{tools.replay.playing ? ' ▶' : ''}</text></g></g>}
    {tools.pending && <g pointerEvents="none"><text x={geo.left + 8} y={geo.bottom - 8} fill="#cdd8e8" fontSize="10" fontFamily={FONT}>Click the second point · Esc cancels</text></g>}
    {!tools.pending && tools.tool !== 'cursor' && <g pointerEvents="none"><text x={geo.left + 8} y={geo.bottom - 8} fill="#cdd8e8" fontSize="10" fontFamily={FONT}>{tools.tool === 'alert' ? 'Click a price to arm an alert' : tools.tool === 'long' || tools.tool === 'short' ? 'Click to place the entry' : tools.tool === 'hline' ? 'Click to place the line' : 'Click the first point'} · Esc cancels</text></g>}
  </g>;
}
