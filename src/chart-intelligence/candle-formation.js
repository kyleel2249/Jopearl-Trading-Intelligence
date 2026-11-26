/**
 * Candle Formation Intelligence Engine (CFIE).
 * Deterministic OHLCV-derived candle anatomy, pattern, pressure and anomaly analysis.
 * OHLCV pressure/absorption are estimates, never represented as exchange tick/order-book facts.
 */
const clamp=(v,a=0,b=100)=>Math.max(a,Math.min(b,v));
const finite=(v)=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
const round=(v,n=4)=>finite(v)?Number(Number(v).toFixed(n)):null;
const median=(a)=>{if(!a.length)return 0;const s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length/2)];};
const dir=(v)=>v>0?'bullish':v<0?'bearish':'neutral';

function anatomy(c,prev,atr,volBase){
 const [ts,o,h,l,cl,v]=c,range=Math.max(h-l,Math.abs(h-o),Math.abs(l-o),1e-12),body=Math.abs(cl-o),upper=h-Math.max(o,cl),lower=Math.min(o,cl)-l;
 const bodyPct=body/range,upperPct=upper/range,lowerPct=lower/range,closeLocation=(cl-l)/Math.max(h-l,1e-12);
 const signedBody=(cl-o)/range,volRatio=volBase>0?v/volBase:1;
 return {ts,open:o,high:h,low:l,close:cl,volume:v,direction:dir(cl-o),range:round(h-l),rangeAtr:round((h-l)/(atr||h-l)),body:round(body),bodyPct:round(bodyPct),upperWickPct:round(upperPct),lowerWickPct:round(lowerPct),closeLocation:round(closeLocation),volumeRatio:round(volRatio),pressure:round(signedBody*(0.55+0.45*Math.abs(2*closeLocation-1))),closeStrength:round(closeLocation*100)};
}
function classify(a,p,pp){
 const out=[],add=(kind,direction,score,detail)=>out.push({kind,direction,score:Math.round(clamp(score)),detail});
 const {bodyPct:b,upperWickPct:u,lowerWickPct:l,closeLocation:q,volumeRatio:v,direction:d}=a;
 if(b<=.08)add('DOJI','neutral',58+Math.min(25,v*5),'Very small real body; balance or indecision.');
 if(l>=.58&&b<=.32&&q>=.62)add('HAMMER','bullish',48+l*35+Math.min(12,v*3),'Long lower rejection wick with close in upper range.');
 if(u>=.58&&b<=.32&&q<=.38)add('SHOOTING_STAR','bearish',48+u*35+Math.min(12,v*3),'Long upper rejection wick with close in lower range.');
 if(b>=.82&&u<=.09&&l<=.09)add('MARUBOZU',d,62+b*25,'Large directional body with minimal opposing wicks.');
 if(p&&p.direction!==d&&b>=.45&&p.bodyPct>=.45&&a.open<=Math.max(p.open,p.close)&&a.open>=Math.min(p.open,p.close)&&a.close>=Math.max(p.open,p.close)&&d==='bullish')add('BULLISH_ENGULFING','bullish',70+Math.min(20,v*4),'Current body engulfs the prior bearish body.');
 if(p&&p.direction!==d&&b>=.45&&p.bodyPct>=.45&&a.open>=Math.min(p.open,p.close)&&a.open<=Math.max(p.open,p.close)&&a.close<=Math.min(p.open,p.close)&&d==='bearish')add('BEARISH_ENGULFING','bearish',70+Math.min(20,v*4),'Current body engulfs the prior bullish body.');
 if(p&&a.high<p.high&&a.low>p.low)add('INSIDE_BAR','neutral',55+Math.min(20,v*3),'Range contracts inside the previous candle.');
 if(p&&a.high>p.high&&a.low<p.low)add('OUTSIDE_BAR',d,54+Math.min(18,v*3),'Current range engulfs the previous candle range.');
 if(p&&pp&&pp.direction==='bearish'&&p.bodyPct>.55&&p.direction==='neutral'&&a.direction==='bullish'&&a.close>(pp.open+pp.close)/2)add('MORNING_STAR','bullish',72,'Three-candle reversal sequence; confirmation remains context-dependent.');
 if(p&&pp&&pp.direction==='bullish'&&p.bodyPct>.55&&p.direction==='neutral'&&a.direction==='bearish'&&a.close<(pp.open+pp.close)/2)add('EVENING_STAR','bearish',72,'Three-candle reversal sequence; confirmation remains context-dependent.');
 return out;
}
export function analyzeCandleFormation(candles,{atrSeries=[],lookback=120}={}){
 const rows=Array.isArray(candles)?candles.filter(c=>Array.isArray(c)&&c.length>=6&&c.slice(0,6).every(finite)&&c[2]>=c[3]&&c[4]<=c[2]&&c[4]>=c[3]):[];
 if(rows.length<3)return{status:'insufficient',reason:'Need at least three valid closed OHLCV candles.',patterns:[],latest:null,summary:null};
 const start=Math.max(0,rows.length-lookback),all=[];
 for(let i=start;i<rows.length;i++){
  const priorVol=rows.slice(Math.max(0,i-20),i).map(c=>Number(c[5])).filter(v=>v>0),volBase=median(priorVol)||Number(rows[i][5])||1;
  const a=anatomy(rows[i],null,Number(atrSeries[i])||rows[i][2]-rows[i][3],volBase);
  const p=all.at(-1)?.anatomy||null,pp=all.at(-2)?.anatomy||null;
  const patterns=classify(a,p,pp).map(x=>({...x,ts:a.ts,id:[a.ts,x.kind].join('|'),source:{module:'chart-intelligence/candle-formation',method:'ohlcv-candle-geometry-and-sequence-rules',basis:'ohlcv-derived',inputs:{bodyPct:a.bodyPct,upperWickPct:a.upperWickPct,lowerWickPct:a.lowerWickPct,volumeRatio:a.volumeRatio}}}));
  const anomaly=a.rangeAtr>=2.5||a.volumeRatio>=3;
  all.push({anatomy:a,patterns,anomaly});
 }
 const last=all.at(-1),a=last.anatomy;
 const aligned=last.patterns.filter(p=>p.direction!=='neutral');
 const patternScore=aligned.length?aligned.reduce((s,p)=>s+(p.direction==='bullish'?1:-1)*p.score,0)/aligned.reduce((s,p)=>s+p.score,0):0;
 const pressure=clamp(50+50*a.pressure,0,100);
 const rejection=clamp(Math.max(a.upperWickPct,a.lowerWickPct)*100);
 const absorption=last.anomaly&&a.volumeRatio>=1.8&&a.bodyPct<=.35&&(a.upperWickPct>=.35||a.lowerWickPct>=.35);
 const bias=clamp(50+patternScore*35+(pressure-50)*.35,0,100);
 const bullishProbability=clamp(bias),bearishProbability=100-bullishProbability;
 const patterns=all.flatMap(x=>x.patterns).slice(-80);
 return {status:'ready',asOf:a.ts,latest:{...a,patterns:last.patterns,anomaly:last.anomaly,absorption,rejectionScore:Math.round(rejection),pressureScore:Math.round(pressure)},patterns,summary:{direction:bullishProbability>=58?'bullish':bearishProbability>=58?'bearish':'mixed',bullishProbability:Math.round(bullishProbability),bearishProbability:Math.round(bearishProbability),pressureScore:Math.round(pressure),rejectionScore:Math.round(rejection),patternCount:last.patterns.length,anomaly:last.anomaly,absorption,basis:'heuristic OHLCV interpretation; not a calibrated probability or tick-level order-flow measurement'},method:'Closed-candle only; no future bars or look-ahead.'};
}
