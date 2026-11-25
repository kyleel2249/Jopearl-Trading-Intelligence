// BIS SDMX adapter. The dataset/series URL is configured explicitly; no undocumented series is guessed.
const BIS_HOST="stats.bis.org";
export function normalizeBisFlows(payload,{now=Date.now(),maxAgeMs=45*24*60*60*1000}={}){
  const raw=Array.isArray(payload?.data)?payload.data:Array.isArray(payload?.observations)?payload.observations:[];
  const observations=raw.map(x=>({period:String(x.period||x.TIME_PERIOD||x.time||""),value:Number(x.value??x.OBS_VALUE),unit:x.unit||x.UNIT_MEASURE||null,
    reporter:x.reporter||x.REF_AREA||null,counterparty:x.counterparty||x.COUNTERPART_AREA||null,measure:x.measure||x.MEASURE||null}))
    .filter(x=>x.period&&Number.isFinite(x.value)).sort((a,b)=>a.period.localeCompare(b.period));
  const latest=observations.at(-1)||null,previous=observations.at(-2)||null;
  const ageMs=latest?.updatedAt?now-Date.parse(latest.updatedAt):null;
  return{status:latest?"ready":"unavailable",source:"Bank for International Settlements SDMX",dataset:payload?.dataset||payload?.structure?.name||null,
    observationCount:observations.length,latest,previous,change:latest&&previous?latest.value-previous.value:null,
    freshness:ageMs==null?"period-based":ageMs>maxAgeMs?"stale":"fresh",observations:observations.slice(-120),
    methodology:"BIS cross-border banking observations are low-frequency, revised macro-financial context; they are not real-time exchange order flow."};
}
export async function fetchBisFlows({url,fetchImpl=fetch,now=Date.now(),maxAgeMs}={}){
  if(!url)return{status:"not-configured",source:"BIS SDMX",reason:"Set BIS_LBS_DATA_URL to a documented BIS SDMX dataset/series query."};
  let parsed;try{parsed=new URL(url);}catch{return{status:"invalid-config",reason:"BIS URL is invalid."};}
  if(parsed.protocol!=="https:"||parsed.hostname!==BIS_HOST)return{status:"blocked",reason:"Only HTTPS endpoints on stats.bis.org are accepted."};
  try{const response=await fetchImpl(parsed.toString(),{headers:{accept:"application/vnd.sdmx.data+json, application/json"}});if(!response.ok)throw new Error("BIS HTTP "+response.status);
    const data=await response.json();return normalizeBisFlows(data,{now,maxAgeMs});}
  catch(error){return{status:"offline",source:"BIS SDMX",reason:error.message};}
}
