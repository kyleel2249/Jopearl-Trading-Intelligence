const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const quantile=(a,q)=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y),i=(s.length-1)*q,lo=Math.floor(i),hi=Math.ceil(i);return s[lo]+(s[hi]-s[lo])*(i-lo);};
const tfMs=tf=>({ '1m':60000,'3m':180000,'5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'2h':7200000,'4h':14400000,'6h':21600000,'8h':28800000,'12h':43200000,'1d':86400000,'3d':259200000,'1w':604800000,'1M':2592000000}[tf]||3600000);
function normalize(input){
 return (input||[]).map(c=>Array.isArray(c)?c:[c?.timestamp,c?.open,c?.high,c?.low,c?.close,c?.volume]).filter(c=>Array.isArray(c)&&c.length>=6).map(c=>c.slice(0,6).map(Number)).filter(c=>c.every(Number.isFinite)&&c[0]>0&&c[1]>0&&c[2]>=Math.max(c[1],c[3],c[4])&&c[3]<=Math.min(c[1],c[2],c[4])&&c[5]>=0);
}
function rng(seed){let s=(seed>>>0)||1;return()=>{s^=s<<13;s^=s>>>17;s^=s<<5;return (s>>>0)/4294967296;};}
function randn(random){const u=Math.max(1e-12,random()),v=random();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}
export function forecast24h(input,{symbol='BTC/USDT',exchange='bitget',timeframe='1h',now=Date.now(),simulations=1200}={}){
 const rows=normalize(input),last=rows.at(-1),price=last?.[4];
 if(rows.length<40||!Number.isFinite(price)||price<=0)return {status:'insufficient',message:'At least 40 valid candles are needed to model the range.',validCandles:rows.length};
 const barMs=tfMs(timeframe);if(barMs>86400000)return {status:'unsupported-timeframe',message:'Forecast horizon is shorter than the selected candle interval. Choose 1d or lower timeframe.',symbol,exchange,timeframe};const steps=Math.max(1,Math.min(1440,Math.ceil(86400000/barMs))),returns=[];
 for(let i=Math.max(1,rows.length-120);i<rows.length;i++){const r=Math.log(rows[i][4]/rows[i-1][4]);if(Number.isFinite(r))returns.push(r);}
 const sigma=Math.sqrt(mean(returns.map(x=>x*x))),drift=mean(returns),recent=returns.slice(-24),recentSigma=Math.sqrt(mean(recent.map(x=>x*x)))||sigma;
 const atrRows=rows.slice(-15);const atr=mean(atrRows.slice(1).map((c,i)=>Math.max(c[2]-c[3],Math.abs(c[2]-atrRows[i][4]),Math.abs(c[3]-atrRows[i][4]))));
 const realizedVol24=sigma*Math.sqrt(steps),regime=recentSigma>sigma*1.45?'volatility expansion':recentSigma<sigma*.65?'compression':'normal';
 const seed=rows.at(-1)[0]^Math.floor(price*100)^steps,random=rng(seed),highs=[],lows=[],closes=[],pathStore=[];
 const jumpThreshold=Math.max(sigma*2.4,1e-8);
 for(let s=0;s<simulations;s++){let p=price,h=price,l=price,track=[price];for(let j=0;j<steps;j++){let z=randn(random),jump=Math.abs(z)>3?z*sigma*1.6:0;const shock=(drift-.5*sigma*sigma)+sigma*z+jump;p*=Math.exp(shock);h=Math.max(h,p);l=Math.min(l,p);track.push(p);}highs.push(h);lows.push(l);closes.push(p);if(s<48)pathStore.push(track);}
 const medH=quantile(highs,.5),medL=quantile(lows,.5),h70=[quantile(highs,.15),quantile(highs,.85)],l70=[quantile(lows,.15),quantile(lows,.85)],h90=[quantile(highs,.05),quantile(highs,.95)],l90=[quantile(lows,.05),quantile(lows,.95)];
 const levels=[{label:'24H median high',price:medH,color:'#f59e0b'},{label:'24H median low',price:medL,color:'#60a5fa'},{label:'24H high · 70% band',price:h70[1],color:'#eab308'},{label:'24H low · 70% band',price:l70[0],color:'#3b82f6'},{label:'24H high · 90% band',price:h90[1],color:'#f97316'},{label:'24H low · 90% band',price:l90[0],color:'#818cf8'}];
 const pct=(v)=>Number((v/price-1)*100),probAbove=(level)=>highs.filter(x=>x>=level).length/simulations,probBelow=(level)=>lows.filter(x=>x<=level).length/simulations;
 const nearestUp=rows.slice(-60).map(c=>c[2]).filter(x=>x>price).sort((a,b)=>a-b)[0]??null,nearestDown=rows.slice(-60).map(c=>c[3]).filter(x=>x<price).sort((a,b)=>b-a)[0]??null;
 return {status:'ready',engine:'RFE Monte Carlo',symbol,exchange,timeframe,generatedAt:new Date(now).toISOString(),expiresAt:new Date(now+86400000).toISOString(),currentPrice:price,horizonHours:24,steps,simulations,regime,volatility:{perBarPercent:sigma*100,realized24hPercent:realizedVol24*100,recentPerBarPercent:recentSigma*100,atr,atrPercent:atr/price*100},forecast:{medianHigh:medH,medianLow:medL,medianClose:quantile(closes,.5),high70:h70,low70:l70,high90:h90,low90:l90,highPercent:pct(medH),lowPercent:pct(medL),midpoint:(medH+medL)/2},probabilities:{touchPriorHigh:nearestUp?probAbove(nearestUp):null,touchPriorLow:nearestDown?probBelow(nearestDown):null,upsideBeforeDownside:null},liquidityTargets:{above:nearestUp,below:nearestDown},scenarioPaths:pathStore,chartLevels:levels,dataQuality:{validCandles:rows.length,source:'exchange OHLCV',derivedFrom:'historical candle returns; Monte Carlo synthetic paths',limitations:['Forecast extrema are simulated, not guaranteed price levels.','No true order-flow, order-book, liquidation, macro or news inputs are included unless separately connected and verified.','Touch probabilities are uncalibrated model frequencies; they are not validated real-world probabilities.','Price-path sequence probability is approximate and path-dependent; it does not account for exchange outages or jumps beyond the modeled distribution.']}};
}
export default forecast24h;
