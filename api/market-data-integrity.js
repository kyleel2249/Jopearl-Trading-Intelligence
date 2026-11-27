const num=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const timeValue=v=>{const n=num(v);if(n!==null)return n;const parsed=Date.parse(String(v||''));return Number.isFinite(parsed)?parsed:null;};
export function assessFeedFreshness({timestamp,receivedAt=Date.now(),maxAgeMs=15000,maxFutureSkewMs=5000}={}) {
 const ts=timeValue(timestamp);
 if(ts===null) return {fresh:false,ageMs:null,reason:'timestamp_missing_or_invalid'};
 const ageMs=receivedAt-ts;
 if(ageMs < -maxFutureSkewMs) return {fresh:false,ageMs,reason:'future_timestamp'};
 if(ageMs>maxAgeMs) return {fresh:false,ageMs,reason:'stale'};
 return {fresh:true,ageMs,reason:'fresh'};
}
export function evaluateSequenceContinuity({previousSequence=null,firstSequence=null,lastSequence=null,snapshot=false}={}) {
 const previous=num(previousSequence),first=num(firstSequence),last=num(lastSequence);
 if(snapshot) return {valid:last!==null,action:last===null?'reject':'replace_snapshot',nextSequence:last,reason:last===null?'snapshot_sequence_missing':null};
 if(previous===null||last===null) return {valid:false,action:'recover_snapshot',nextSequence:previous,reason:'sequence_missing'};
 if(last<=previous) return {valid:last===previous,action:last===previous?'duplicate':'discard_old',nextSequence:previous,reason:last===previous?'duplicate':'out_of_order'};
 const expected=previous+1;
 if(first!==null&&first>expected) return {valid:false,action:'recover_snapshot',nextSequence:previous,reason:'sequence_gap',expected,received:first};
 if(first!==null&&last<expected) return {valid:false,action:'recover_snapshot',nextSequence:previous,reason:'sequence_does_not_bridge'};
 return {valid:true,action:'apply',nextSequence:last,reason:null};
}
export function assessCrossVenueSynchronization(quotes=[],{now=Date.now(),maxAgeMs=15000,maxSkewMs=3000,minVenues=2,outlierPct=1.5}={}) {
 const valid=(Array.isArray(quotes)?quotes:[]).map(q=>({...q,venue:String(q.venue||'').toLowerCase(),price:num(q.price),freshness:assessFeedFreshness({timestamp:q.timestamp,receivedAt:now,maxAgeMs})})).filter(q=>q.venue&&q.price>0&&q.freshness.fresh);
 const unique=[...new Map(valid.map(q=>[q.venue,q])).values()];
 if(unique.length<minVenues) return {synchronized:false,reason:'insufficient_fresh_venues',venueCount:unique.length,accepted:[],rejected:valid.map(q=>({venue:q.venue,reason:'insufficient_consensus'})),referencePrice:null,maxSkewMs:null};
 const prices=unique.map(q=>q.price).sort((a,b)=>a-b),mid=prices.length%2?prices[(prices.length-1)/2]:(prices[prices.length/2-1]+prices[prices.length/2])/2;
 const accepted=[],rejected=[];
 for(const q of unique) {const deviation=Math.abs(q.price-mid)/mid*100;(deviation>outlierPct?rejected:accepted).push({venue:q.venue,price:q.price,deviationPct:deviation});}
 const times=unique.map(q=>timeValue(q.timestamp)).filter(Number.isFinite),skew=times.length?Math.max(...times)-Math.min(...times):Infinity;
 return {synchronized:accepted.length>=minVenues&&skew<=maxSkewMs,reason:accepted.length<minVenues?'cross_venue_outlier':skew>maxSkewMs?'timestamp_skew':null,venueCount:unique.length,accepted,rejected,referencePrice:accepted.length?accepted.reduce((s,q)=>s+q.price,0)/accepted.length:null,maxSkewMs:Number.isFinite(skew)?skew:null};
}
