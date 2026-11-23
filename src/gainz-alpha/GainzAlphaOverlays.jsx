import React from 'react';

const GREEN = '#20c997', RED = '#f07883', GOLD = '#e5b85c', BLUE = '#60b8ff', VIOLET = '#b38aff', GREY = '#8392a8';

/**
 * SVG overlay layer rendered inside the chart's <svg>. Everything is positioned by TIMESTAMP so it stays
 * aligned while scrolling, zooming, resizing or when the symbol/timeframe changes. Marker counts are capped.
 */
export default function GainzAlphaOverlays({ ga, geometry, onMount, suppress = [] }) {
  const sup = new Set(suppress);
  React.useEffect(() => { if (onMount) { onMount(true); return () => onMount(false); } return undefined; }, [onMount]);
  const data = ga && ga.result && ga.result.confirmed && ga.result.confirmed.status === 'ready' ? ga.result : null;
  if (!data || !geometry || !geometry.rows.length) return <g data-gainz-overlays="empty" />;
  const o = ga.settings.overlays, c = data.confirmed, p = data.preview && data.preview.status === 'ready' ? data.preview : null;
  const idx = new Map(geometry.rows.map((r, i) => [r[0], i]));
  const X = (ts) => (idx.has(ts) ? geometry.x(idx.get(ts)) : null);
  const inView = (price) => Number.isFinite(price) && price >= geometry.min && price <= geometry.max;
  const out = [];
  const label = (key, x, y, text, color, anchor = 'start') => out.push(<text key={key} x={x} y={y} fill={color} fontSize="9" fontWeight="700" textAnchor={anchor} paintOrder="stroke" stroke="#0b1320" strokeWidth="2.5">{text}</text>);

  if (o.liquidity && !sup.has('liquidity')) {
    c.structure.swingHighs.slice(-4).forEach((s, i) => { const x = X(s.ts); if (x != null && inView(s.price)) out.push(<line key={'sh' + i} x1={x - 5} y1={geometry.y(s.price) - 3} x2={x + 5} y2={geometry.y(s.price) - 3} stroke={GREY} strokeWidth="1.2" />); });
    c.structure.swingLows.slice(-4).forEach((s, i) => { const x = X(s.ts); if (x != null && inView(s.price)) out.push(<line key={'sl' + i} x1={x - 5} y1={geometry.y(s.price) + 3} x2={x + 5} y2={geometry.y(s.price) + 3} stroke={GREY} strokeWidth="1.2" />); });
  }
  if (o.equalLevels && !sup.has('equalLevels')) {
    c.structure.equalHighs.slice(-2).forEach((l, i) => { if (inView(l.price)) { const y = geometry.y(l.price); out.push(<line key={'eqh' + i} x1={geometry.left} y1={y} x2={geometry.right} y2={y} stroke={GOLD} strokeOpacity=".55" strokeDasharray="2 4" />); label('eqhl' + i, geometry.left + 4, y - 3, 'BSL · EQH x' + l.count, GOLD); } });
    c.structure.equalLows.slice(-2).forEach((l, i) => { if (inView(l.price)) { const y = geometry.y(l.price); out.push(<line key={'eql' + i} x1={geometry.left} y1={y} x2={geometry.right} y2={y} stroke={GOLD} strokeOpacity=".55" strokeDasharray="2 4" />); label('eqll' + i, geometry.left + 4, y + 10, 'SSL · EQL x' + l.count, GOLD); } });
  }
  if (o.structure && !sup.has('structure')) {
    c.structure.events.slice(-4).forEach((e, i) => { const x = X(e.ts); if (x != null && inView(e.level)) label('st' + i, x, geometry.y(e.level) + (e.direction === 'bullish' ? -4 : 11), e.kind + (e.direction === 'bullish' ? ' ↑' : ' ↓'), e.direction === 'bullish' ? GREEN : RED, 'middle'); });
  }
  if (o.fvg && !sup.has('fvg')) {
    c.fvg.filter((g) => g.status !== 'filled').slice(-5).forEach((g, i) => {
      const x1 = X(g.ts); if (x1 == null) return;
      const y1 = geometry.y(g.top), y2 = geometry.y(g.bottom), col = g.direction === 'bullish' ? GREEN : RED;
      out.push(<g key={'gfvg' + i}><rect x={x1} y={Math.min(y1, y2)} width={Math.max(4, geometry.right - x1)} height={Math.max(2, Math.abs(y2 - y1))} fill={col} fillOpacity={g.status === 'active' ? 0.1 : 0.05} stroke={col} strokeOpacity=".35" strokeDasharray="2 3" /><text x={geometry.right - 3} y={Math.min(y1, y2) - 2} textAnchor="end" fill={col} fontSize="8">{g.status === 'active' ? 'FVG' : 'FVG ' + g.fillPct + '%'}</text></g>);
    });
  }
  const s = c.setup;
  if (o.setup && s) {
    const marks = [['SWEEP', s.sweep.ts, GOLD, s.direction > 0 ? 'low' : 'high'], ['RECLAIM', s.reclaimTs, BLUE, 'close'], ['DISPLACE', s.displacement && s.displacement.ts, VIOLET, 'close']];
    marks.forEach(([name, ts, col, where]) => {
      const i = ts != null ? idx.get(ts) : undefined; if (i == null) return;
      const r = geometry.rows[i], cx = geometry.x(i), price = where === 'high' ? r[2] : where === 'low' ? r[3] : r[4];
      out.push(<g key={'gs' + name}><circle cx={cx} cy={geometry.y(price)} r="3.5" fill={col} stroke="#0b1320" strokeWidth="1.2" /></g>);
      label('gsl' + name, cx + 6, geometry.y(price) + (s.direction > 0 ? 12 : -6), name, col);
    });
    if (['INVALIDATED', 'EXPIRED'].includes(s.state)) { const ix = idx.get(s.sweep.ts); if (ix != null) label('ginv', geometry.x(ix), geometry.top + 10, s.state === 'EXPIRED' ? 'EXPIRED' : 'INVALIDATED · ' + (s.invalidReason || ''), GREY, 'middle'); }
    if (s.state === 'ENTRY_READY' && c.asOf != null) { const ix = idx.get(c.asOf); if (ix != null) label('gent', geometry.x(ix), geometry.y(geometry.rows[ix][4]) + (s.direction > 0 ? 24 : -16), 'CONFIRMED', GREEN, 'middle'); }
  }
  const active = p && ['BUY', 'SELL'].includes(p.signal) ? p : c;
  const live = ['BUY', 'SELL'].includes(active.signal) && active.riskPlan;
  if (o.signal && live && !sup.has('signal')) {
    const ix = idx.get(active.asOf);
    if (ix != null) { const r = geometry.rows[ix], buy = active.signal === 'BUY'; label('gsig', geometry.x(ix), buy ? geometry.y(r[3]) + 22 : geometry.y(r[2]) - 14, (active.provisional ? 'PREVIEW ' : '') + active.signal + ' ' + active.confidence + '%', buy ? GREEN : RED, 'middle'); }
  }
  if (o.risk && live && !sup.has('risk')) {
    const rp = active.riskPlan, dash = active.provisional ? '3 3' : undefined;
    const lines = [['ENTRY', rp.entry, '#dbe7f5'], ['STOP', rp.stopLoss, RED], ['TP1', rp.takeProfit1, GREEN], ['TP2', rp.takeProfit2, GREEN], ['TP3', rp.takeProfit3, GREEN]];
    const x0 = Math.max(geometry.left, geometry.right - 120);
    const yE = geometry.y(rp.entry), yS = geometry.y(rp.stopLoss), yT = geometry.y(rp.takeProfit1);
    if (inView(rp.stopLoss) || inView(rp.takeProfit1)) {
      out.push(<rect key="grz-r" x={x0} y={Math.min(yE, yS)} width={geometry.right - x0} height={Math.abs(yS - yE)} fill={RED} fillOpacity=".07" />);
      out.push(<rect key="grz-g" x={x0} y={Math.min(yE, yT)} width={geometry.right - x0} height={Math.abs(yT - yE)} fill={GREEN} fillOpacity=".07" />);
    }
    lines.forEach(([name, price, col]) => { if (price == null || !inView(price)) return; const y = geometry.y(price); out.push(<line key={'gl' + name} x1={x0} y1={y} x2={geometry.right} y2={y} stroke={col} strokeWidth="1.2" strokeDasharray={dash} />); label('glt' + name, geometry.right - 3, y - 3, name + ' ' + Number(price).toPrecision(6), col, 'end'); });
    if (inView(rp.invalidation) && rp.invalidation !== rp.stopLoss) { const y = geometry.y(rp.invalidation); out.push(<line key="ginvl" x1={x0} y1={y} x2={geometry.right} y2={y} stroke={GREY} strokeDasharray="1 3" />); label('ginvt', geometry.right - 3, y + 10, 'INVALIDATION', GREY, 'end'); }
  }
  return <g data-gainz-overlays="ready" pointerEvents="none">{out}</g>;
}
