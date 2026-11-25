// BIS SDMX catalogue crawler and bounded all-dataflow observer.
// Discovers every published BIS dataflow, then rotates through financially relevant flows.
// Each selected dataflow is queried for its latest observation across available series.
const BIS_BASE="https://stats.bis.org/api/v1";
const BIS_DATA_ACCEPT="application/vnd.sdmx.data+json;version=1.0.0";
const BIS_STRUCTURE_ACCEPT="application/vnd.sdmx.structure+json;version=1.0.0";
const FINANCE_TERMS=/bank|credit|debt|liquid|rate|interest|policy|exchange|currency|foreign|fx|capital|securit|bond|derivative|financial|fund|portfolio|property|house|mortgage|payment|reserve|money|monetary|global|cross.border|lending|loan|leverage|bis|macro|yield|risk|stress|claim|deposit|asset|liabilit|equity|market|price|commodity|consumer|inflation|trade/i;
const num=v=>v!==null&&v!==undefined&&v!==""&&Number.isFinite(Number(v))?Number(v):null;
const periodTimestamp=period=>{const p=String(period||"");if(/^\d{4}-\d{2}$/.test(p)){const[y,m]=p.split("-").map(Number);return Date.UTC(y,m,0,23,59,59);}if(/^\d{4}-Q[1-4]$/i.test(p)){const m=p.match(/^(\d{4})-Q([1-4])$/i);return Date.UTC(Number(m[1]),Number(m[2])*3,0,23,59,59);}if(/^\d{4}$/.test(p))return Date.UTC(Number(p),11,31,23,59,59);const t=Date.parse(p);return Number.isFinite(t)?t:null;};
function values(dims,key){return String(key||"").split(":").map((n,i)=>dims[i]?.values?.[Number(n)]?.id||dims[i]?.values?.[Number(n)]?.name||null);}
export function parseBisDataflows(payload){
 const candidates=[];
 const visit=node=>{if(!node||typeof node!=="object")return;if(Array.isArray(node)){for(const x of node)visit(x);return;}
  if(typeof node.id==="string"&&(node.agencyID||node.agency||node.version)&&((node.name)||(node.names)||(node.structure)))candidates.push(node);
  for(const[k,v]of Object.entries(node))if(["dataflow","dataflows","Dataflow","Dataflows","structures","structure"].includes(k))visit(v);
 };
 visit(payload);const seen=new Set();
 return candidates.map(x=>{const id=String(x.id),agency=String(x.agencyID||x.agency||"BIS"),version=String(x.version||"latest"),name=Array.isArray(x.name)?(x.name.find(n=>n.lang==="en")?.["#text"]||x.name[0]?.["#text"]||id):typeof x.name==="string"?x.name:Array.isArray(x.names)?(x.names[0]?.value||x.names[0]?.name||id):id,description=Array.isArray(x.description)?(x.description.find(n=>n.lang==="en")?.["#text"]||x.description[0]?.["#text"]||""):String(x.description||"");return{id,agency,version,name:String(name),description:String(description),flowRef:id.includes(",")?id:[agency,id,version].join(","),url:"https://stats.bis.org/api/v1/dataflow/"+encodeURIComponent([agency,id,version].join(","))};})
 .filter(x=>{const k=x.agency+":"+x.id+":"+x.version;if(seen.has(k))return false;seen.add(k);return true;})
 .map(x=>({...x,relevance:FINANCE_TERMS.test(x.id+" "+x.name+" "+x.description)?"financial-context":"general-statistics"}))
 .sort((a,b)=>(a.relevance==="financial-context"?0:1)-(b.relevance==="financial-context"?0:1)||a.id.localeCompare(b.id));
}
export function parseBisSdmxObservations(payload,{dataflowId=null}={}){
 const structure=payload?.structure||payload?.structures?.[0]||payload?.data?.structures?.[0]||payload?.data?.structure;
 const dataset=payload?.dataSets?.[0]||payload?.data?.dataSets?.[0],seriesRoot=dataset?.series||{};
 const seriesDims=structure?.dimensions?.series||[],obsDims=structure?.dimensions?.observation||[];
 const periodIndex=Math.max(0,obsDims.findIndex(d=>/TIME_PERIOD|TIME|PERIOD/i.test(String(d.id||d.name||"")))),rows=[];
 for(const[seriesKey,series]of Object.entries(seriesRoot)){const sv=values(seriesDims,seriesKey),meta={};seriesDims.forEach((d,i)=>{const id=String(d.id||d.name||"").toUpperCase(),v=sv[i];if(/REF_AREA|REPORTER|L_REP_CTY/.test(id))meta.reporter=v;if(/COUNTERPART_AREA|COUNTERPARTY|L_CP_COUNTRY/.test(id))meta.counterparty=v;if(/MEASURE|INDICATOR|SERIES|SUBJECT/.test(id))meta.measure=v;if(/UNIT|DENOM/.test(id))meta.unit=v;if(/FREQ|FREQUENCY/.test(id))meta.frequency=v;if(/CURRENCY|CURR/.test(id))meta.currency=v;});
  for(const[obsKey,raw]of Object.entries(series.observations||{})){const oi=String(obsKey).split(":").map(Number),idx=oi[periodIndex]??oi[0]??0,dim=obsDims[periodIndex]||obsDims[0],period=dim?.values?.[idx]?.id||dim?.values?.[idx]?.name||String(idx),value=num(Array.isArray(raw)?raw[0]:raw);if(value!==null)rows.push({dataflowId,seriesKey,period,value,...meta});}}
 if(rows.length)return rows;
 const compact=payload?.data?.dataSets?.[0],dims=payload?.data?.structures?.[0]?.dimensions||payload?.structure?.dimensions;
 if(compact?.observations&&dims){const od=dims.observation||[],pi=Math.max(0,od.findIndex(d=>/TIME_PERIOD|TIME|PERIOD/i.test(String(d.id||d.name||""))));for(const[k,raw]of Object.entries(compact.observations)){const oi=k.split(":").map(Number),ix=oi[pi]??oi[0]??0,period=od[pi]?.values?.[ix]?.id||od[pi]?.values?.[ix]?.name||String(ix),value=num(Array.isArray(raw)?raw[0]:raw);if(value!==null)rows.push({dataflowId,seriesKey:"compact:"+k,period,value});}}
 return rows;
}
export function normalizeBisMonitor({catalogue=[],datasets=[],now=Date.now(),totalDataflows=null,cursor=0,nextCursor=0}={}){
 const observations=datasets.flatMap(x=>x.observations||[]).sort((a,b)=>String(a.period).localeCompare(String(b.period)));
 const latest=[...observations].sort((a,b)=>(periodTimestamp(b.period)||0)-(periodTimestamp(a.period)||0))[0]||null;
 const financial=catalogue.filter(x=>x.relevance==="financial-context"),scanned=datasets.filter(x=>x.status==="ready").length;
 const seriesCount=datasets.reduce((n,x)=>n+(x.seriesCount||x.observations?.length||0),0);
 return{status:scanned?"ready":catalogue.length?"partial":"unavailable",source:"Bank for International Settlements SDMX catalogue",catalogueStatus:catalogue.length?"ready":"unavailable",generatedAt:new Date(now).toISOString(),
  totalDataflows:totalDataflows??catalogue.length,financialDataflows:financial.length,scannedDataflows:datasets.length,successfulDataflows:scanned,seriesObserved:seriesCount,coveragePct:financial.length?Number((scanned/financial.length*100).toFixed(2)):0,cursor,nextCursor,latest,observations:observations.slice(-500),
  datasets:datasets.map(x=>({id:x.id,name:x.name,status:x.status,seriesCount:x.seriesCount||0,latestPeriod:x.latestPeriod||null,error:x.error||null})),
  methodology:"Complete BIS dataflow catalogue discovery with rotating observation scans across all financially relevant dataflows. Each selected flow requests the latest observation across its available series. BIS data is low-frequency macro-financial context, not tick-level exchange flow."};
}
export async function fetchBisFlows({fetchImpl=fetch,now=Date.now(),env={},batchSize=6,cursor=null}={}){
 const catalogueKey="jpti:bis:dataflow-catalogue:v2",cursorKey="jpti:bis:monitor-cursor:v2";let catalogue=null;
 if(env.JPTI_KV){try{const cached=await env.JPTI_KV.get(catalogueKey,"json");if(cached?.items&&now-Number(cached.cachedAt||0)<86400000)catalogue=cached.items;}catch{}}
 const get=async(url,accept)=>{const r=await fetchImpl(url,{headers:{accept,"user-agent":"JPTI-Market-Intelligence/1.0"}});if(!r.ok)throw new Error("BIS HTTP "+r.status);return r.json();};
 if(!catalogue){try{const payload=await get(BIS_BASE+"/dataflow/BIS",BIS_STRUCTURE_ACCEPT);catalogue=parseBisDataflows(payload);if(env.JPTI_KV&&catalogue.length)try{await env.JPTI_KV.put(catalogueKey,JSON.stringify({cachedAt:now,items:catalogue}),{expirationTtl:86400});}catch{}}catch(error){return{status:"offline",source:"BIS SDMX",catalogueStatus:"offline",reason:String(error?.message||error).slice(0,180),totalDataflows:0,financialDataflows:0,scannedDataflows:0,seriesObserved:0,observations:[]};}}
 const financial=catalogue.filter(x=>x.relevance==="financial-context");let start=Number.isInteger(cursor)?Math.max(0,cursor):0;
 if(cursor===null&&env.JPTI_KV){try{start=Number(await env.JPTI_KV.get(cursorKey)||0)||0;}catch{}}
 if(financial.length)start%=financial.length;
 const count=Math.max(1,Math.min(12,Number(batchSize)||6)),selected=Array.from({length:Math.min(count,financial.length)},(_,i)=>financial[(start+i)%financial.length]);
 const datasets=await Promise.all(selected.map(async flow=>{const dataKey="jpti:bis:dataflow-observations:v1:"+flow.id;if(env.JPTI_KV){try{const hit=await env.JPTI_KV.get(dataKey,"json");if(hit?.body&&now-Number(hit.cachedAt||0)<21600000)return hit.body;}catch{}}try{const flowRef=flow.flowRef||[flow.agency,flow.id,flow.version].join(",");const url=BIS_BASE+"/data/"+encodeURIComponent(flowRef)+"/all/all?lastNObservations=1";const payload=await get(url,BIS_DATA_ACCEPT);const observations=parseBisSdmxObservations(payload,{dataflowId:flow.id});const body={id:flow.id,name:flow.name,status:observations.length?"ready":"empty",seriesCount:new Set(observations.map(x=>x.seriesKey)).size,latestPeriod:observations.map(x=>x.period).sort().at(-1)||null,observations};if(env.JPTI_KV)try{await env.JPTI_KV.put(dataKey,JSON.stringify({cachedAt:now,body}),{expirationTtl:21600});}catch{}return body;}catch(error){return{id:flow.id,name:flow.name,status:"offline",seriesCount:0,observations:[],error:String(error?.message||error).slice(0,180)};}}));
 const next=(start+selected.length)%Math.max(1,financial.length);if(cursor===null&&env.JPTI_KV){try{await env.JPTI_KV.put(cursorKey,String(next),{expirationTtl:31536000});}catch{}}
 const result=normalizeBisMonitor({catalogue,datasets,now,totalDataflows:catalogue.length,cursor:start,nextCursor:next});
 result.sources=[{name:"BIS complete dataflow catalogue",status:"live",count:catalogue.length},{name:"BIS financial dataflow observations",status:datasets.some(x=>x.status==="ready")?"live":"offline",count:result.seriesObserved},{name:"BIS SDMX v1 API",status:"live",url:"https://stats.bis.org/api-doc/v1/"}];
 result.failures=datasets.filter(x=>x.status==="offline").map(x=>({id:x.id,error:x.error}));result.nextBatch={cursor:next,batchSize:selected.length,remaining:Math.max(0,financial.length-selected.length),complete:financial.length>0&&next===0};return result;
}
