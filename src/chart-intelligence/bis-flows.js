// BIS SDMX adapter. The dataset/series URL is configured explicitly; no undocumented series is guessed.
const BIS_HOST="stats.bis.org";
function periodTimestamp(period){
  const p=String(period||"");
  if(/^\d{4}-\d{2}$/.test(p))return Date.parse(p+"-01T00:00:00Z");
  if(/^\d{4}-Q[1-4]$/i.test(p)){const m=p.match(/^(\d{4})-Q([1-4])$/i);return Date.UTC(Number(m[1]),(Number(m[2])-1)*3,1);}
  if(/^\d{4}$/.test(p))return Date.UTC(Number(p),0,1);
  const t=Date.parse(p);return Number.isFinite(t)?t:null;
}
function sdmxJsonRows(payload){
  const ds=payload?.dataSets?.[0],structure=payload?.structure;
  if(!ds?.series||!structure?.dimensions)return[];
  const obsDims=structure.dimensions.observation||[],seriesDims=structure.dimensions.series||[];
  const periodDim=obsDims.findIndex(d=>/TIME_PERIOD|TIME|PERIOD/i.test(d.id||d.name||""));
  const dimensionValues=(dims,key)=>String(key||"").split(":").map((index,i)=>dims[i]?.values?.[Number(index)]?.id||dims[i]?.values?.[Number(index)]?.name||null);
  const rows=[];
  for(const [seriesKey,series] of Object.entries(ds.series)){
    const seriesValues=dimensionValues(seriesDims,seriesKey),meta={};
    seriesDims.forEach((d,i)=>{const id=String(d.id||d.name||"").toUpperCase();if(/REF_AREA|REPORTER/.test(id))meta.reporter=seriesValues[i];if(/COUNTERPART_AREA|COUNTERPARTY/.test(id))meta.counterparty=seriesValues[i];if(/MEASURE|INDICATOR/.test(id))meta.measure=seriesValues[i];if(/UNIT/.test(id))meta.unit=seriesValues[i];});
    for(const [obsKey,value] of Object.entries(series.observations||{})){
      const indices=String(obsKey).split(":").map(Number),periodIndex=periodDim>=0?indices[periodDim]:indices[0],period=obsDims[periodDim>=0?periodDim:0]?.values?.[periodIndex]?.id||obsDims[periodDim>=0?periodDim:0]?.values?.[periodIndex]?.name||String(periodIndex);
      const numeric=Number(Array.isArray(value)?value[0]:value);
      if(Number.isFinite(numeric))rows.push({period,value:numeric,...meta});
    }
  }
  return rows;
}
export function normalizeBisFlows(payload,{now=Date.now(),maxAgeMs=45*24*60*60*1000}={}){
  const raw=Array.isArray(payload?.data)?payload.data:Array.isArray(payload?.observations)?payload.observations:sdmxJsonRows(payload);
  const observations=raw.map(x=>({period:String(x.period||x.TIME_PERIOD||x.time||""),value:Number(x.value??x.OBS_VALUE),unit:x.unit||x.UNIT_MEASURE||null,
    reporter:x.reporter||x.REF_AREA||null,counterparty:x.counterparty||x.COUNTERPART_AREA||null,measure:x.measure||x.MEASURE||null}))
    .filter(x=>x.period&&Number.isFinite(x.value)).sort((a,b)=>a.period.localeCompare(b.period));
  const latest=observations.at(-1)||null,previous=observations.at(-2)||null;
  const periodTs=latest?periodTimestamp(latest.period):null,ageMs=periodTs==null?null:Math.max(0,now-periodTs);
  return{status:latest?"ready":"unavailable",source:"Bank for International Settlements SDMX",dataset:payload?.dataset||payload?.structure?.name||null,
    observationCount:observations.length,latest,previous,change:latest&&previous?latest.value-previous.value:null,
    freshness:ageMs==null?"unknown":ageMs>maxAgeMs?"stale":"fresh",ageMs,observations:observations.slice(-120),
    methodology:"BIS cross-border banking observations are low-frequency, revised macro-financial context; they are not real-time exchange order flow."};
}
export async function fetchBisFlows({url,fetchImpl=fetch,now=Date.now(),maxAgeMs,env={}}={}){
  if(!url)return{status:"not-configured",source:"BIS SDMX",reason:"Set BIS_LBS_DATA_URL to a documented BIS SDMX dataset/series query."};
  const cacheKey="jpti:bis-sdmx:v1:"+await (async()=>{const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(url)));return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");})();
  if(env.JPTI_KV){try{const cached=await env.JPTI_KV.get(cacheKey,"json");if(cached?.body&&now-Number(cached.cachedAt||0)<3600000)return cached.body;}catch{/* live request remains available */}}
  let parsed;try{parsed=new URL(url);}catch{return{status:"invalid-config",reason:"BIS URL is invalid."};}
  if(parsed.protocol!=="https:"||parsed.hostname!==BIS_HOST)return{status:"blocked",reason:"Only HTTPS endpoints on stats.bis.org are accepted."};
  try{const response=await fetchImpl(parsed.toString(),{headers:{accept:"application/vnd.sdmx.data+json, application/json"}});if(!response.ok)throw new Error("BIS HTTP "+response.status);
    const data=await response.json(),body=normalizeBisFlows(data,{now,maxAgeMs});
    if(env.JPTI_KV){try{await env.JPTI_KV.put(cacheKey,JSON.stringify({cachedAt:now,body}),{expirationTtl:3600});}catch{/* optional cache */}}
    return body;}
  catch(error){return{status:"offline",source:"BIS SDMX",reason:error.message};}
}
