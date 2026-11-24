import React from 'react';

const fmt=(v,p)=>Number.isFinite(Number(v))?Number(v).toLocaleString('en-US',{maximumFractionDigits:Math.min(8,p?.digits??4)}):'—';
export default function LiquidityTargetOverlay({analysis,geometry,rows,profile}){
 if(!analysis||analysis.status!=='ready'||!geometry||!rows?.length)return null;
 const {left,right,y}=geometry;
 const levels=[...(analysis.pools?.buySide||[]).slice(0,3),...(analysis.pools?.sellSide||[]).slice(0,3)]
  .filter(item=>Number.isFinite(item.price)&&item.price>=geometry.lo&&item.price<=geometry.hi);
 const visiblePivots=[...(analysis.swingPoints?.highs||[]).map(p=>({...p,side:'high'})),...(analysis.swingPoints?.lows||[]).map(p=>({...p,side:'low'}))]
  .filter(p=>p.timestamp>=rows[0][0]&&p.timestamp<=rows.at(-1)[0]);
 return <g className="liquidity-target-overlay" pointerEvents="none">
  {levels.map((item,i)=>{const buy=item.side==='buy-side',color=buy?'#ef8d68':'#55d5a5',py=y(item.price),label=(item.equal?(buy?'EQH':'EQL'):(buy?'BSL':'SSL'))+' · '+item.score;
   return <g key={item.id||i}><line x1={left} x2={right} y1={py} y2={py} stroke={color} strokeWidth={item.equal?1.5:1} strokeDasharray={item.equal?'3 3':'7 5'} strokeOpacity=".88"/>
    <rect x={Math.max(left+4,right-112)} y={py-10} width="108" height="16" rx="3" fill="#091421" stroke={color} strokeOpacity=".55"/>
    <text x={Math.max(left+8,right-108)} y={py+1.5} fill={color} fontSize="8.5" fontWeight="700">{label+' '+fmt(item.price,profile)}</text>
    <title>{item.source} · {item.touches} touch(es) · distance {item.distancePercent?.toFixed(2)}% · heuristic rank {item.score}/100</title>
   </g>;
  })}
  {visiblePivots.map((p,i)=>{const index=rows.findIndex(r=>r[0]===p.timestamp);if(index<0)return null;const py=y(p.price),color=p.side==='high'?'#e7b65d':'#62c8b1';
   return <g key={p.kind+'-'+p.timestamp}><circle cx={geometry.x(index)} cy={py} r="2.5" fill={color}/><title>{p.kind} · {fmt(p.price,profile)}</title></g>;
  })}
 </g>;
}
