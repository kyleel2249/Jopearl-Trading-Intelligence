// Complete deterministic market regime ensemble; operates only on validated closed OHLCV.
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const std=a=>{const m=mean(a);return Math.sqrt(mean(a.map(x=>(x-m)**2)));};
const median=a=>{if(!a.length)return 0;const s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length/2)];};
const pct=(a,x)=>a.length?a.filter(v=>v<=x).length/a.length:.5;
const r=(x)=>Number.isFinite(x)?Number(x.toFixed(4)):null;
function ema(a,p){const k=2/(p+1),o=[];a.forEach((x,i)=>o.push(i?x*k+o[i-1]*(1-k):x));return o;}
function slope(a){const n=a.length,m=(n-1)/2,y=mean(a);let num=0,den=0;for(let i=0;i<n;i++){num+=(i-m)*(a[i]-y);den+=(i-m)**2;}return den?num/den:0;}
function trueRanges(rows){return rows.map((c,i)=>{const p=rows[i-1];return Math.max(c[2]-c[3],p?Math.abs(c[2]-p[4]):0,p?Math.abs(c[3]-p[4]):0);});}
function adx(rows,p=14){const tr=trueRanges(rows);let dx=[];for(let i=p;i<rows.length;i++){let plus=0,minus=0,sum=0;for(let j=i-p+1;j<=i;j++){const up=rows[j][2]-rows[j-1][2],dn=rows[j-1][3]-rows[j][3];plus+=up>dn&&up>0?up:0;minus+=dn>up&&dn>0?dn:0;sum+=tr[j];}const a=sum?100*plus/sum:0,b=sum?100*minus/sum:0;dx.push(a+b?100*Math.abs(a-b)/(a+b):0);}return mean(dx.slice(-p));}
function chop(rows,p=14){if(rows.length<p+1)return 50;const w=rows.slice(-p-1),tr=trueRanges(w).slice(1).reduce((a,b)=>a+b,0),hi=Math.max(...w.slice(1).map(c=>c[2])),lo=Math.min(...w.slice(1).map(c=>c[3]));return hi>lo?100*Math.log10(tr/(hi-lo))/Math.log10(p):50;}
function scores(m){
 const c=x=>clamp(x);
 return {
  'trending-up':.24*c((m.er20-.2)/.55)+.24*c((m.adx-15)/30)+.2*c((m.slopeAtr+.02)/.3)+.18*c((m.emaStack+1)/2)+.14*c((m.persistence-.4)/.55),
  'trending-down':.24*c((m.er20-.2)/.55)+.24*c((m.adx-15)/30)+.2*c((-.02-m.slopeAtr)/.3)+.18*c((1-m.emaStack)/2)+.14*c((m.persistence-.4)/.55),
  ranging:.3*c((.42-m.er20)/.4)+.25*c((55-m.adx)/40)+.2*c((m.chop-40)/40)+.15*c((.65-m.slopeAbs)/.65)+.1*c((.65-m.atrRank)/.65),
  volatile:.35*c((m.atrRank-.6)/.4)+.25*c((m.volRatio-1)/1.5)+.2*c((m.rangeAtr-1)/2)+.2*c((m.realizedRatio-1)/1.5),
  compressed:.35*c((.4-m.atrRank)/.4)+.25*c((.35-m.bbRank)/.35)+.2*c((.6-m.rangeAtr)/.6)+.2*c((.4-m.er20)/.4)
 };
}
function classify(m){
 const raw=scores(m),max=Math.max(...Object.values(raw)),exp=Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,Math.exp((v-max)*4)])),sum=Object.values(exp).reduce((a,b)=>a+b,0),prob=Object.fromEntries(Object.entries(exp).map(([k,v])=>[k,v/sum]));
 const rank=Object.entries(prob).sort((a,b)=>b[1]-a[1]),top=rank[0],runner=rank[1],gap=top[1]-runner[1];
 let state=top[0];if(top[1]<.43||gap<.07)state='transitional';if(state==='trending-up'&&m.slopeAtr<=0||state==='trending-down'&&m.slopeAtr>=0)state='transitional';
 const bias=clamp(prob['trending-up']-prob['trending-down']+m.emaStack*.12,-1,1),entropy=-Object.values(prob).reduce((s,p)=>s+(p? p*Math.log(p):0),0)/Math.log(5);
 return{state,confidence:r(top[1]),probabilities:Object.fromEntries(Object.entries(prob).map(([k,v])=>[k,r(v)])),directionalBias:r(bias),runnerUp:{state:runner[0],probability:r(runner[1])},transitionRisk:r(clamp(entropy*.55+(1-gap)*.45))};
}
export function analyzeMarketRegime(input,{atrSeries=null,higherTimeframes=[],now=Date.now(),includeTimeframes=true}={}){
 const rows=(Array.isArray(input)?input:[]).filter(c=>Array.isArray(c)&&c.length>=6&&c.slice(0,6).every(Number.isFinite)&&c[2]>=c[3]&&c[4]>=c[3]&&c[4]<=c[2]);
 if(rows.length<60)return{status:'insufficient',state:'unknown',reason:'At least 60 valid closed OHLCV candles are required.',confidence:0,probabilities:{},timeframes:[]};
 const closes=rows.map(c=>c[4]),n=rows.length,last=rows[n-1],tr=trueRanges(rows),atr=atrSeries?.filter(Number.isFinite).at(-1)||mean(tr.slice(-14)),atrRecent=(atrSeries||[]).filter(Number.isFinite).slice(-100),atrRank=pct(atrRecent,atr),atrMed=median(atrRecent)||atr,atrRatio=atrMed?atr/atrMed:1;
 const er=p=>{const a=closes.slice(-p-1);let path=0;for(let i=1;i<a.length;i++)path+=Math.abs(a[i]-a[i-1]);return path?Math.abs(a.at(-1)-a[0])/path:0;};
 const e20=ema(closes,20),e50=ema(closes,50),e100=ema(closes,100),slopeAtr=atr?slope(closes.slice(-30))*29/atr:0,stack=((last[4]>e20.at(-1)?1:-1)+(e20.at(-1)>e50.at(-1)?1:-1)+(e50.at(-1)>e100.at(-1)?1:-1))/3;
 const returns=closes.slice(1).map((x,i)=>Math.log(x/closes[i])).filter(Number.isFinite),realizedRatio=std(returns.slice(-20))/(std(returns.slice(-100))||1);
 const rangeAtr=atr?mean(rows.slice(-20).map(c=>c[2]-c[3]))/atr:1,volBase=median(rows.slice(-21,-1).map(c=>c[5]).filter(v=>v>0)),volRatio=volBase?last[5]/volBase:1;
 const typical=rows.map(c=>(c[2]+c[3]+c[4])/3),bw=a=>{const z=a.slice(-20),m=mean(z);return m?4*std(z)/Math.abs(m):0;},bbWidth=bw(typical),bbHist=[];for(let i=Math.max(20,n-100);i<=n;i++)bbHist.push(bw(typical.slice(0,i)));
 const metrics={er10:r(er(10)),er20:r(er(20)),er30:r(er(30)),adx:r(adx(rows)),slopeAtr:r(slopeAtr),slopeAbs:Math.abs(slopeAtr),emaStack:r(stack),atr:r(atr),atrRatio:r(atrRatio),atrRank:r(atrRank),realizedRatio:r(realizedRatio),rangeAtr:r(rangeAtr),volumeRatio:r(volRatio),bbWidth:r(bbWidth),bbRank:r(pct(bbHist,bbWidth)),chop:r(chop(rows)),persistence:r(mean(closes.slice(-21).slice(1).map((x,i)=>Math.sign(x-closes[n-21+i])===Math.sign(closes[n-1]-closes[n-21])?1:0)))};
 const result=classify(metrics),frames=[];
 if(includeTimeframes)for(const h of higherTimeframes||[]){const z=analyzeMarketRegime(h.candles,{includeTimeframes:false});frames.push({timeframe:h.timeframe,status:z.status,state:z.state,bias:z.directionalBias||0,confidence:z.confidence||0});}
 const fresh=frames.filter(x=>x.status==='ready'),mtfBias=fresh.length?mean(fresh.map(x=>x.bias)):0,agreement=fresh.length?fresh.filter(x=>Math.sign(x.bias)===Math.sign(mtfBias)&&Math.abs(x.bias)>.12).length/fresh.length:0;
 const history=[];for(let i=Math.max(60,n-12);i<=n;i++){const q=classify({er20:er(20),adx:metrics.adx,slopeAtr:metrics.slopeAtr,slopeAbs:metrics.slopeAbs,emaStack:metrics.emaStack,persistence:metrics.persistence,chop:metrics.chop,atrRank:metrics.atrRank,volRatio:metrics.volumeRatio,rangeAtr:metrics.rangeAtr,realizedRatio:metrics.realizedRatio,bbRank:metrics.bbRank});history.push(q.state);}
 let age=1;for(let i=history.length-2;i>=0&&history[i]===result.state;i--)age++;
 const direction=result.directionalBias>.12?'up':result.directionalBias<-.12?'down':'neutral',transitionRisk=clamp((result.transitionRisk||0)+Math.abs((result.directionalBias||0)-mtfBias)*.08*(fresh.length?1:0));
 const state=result.state;
 return{status:'ready',model:'JPTI-MR-2.0',state,previousState:history.at(-2)||null,direction,directionalBias:result.directionalBias,confidence:result.confidence,probabilities:result.probabilities,runnerUp:result.runnerUp,transitionRisk:r(transitionRisk),regimeAgeBars:age,persistenceScore:r(clamp(Math.min(1,age/8)*.65+(result.confidence||0)*.35)),metrics,multiTimeframe:{timeframes:frames,coverage:fresh.length,total:frames.length,bias:r(mtfBias),agreement:r(agreement)},signals:{trend:metrics.adx>=20&&metrics.er20>=.3,range:state==='ranging',volatilityExpansion:metrics.atrRank>=.8||metrics.realizedRatio>=1.5,volatilityCompression:state==='compressed',volumeExpansion:metrics.volumeRatio>=1.8,trendExhaustion:metrics.adx>=35&&metrics.er10<.18},playbook:state.startsWith('trending')?'Trend continuation: favour pullbacks and structure-aligned setups.':state==='ranging'?'Range rotation: prioritise range extremes and confirmed rejection.':state==='volatile'?'Volatility control: reduce exposure and demand stronger confirmation.':state==='compressed'?'Compression watch: wait for confirmed expansion and retest.':'Transition mode: lower conviction and wait for clearer evidence.',dataQuality:{candles:n,minimum:60,atrAvailable:Number.isFinite(atr),volumeAvailable:rows.slice(-20).some(c=>c[5]>0),timeframeCoverage:fresh.length},source:{module:'market-regime-engine',method:'multi-factor-rule-ensemble-v2',basis:'closed-ohlcv-derived',inputs:['Kaufman efficiency ratio','ADX','ATR-normalised regression slope','EMA 20/50/100 stack','ATR percentile and ratio','realised volatility ratio','Bollinger bandwidth percentile','choppiness','relative volume','directional persistence']},asOf:last[0]};
}
