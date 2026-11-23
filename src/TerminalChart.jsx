import React, { useEffect, useMemo, useRef, useState } from 'react';
import { detectSmartMoney } from './smartMoney.js';
import { TRADING_SESSIONS } from './session-intelligence.js';
import { useGainzAlpha } from './gainz-alpha/useGainzAlpha.js';
import GainzAlphaOverlays from './gainz-alpha/GainzAlphaOverlays.jsx';
import { useChartIntelligence } from './chart-intelligence/useChartIntelligence.js';
import ChartIntelligenceOverlays from './chart-intelligence/TerminalChartOverlays.jsx';
import { formatPrice, hhmm, inWindow, liquidityRanges, sessionUtcWindow, utcMinuteOfDay } from './terminal-dashboard-data.js';

const UP = '#22c58b', DOWN = '#ef5361';
const SESSION_TINT = { sydney: '#8b7cf6', tokyo: '#4a9bf5', london: '#3b82f6', 'new-york': '#f0a848' };
const FOCUS_ORDER = ['london', 'new-york', 'tokyo', 'sydney'];

function niceStep(range, target = 7) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
}

function bollinger(closes, period = 20, mult = 2) {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const win = closes.slice(i - period + 1, i + 1);
    const mean = win.reduce((a, b) => a + b, 0) / period;
    const sd = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
    return { mid: mean, upper: mean + sd * mult, lower: mean - sd * mult };
  });
}

function sessionRuns(session, rows) {
  const runs = [];
  let start = null;
  rows.forEach((c, i) => {
    const w = sessionUtcWindow(session, c[0]);
    const on = inWindow(utcMinuteOfDay(c[0]), w.openMinute, w.closeMinute);
    if (on && start === null) start = i;
    if (!on && start !== null) { runs.push([start, i - 1]); start = null; }
  });
  if (start !== null) runs.push([start, rows.length - 1]);
  return runs;
}

const dayFmt = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
function timeLabel(ts, timeframe) {
  if (['1d', '3d', '1w', '1M'].includes(timeframe)) return dayFmt.format(new Date(ts));
  return hhmm(utcMinuteOfDay(ts));
}

export default function TerminalChart({ exchange = 'bitget', marketType = 'spot', symbol, timeframe, candles, profile, context, strip, loading, error, svgRef, overlays, onOverlayChange }) {
  const wrapRef = useRef(null);
  const [size, setSize] = useState({ w: 820, h: 400 });
  const [count, setCount] = useState(96);
  const [hover, setHover] = useState(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 80 && height > 80) setSize({ w: Math.round(width), h: Math.round(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const valid = useMemo(() => (candles || []).filter((c) => Array.isArray(c) && c.length >= 6 && c.slice(0, 6).every((v) => Number.isFinite(Number(v)))).map((c) => c.slice(0, 6).map(Number)), [candles]);
  const ga = useGainzAlpha({ exchange: exchange || (context && context.exchange) || 'bitget', symbol, timeframe, candles: valid });
  const chartIntel = useChartIntelligence({ exchange: exchange || 'bitget', marketType, symbol, timeframe, candles: valid, ga });
  const ci = chartIntel.result;
  const ciLayers = chartIntel.settings.layers;
  const visible = Math.max(30, Math.min(count, valid.length));
  const rows = useMemo(() => valid.slice(-visible), [valid, visible]);
  const offset = valid.length - rows.length;

  const smc = useMemo(() => (overlays.institutional ? detectSmartMoney(valid.slice(0, -1), 3) : null), [valid, overlays.institutional]);
  const bands = useMemo(() => (overlays.bands ? bollinger(valid.map((c) => c[4])).slice(offset) : null), [valid, overlays.bands, offset]);
  const ranges = useMemo(() => liquidityRanges(context?.liquidity, valid.at(-1)?.[4]), [context, valid]);

  const geo = useMemo(() => {
    if (!rows.length) return null;
    const left = 10, right = size.w - 62, top = 14, bottom = size.h - 24;
    const volH = Math.round((bottom - top) * 0.16);
    const priceBottom = bottom - volH - 6;
    const extra = [];
    if (overlays.liquidity) { if (ranges.buySide) extra.push(ranges.buySide.high); if (ranges.sellSide) extra.push(ranges.sellSide.low); }
    let lo = Math.min(...rows.map((c) => c[3]), ...extra), hi = Math.max(...rows.map((c) => c[2]), ...extra);
    if (ci?.volumeProfile) { lo = Math.min(lo, ci.volumeProfile.low); hi = Math.max(hi, ci.volumeProfile.high); }
    if (bands) { bands.filter(Boolean).forEach((b) => { lo = Math.min(lo, b.lower); hi = Math.max(hi, b.upper); }); }
    const pad = (hi - lo || hi * 0.002 || 1) * 0.06;
    lo -= pad; hi += pad;
    const slot = (right - left) / rows.length;
    const x = (i) => left + (i + 0.5) * slot;
    const y = (p) => top + ((hi - p) / (hi - lo)) * (priceBottom - top);
    const maxVol = Math.max(1, ...rows.map((c) => c[5]));
    const step = niceStep(hi - lo, Math.max(4, Math.round((priceBottom - top) / 52)));
    const ticks = [];
    for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) ticks.push(p);
    const decimals = Math.min(profile.digits, Math.max(profile.fx ? 4 : 0, Math.ceil(-Math.log10(step) - 1e-9)));
    return { left, right, top, bottom, priceBottom, volH, slot, x, y, lo, hi, maxVol, ticks, decimals };
  }, [rows, size, ranges, overlays.liquidity, bands, profile.digits, ci?.volumeProfile]);

  const focus = useMemo(() => {
    const active = strip?.snapshot?.activeSessionIds || [];
    return FOCUS_ORDER.find((id) => active.includes(id)) || null;
  }, [strip]);

  const sessionBands = useMemo(() => {
    if (!overlays.sessions || !rows.length) return [];
    return TRADING_SESSIONS.map((session) => ({ session, runs: sessionRuns(session, rows) }));
  }, [rows, overlays.sessions]);

  const marker = useMemo(() => {
    if (!overlays.sessions || !focus) return null;
    const entry = sessionBands.find((b) => b.session.id === focus);
    const last = entry?.runs.at(-1);
    if (!last || last[0] <= 0) return null;
    const w = sessionUtcWindow(entry.session, rows[last[0]][0]);
    return { index: last[0], label: entry.session.name + ' Open', time: w.open + ' UTC' };
  }, [sessionBands, focus, rows, overlays.sessions]);

  const institutionalZone = useMemo(() => {
    if (!overlays.institutional || !smc) return null;
    const closed = valid.length - 1;
    const pick = [...smc.orderBlocks.map((z) => ({ ...z, kind: 'OB' })), ...smc.fairValueGaps.map((z) => ({ ...z, kind: 'FVG' }))]
      .filter((z) => z.mitigatedAt === undefined && z.start >= offset).sort((a, b) => b.end - a.end || b.start - a.start);
    const z = pick.find((x) => x.kind === 'OB') || pick[0];
    return z && z.end <= closed ? { ...z, i0: z.start - offset } : null;
  }, [smc, overlays.institutional, valid.length, offset]);

  if (error && !valid.length) return <div className="tc-empty tc-error" role="alert"><b>Market data unavailable</b><span>{error}</span></div>;
  if (!geo) return <div className="tc-empty"><span>{loading ? 'Loading market data…' : 'No candle data for this market and timeframe.'}</span></div>;

  const { x, y } = geo;
  const active = hover !== null ? rows[hover] : rows.at(-1);
  const prev = hover !== null ? rows[hover - 1] || null : rows.at(-2) || null;
  const change = active && prev ? active[4] - prev[4] : null;
  const changePct = change !== null && prev[4] ? change / prev[4] * 100 : null;
  const last = rows.at(-1);
  const lastUp = last[4] >= last[1];
  const bodyW = Math.max(1.5, Math.min(14, geo.slot * 0.68));
  const rightEdge = geo.right;
  const zoneRect = (low, high, minThickness) => {
    const mid = (low + high) / 2, half = Math.max((high - low) / 2, minThickness / 2);
    const yTop = y(mid + half), yBot = y(mid - half);
    return { y: yTop, h: Math.max(6, yBot - yTop) };
  };
  const minThick = (last[4] || 1) * 0.0003;

  const onMove = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - box.left;
    const i = Math.round((px - geo.left) / geo.slot - 0.5);
    setHover(i >= 0 && i < rows.length ? i : null);
  };
  const onWheel = (event) => {
    event.preventDefault();
    setCount((c) => Math.max(40, Math.min(valid.length || 200, c + (event.deltaY > 0 ? 8 : -8))));
  };

  return <div className="tc-wrap" ref={wrapRef}>
    <div className="tc-ohlc" aria-live="off">
      <b>{symbol.replace('/', '')}</b><span className="tc-dot">·</span><span>{timeframe.replace('1d', '1D').replace('1h', '1H').replace('4h', '4H')}</span>
      {ga.result && ga.result.confirmed && ga.result.confirmed.status === 'ready' && <span className="tc-ga" title={ga.result.confirmed.confidenceNote}>{'α ' + ga.result.confirmed.signal + ' ' + ga.result.confirmed.confidence + '% · ' + ga.result.confirmed.stage.toLowerCase().replaceAll('_', ' ')}{ga.result.preview && ga.result.preview.status === 'ready' && ga.result.preview.signal !== ga.result.confirmed.signal ? ' · preview ' + ga.result.preview.signal : ''}</span>}
      {active && <>
        <span>O<b>{formatPrice(active[1], profile)}</b></span><span>H<b>{formatPrice(active[2], profile)}</b></span>
        <span>L<b>{formatPrice(active[3], profile)}</b></span><span>C<b>{formatPrice(active[4], profile)}</b></span>
        {change !== null && <span className={change >= 0 ? 'tc-up' : 'tc-down'}>{(change >= 0 ? '+' : '') + formatPrice(change, profile)} ({(changePct >= 0 ? '+' : '') + changePct.toFixed(2)}%)</span>}
      </>}
    </div>
    <div className="tc-legend" role="group" aria-label="Chart overlays">
      {[['sessions', 'Sessions'], ['institutional', 'Institutional Liquidity'], ['bands', 'Volatility Bands'], ['liquidity', 'Liquidity Pools']].map(([key, label]) =>
        <button key={key} type="button" aria-pressed={overlays[key]} className={overlays[key] ? 'on' : ''} onClick={() => onOverlayChange(key)}><i/>{label}</button>)}
      <button type="button" aria-pressed={ga.settings.enabled} className={ga.settings.enabled ? 'on' : ''} onClick={() => ga.update({ enabled: !ga.settings.enabled })}><i/>GainzAlpha</button>
    </div>
    <details className="ci-terminal-panel" aria-label="Smart Money Concepts chart intelligence">
      <summary className="ci-terminal-summary">
        <span className="ci-terminal-kicker">LIVE CHART INTELLIGENCE</span>
        <strong className={ci?.confluence?.direction > 0 ? 'bull' : ci?.confluence?.direction < 0 ? 'bear' : ''}>{ci?.display?.state || (ci?.status === 'insufficient' ? 'BUILDING HISTORY' : 'ANALYZING')}</strong>
        <span>Confluence {ci?.confluence?.score == null ? '—' : (ci.confluence.score * 100).toFixed(0) + '/100'}</span>
        <span>Regime {ci?.regime?.state || '—'}</span>
        <span>Grade {ci?.grade?.grade || '—'}</span>
        <span>MTF {ci?.mtf?.filter((m) => m.status === 'fresh').length || 0} active</span>
      </summary>
      <div className="ci-terminal-layers">
        {[
          ['signals','Alpha Signals'],['plan','Trade Plan'],['structure','Structure'],['orderBlocks','Order Blocks'],['fvg','FVG / IFVG'],['liquidity','Liquidity'],['sweeps','Sweeps'],
          ['profile','Volume Profile'],['volumeNodes','HVN / LVN'],['vwap','VWAP'],['smc','Premium / OTE'],['orderflow','Order Flow'],['liquidation','Liquidations']
        ].map(([key,label]) => <button type="button" key={key} aria-pressed={!!ciLayers[key]} className={ciLayers[key] ? 'active' : ''} onClick={() => chartIntel.update({ layers: { [key]: !ciLayers[key] } })}>{label}</button>)}
      </div>
      {ci?.status === 'ready' && <div className="ci-terminal-foot">
        <span>{ci.asOf ? new Date(ci.asOf).toLocaleTimeString() : '—'} · closed candles only</span>
        <span>{ci.provenance?.reduce((n,p) => n + (p.count || 0), 0) || 0} evidence objects</span>
        <span>{ci.orderFlow?.basis === 'ohlcv-estimate' ? 'Order flow estimated from OHLCV' : ci.orderFlow?.basis || 'Order flow unavailable'}</span>
        <span>{ci.liquidation?.basis === 'estimated-model' ? 'Liquidation modelled' : ci.liquidation?.basis || 'Liquidation unavailable'}</span>
      </div>}
    </details>
    <svg ref={svgRef} width={size.w} height={size.h} viewBox={'0 0 ' + size.w + ' ' + size.h} role="img" aria-label={'Candlestick chart for ' + symbol + ' ' + timeframe}
      onMouseMove={onMove} onMouseLeave={() => setHover(null)} onWheel={onWheel} xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width={size.w} height={size.h} fill="#091221"/>
      {geo.ticks.map((p) => <g key={p}><line x1={geo.left} x2={rightEdge} y1={y(p)} y2={y(p)} stroke="#16243a" strokeWidth="1"/><text x={rightEdge + 8} y={y(p) + 3} fill="#7f91aa" fontSize="10" fontFamily="DM Sans, sans-serif">{p.toFixed(geo.decimals)}</text></g>)}
      {rows.map((c, i) => (i % Math.max(1, Math.round(rows.length / 8)) === 0) && <g key={'t' + c[0]}><line x1={x(i)} x2={x(i)} y1={geo.top} y2={geo.bottom - 4} stroke="#122035" strokeWidth="1"/><text x={x(i)} y={size.h - 7} textAnchor="middle" fill="#6f819b" fontSize="10" fontFamily="DM Sans, sans-serif">{timeLabel(c[0], timeframe)}</text></g>)}

      {sessionBands.map(({ session, runs }) => runs.map(([a, b]) => {
        const isFocus = session.id === focus && a === runs.at(-1)[0];
        return <rect key={session.id + a} x={geo.left + a * geo.slot} y={geo.top} width={Math.max(2, (b - a + 1) * geo.slot)} height={geo.priceBottom - geo.top} fill={SESSION_TINT[session.id]} opacity={isFocus ? 0.17 : 0.045}/>;
      }))}

      {bands && <g>
        <path d={bands.map((b, i) => b ? (i === 0 || !bands[i - 1] ? 'M' : 'L') + x(i) + ' ' + y(b.upper) : '').join(' ')} fill="none" stroke="#7aa7ff" strokeOpacity=".55" strokeDasharray="4 3" strokeWidth="1"/>
        <path d={bands.map((b, i) => b ? (i === 0 || !bands[i - 1] ? 'M' : 'L') + x(i) + ' ' + y(b.lower) : '').join(' ')} fill="none" stroke="#7aa7ff" strokeOpacity=".55" strokeDasharray="4 3" strokeWidth="1"/>
      </g>}

      {institutionalZone && (() => { const top = y(institutionalZone.top), bot = y(institutionalZone.bottom); return <g>
        <rect x={x(Math.max(0, institutionalZone.i0))} y={Math.min(top, bot)} width={rightEdge - x(Math.max(0, institutionalZone.i0))} height={Math.max(5, Math.abs(bot - top))} fill="#3b82f6" opacity=".22" stroke="#4f8ff7" strokeOpacity=".6"/>
        <text x={x(Math.max(0, institutionalZone.i0)) + 6} y={Math.min(top, bot) - 4} fill="#9cc2ff" fontSize="10" fontFamily="DM Sans, sans-serif">Institutional {institutionalZone.kind} · {formatPrice(institutionalZone.bottom, profile)} – {formatPrice(institutionalZone.top, profile)}</text></g>; })()}

      {overlays.liquidity && ranges.buySide && (() => { const r = zoneRect(ranges.buySide.low, ranges.buySide.high, minThick); return <g>
        <rect x={geo.left} y={r.y} width={rightEdge - geo.left} height={r.h} fill="#ef5361" opacity=".2" stroke="#ef5361" strokeOpacity=".65" strokeDasharray="5 3"/>
        <text x={geo.left + 156} y={r.y + 12} fill="#ff98a2" fontSize="10.5" fontFamily="DM Sans, sans-serif"><tspan fontWeight="600">Buy-Side Liquidity</tspan>  {formatPrice(ranges.buySide.low, profile)} – {formatPrice(ranges.buySide.high, profile)}</text></g>; })()}
      {overlays.liquidity && ranges.sellSide && (() => { const r = zoneRect(ranges.sellSide.low, ranges.sellSide.high, minThick); return <g>
        <rect x={geo.left} y={r.y} width={rightEdge - geo.left} height={r.h} fill="#22c58b" opacity=".2" stroke="#22c58b" strokeOpacity=".65" strokeDasharray="5 3"/>
        <text x={geo.left + 156} y={r.y + r.h - 5} fill="#7be7bc" fontSize="10.5" fontFamily="DM Sans, sans-serif"><tspan fontWeight="600">Sell-Side Liquidity</tspan>  {formatPrice(ranges.sellSide.low, profile)} – {formatPrice(ranges.sellSide.high, profile)}</text></g>; })()}


      {marker && <g>
        <line x1={x(marker.index)} x2={x(marker.index)} y1={geo.top + 34} y2={geo.priceBottom} stroke="#a9c4ff" strokeOpacity=".7" strokeDasharray="4 4"/>
        <g transform={'translate(' + Math.max(geo.left + 2, Math.min(x(marker.index) - 52, rightEdge - 106)) + ' ' + (geo.top + 2) + ')'}>
          <rect width="104" height="30" rx="5" fill="#0d1d36" stroke="#4a79c9"/>
          <text x="52" y="13" textAnchor="middle" fill="#dbe8ff" fontSize="10.5" fontWeight="700" fontFamily="DM Sans, sans-serif">{marker.label}</text>
          <text x="52" y="25" textAnchor="middle" fill="#8eaedd" fontSize="9.5" fontFamily="DM Sans, sans-serif">{marker.time}</text>
        </g>
      </g>}

      <ChartIntelligenceOverlays result={ci} layers={ciLayers} rows={rows} geometry={geo} profile={profile} />
      {rows.map((c, i) => { const up = c[4] >= c[1]; const col = up ? UP : DOWN; const h = Math.max(1, Math.abs(y(c[4]) - y(c[1])));
        return <g key={c[0]}><line x1={x(i)} x2={x(i)} y1={y(c[2])} y2={y(c[3])} stroke={col} strokeWidth="1"/>
          <rect x={x(i) - bodyW / 2} y={Math.min(y(c[1]), y(c[4]))} width={bodyW} height={h} fill={col}/>
          <rect x={x(i) - bodyW / 2} y={geo.bottom - 4 - (c[5] / geo.maxVol) * geo.volH} width={bodyW} height={(c[5] / geo.maxVol) * geo.volH} fill={col} opacity=".42"/></g>; })}

      <line x1={geo.left} x2={rightEdge} y1={y(last[4])} y2={y(last[4])} stroke={lastUp ? UP : DOWN} strokeDasharray="2 3" strokeOpacity=".8"/>
      <g transform={'translate(' + (rightEdge + 2) + ' ' + (y(last[4]) - 9) + ')'}><rect width="56" height="18" rx="3" fill={lastUp ? UP : DOWN}/><text x="28" y="12.5" textAnchor="middle" fill="#06101d" fontSize="10.5" fontWeight="700" fontFamily="DM Sans, sans-serif">{formatPrice(last[4], profile).slice(0, 8)}</text></g>

      {hover !== null && <g pointerEvents="none"><line x1={x(hover)} x2={x(hover)} y1={geo.top} y2={geo.bottom - 4} stroke="#6f819b" strokeDasharray="3 3"/><line x1={geo.left} x2={rightEdge} y1={y(rows[hover][4])} y2={y(rows[hover][4])} stroke="#6f819b" strokeDasharray="3 3"/></g>}
      <GainzAlphaOverlays ga={ga} geometry={{ rows, min: geo.lo, max: geo.hi, left: geo.left, right: geo.right, top: geo.top, x, y }} />
    </svg>
    {loading && <span className="tc-loading">Updating…</span>}
  </div>;
}
