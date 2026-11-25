// Confirmed-swing SMT divergence between a primary instrument and a correlated market.
// Uses closed candles only and reports context; it never creates an independent trade signal.
const n=v=>Number.isFinite(Number(v))?Number(v):null;
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
function swings(rows,kind,len){
 const out=[];
 for(let i=len;i<rows.length-len;i++){
  const v=kind==="high"?rows[i][2]:rows[i][3];
  let valid=true;
  for(let j=i-len;j<=i+len;j++){if(j===i)continue;const x=kind==="high"?rows[j][2]:rows[j][3];if(kind==="high"?x>=v:x<=v){valid=false;break;}}
  if(valid)out.push({index:i,ts:rows[i][0],price:v,confirmedAt:rows[i+len][0]});
 }
 return out;
}
export function analyzeSmtDivergence(primaryInput,correlatedInput,{primarySymbol="primary",correlatedSymbol="correlated",swingLen=3,now=Date.now(),maxAgeMs=2*60*60*1000}={}){
 const clean=input=>(input||[]).filter(r=>Array.isArray(r)&&r.length>=6&&r.slice(0,6).every((v,i)=>i===0||Number.isFinite(Number(v)))).map(r=>r.slice(0,6).map(Number)).filter(r=>r[0]<now);
 const primary=clean(primaryInput),correlated=clean(correlatedInput);
 if(primary.length<2*swingLen+5||correlated.length<2*swingLen+5)return{status:"insufficient",bias:0,confidence:0,reason:"Insufficient closed candles for confirmed correlated swing comparison."};
 const pLast=primary.at(-1)[0],cLast=correlated.at(-1)[0],age=Math.abs(pLast-cLast);
 if(age>maxAgeMs)return{status:"stale",bias:0,confidence:0,reason:"Correlated market candle timestamps are not aligned.",timestampSkewMs:age};
 const ph=swings(primary,"high",swingLen).slice(-2),pl=swings(primary,"low",swingLen).slice(-2);
 const ch=swings(correlated,"high",swingLen).slice(-2),cl=swings(correlated,"low",swingLen).slice(-2);
 if(ph.length<2||pl.length<2||ch.length<2||cl.length<2)return{status:"insufficient",bias:0,confidence:0,reason:"Two confirmed swing highs and lows are required on both instruments."};
 const pHH=ph[1].price>ph[0].price,pLL=pl[1].price<pl[0].price,cHH=ch[1].price>ch[0].price,cLL=cl[1].price<cl[0].price;
 let direction="neutral",kind="none",strength=0;
 if(pHH!==cHH){direction="bearish";kind="high-divergence";strength=.45+clamp(Math.abs((ph[1].price/ph[0].price-1)-(ch[1].price/ch[0].price-1))/.02)*.45;}
 else if(pLL!==cLL){direction="bullish";kind="low-divergence";strength=.45+clamp(Math.abs((pl[1].price/pl[0].price-1)-(cl[1].price/cl[0].price-1))/.02)*.45;}
 const bias=direction==="bullish"?strength:direction==="bearish"?-strength:0;
 return{status:"ready",primarySymbol,correlatedSymbol,bias:Number(bias.toFixed(3)),direction,kind,confidence:direction==="neutral" ? 0.2 : Number((Math.min(.85,strength)*Math.max(.35,1-age/maxAgeMs)).toFixed(3)),
  timestamp:new Date(Math.min(pLast,cLast)).toISOString(),timestampSkewMs:age,
  evidence:{primary:{higherHigh:pHH,lowerLow:pLL,lastHigh:ph[1],previousHigh:ph[0],lastLow:pl[1],previousLow:pl[0]},correlated:{higherHigh:cHH,lowerLow:cLL,lastHigh:ch[1],previousHigh:ch[0],lastLow:cl[1],previousLow:cl[0]}},
  methodology:"SMT is a relative confirmed-swing divergence proxy between two correlated instruments. It is not proof of manipulation or an independent BUY/SELL signal."};
}
