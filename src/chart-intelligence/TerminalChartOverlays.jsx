import React from 'react';

const COLORS = {
  bullish: '#22c58b', bearish: '#ef5361', neutral: '#6f9bd4',
  structure: '#a9c4ff', profile: '#d6b46a', liquidity: '#e7b65d',
  fvg: '#6f9cff', orderBlocks: '#b58cff', vwap: '#67d8d0',
  liquidation: '#f28b72', orderflow: '#d5a5ff', volumeNodes: '#d6b46a'
};
const fmt = (v, p) => Number.isFinite(v) ? Number(v).toLocaleString('en-US', { maximumFractionDigits: Math.min(8, p?.digits ?? 4) }) : '—';

export default function ChartIntelligenceOverlays({ result, layers, rows, geometry, profile }) {
  if (!result || result.status !== 'ready' || !geometry || !rows?.length) return null;
  const { x, y, left, right } = geometry;
  const first = rows[0][0], last = rows[rows.length - 1][0];
  const indexAt = (ts) => {
    if (!Number.isFinite(Number(ts))) return -1;
    if (ts <= first) return 0;
    if (ts > last) return -1;
    let lo = 0, hi = rows.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid][0] < ts) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const yZone = (a, b) => {
    const yt = y(Math.max(a, b)), yb = y(Math.min(a, b));
    return { top: yt, height: Math.max(2, yb - yt) };
  };
  const items = Object.entries(result.layers || {}).flatMap(([key, list]) => layers[key] ? (list || []).map((it) => ({ ...it, _layer: key })) : []);
  const lineLayers = new Set(['profile','sr','liquidity','vwap','volumeNodes']);
  const zones = new Set(['orderBlocks','fvg','smc','liquidation']);
  const vp = layers.profile ? result.volumeProfile : null;
  const maxVol = Math.max(1, ...(vp?.bins || []).map((b) => b.volume));
  return <g className="ci-chart-zone">
    {vp && vp.bins.map((b, i) => {
      const z = yZone(b.price - (vp.high - vp.low) / 128, b.price + (vp.high - vp.low) / 128);
      const w = Math.max(1, (b.volume / maxVol) * Math.min(62, (right - left) * .16));
      return <rect key={'vp-' + i} x={right - w} y={z.top} width={w} height={z.height} fill="#d6b46a" opacity={.08 + (b.volume / maxVol) * .23}><title>Volume profile · {fmt(b.price, profile)} · volume {fmt(b.volume, profile)}</title></rect>;
    })}
    {items.filter((it) => it._layer === 'structure' || it._layer === 'sweeps').map((it) => {
      const i = indexAt(it.ts); if (i < 0 || !Number.isFinite(it.price)) return null;
      const bullish = it.direction === 'bullish', color = COLORS[it._layer] || COLORS[it.direction] || COLORS.neutral;
      return <g key={it.id}>
        <line x1={x(Math.max(0, i - 5))} x2={x(i)} y1={y(it.price)} y2={y(it.price)} stroke={color} strokeWidth="1.2" strokeDasharray={it._layer === 'sweeps' ? '2 3' : '4 3'}/>
        <text x={Math.min(right - 4, x(i) + 3)} y={y(it.price) + (bullish ? -4 : 11)} fill={color} fontSize="8.5" fontWeight="700">{it.label}</text>
      </g>;
    })}
    {items.filter((it) => zones.has(it._layer) && Number.isFinite(it.top) && Number.isFinite(it.bottom)).map((it) => {
      const i = indexAt(it.ts); if (i < 0) return null;
      const z = yZone(it.bottom, it.top), color = COLORS[it.direction] || COLORS[it._layer] || COLORS.neutral;
      const opacity = it._layer === 'orderBlocks' ? .14 : it._layer === 'fvg' ? .12 : it._layer === 'liquidation' ? .09 : .07;
      return <g key={it.id}>
        <rect x={x(i)} y={z.top} width={Math.max(2, right - x(i))} height={z.height} fill={color} opacity={opacity} stroke={color} strokeOpacity=".55" strokeDasharray={it._layer === 'fvg' ? '3 3' : undefined}/>
        <text x={Math.min(right - 4, x(i) + 3)} y={z.top + 10} fill={color} fontSize="8">{it.label}</text>
      </g>;
    })}
    {items.filter((it) => lineLayers.has(it._layer) && Number.isFinite(it.price)).map((it) => {
      const i = indexAt(it.ts), color = COLORS[it._layer] || COLORS[it.direction] || COLORS.neutral;
      if (i < 0) return null;
      const dash = ['LVN','HVN'].includes(it.kind) ? '2 4' : it._layer === 'liquidity' ? '5 4' : '4 3';
      return <g key={it.id}>
        <line x1={x(i)} x2={right} y1={y(it.price)} y2={y(it.price)} stroke={color} strokeWidth={it.kind === 'POC' ? 1.7 : 1} strokeOpacity=".72" strokeDasharray={dash}/>
        <text x={Math.max(left + 2, Math.min(right - 42, x(i) + 3))} y={y(it.price) - 3} fill={color} fontSize="8">{it.label}</text>
      </g>;
    })}
    {vp && ['POC','VAH','VAL'].map((k) => {
      const v = vp[k.toLowerCase()]; if (!Number.isFinite(v)) return null;
      const color = k === 'POC' ? '#f2cf79' : '#9aaec8';
      return <g key={k}><line x1={left} x2={right} y1={y(v)} y2={y(v)} stroke={color} strokeWidth={k === 'POC' ? 1.7 : 1} strokeDasharray={k === 'POC' ? undefined : '5 4'}/><text x={left + 4} y={y(v) - 4} fill={color} fontSize="9">{k}</text></g>;
    })}
  </g>;
}
