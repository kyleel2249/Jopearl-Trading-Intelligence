// Wallet identity is labelled verified only when a configured claim has explicit proof metadata and a traceable HTTPS source.
// JPTI validates the registry record shape; an operator must independently verify the source and proof before configuring it.
const EVM=/^0x[a-fA-F0-9]{40}$/;
const SOL=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const norm=(s)=>String(s||"").trim();

const BITQUERY_CHAIN_MAP={eth:"ethereum",ethereum:"ethereum",bsc:"bsc",bnb:"bsc",solana:"solana",base:"base",arbitrum:"arbitrum",optimism:"optimism",polygon:"polygon",avax:"avalanche-c",avalanche:"avalanche-c",tron:"tron",ton:"ton",hyperliquid:"hyperliquid"};
export function normalizeBitqueryWalletLabels(rows=[]){
 const map=new Map();
 for(const row of rows||[]){const address=norm(row?.Address||row?.address),chain=norm(row?.Chain||row?.chain).toLowerCase(),type=norm(row?.Label?.Type||row?.label?.type),value=norm(row?.Label?.Value||row?.label?.value),recordedAt=row?.RecordedAt||row?.recordedAt||null;
  if(!address||!chain||!value)continue;
  const key=chain+":"+(/^(0x)[a-f0-9]{40}$/i.test(address)?address.toLowerCase():address);
  const category=/cex|exchange|custod|institution|market-maker|otc|treasury|issuer|protocol|bridge|dex|lending|staking/i.test(type)?"entity":/scam|phishing|sanction|hacker|mixer|ransom|darknet|frozen/i.test(type)?"risk":"other";
  const current=map.get(key)||{chain,address,providerAttributed:false,verified:false,entityName:null,entityType:null,confidence:0.0,labels:[],evidence:[],source:"Bitquery Address Labels",sourceUrl:"https://docs.bitquery.io/docs/labels/address-labels-api/"};
  current.labels.push({type,value,recordedAt,category});if(category==="entity"){current.providerAttributed=true;current.entityName=current.entityName||value;current.entityType=current.entityType||type;current.confidence=Math.max(current.confidence,.72);}
  if(category==="risk")current.riskLabels=(current.riskLabels||[]).concat([{type,value,recordedAt}]);
  map.set(key,current);
 }
 return [...map.values()].map(x=>({...x,status:x.providerAttributed?"provider-attributed":"labelled-risk-or-other",evidence:[{provider:"Bitquery",url:x.sourceUrl,recordedAt:x.labels.map(l=>l.recordedAt).filter(Boolean).sort().at(-1)||null,method:"provider label; not cryptographic ownership proof"}]}));
}
export async function fetchBitqueryWalletLabels(trades,{apiToken,fetchImpl=fetch,maxAddresses=400}={}){
 if(!apiToken)return{status:"not-configured",labels:[],addressesScanned:0,source:"Bitquery Address Labels",reason:"Set BITQUERY_ACCESS_TOKEN to enable multi-chain wallet label enrichment."};
 const groups=new Map();
 for(const t of trades||[]){if(!t?.trader)continue;const chain=BITQUERY_CHAIN_MAP[String(t.chainId||t.chain||"").toLowerCase()];if(!chain)continue;const list=groups.get(chain)||new Set();list.add(/^(0x)[a-f0-9]{40}$/i.test(t.trader)?t.trader.toLowerCase():String(t.trader));groups.set(chain,list);}
 const labels=[],failures=[];let addressesScanned=0,calls=0;
 const query='query($addresses:[String!]!,$chain:String!){Metadata{Labels(where:{Address:{in:$addresses},Chain:{is:$chain}},limitBy:{by:[Address,Chain,Label_Type],count:1},orderBy:{descending:RecordedAt}){Address Chain Label{Type Value} RecordedAt}}}';
 for(const[chain,set]of groups){const addresses=[...set].slice(0,Math.max(0,maxAddresses-addressesScanned));for(let i=0;i<addresses.length;i+=100){const batch=addresses.slice(i,i+100);if(!batch.length)continue;try{const response=await fetchImpl("https://streaming.bitquery.io/graphql",{method:"POST",headers:{accept:"application/json","content-type":"application/json",authorization:"Bearer "+apiToken},body:JSON.stringify({query,variables:{addresses:batch,chain}})});if(!response.ok)throw new Error("Bitquery HTTP "+response.status);const payload=await response.json();if(payload.errors?.length)throw new Error(payload.errors.map(x=>x.message).join("; ").slice(0,180));const rows=payload.data?.Metadata?.Labels||[];labels.push(...normalizeBitqueryWalletLabels(rows));addressesScanned+=batch.length;calls++;}catch(error){failures.push({chain,error:String(error?.message||error).slice(0,180)});}}
  if(addressesScanned>=maxAddresses)break;
 }
 const dedup=new Map();for(const label of labels){const k=label.chain+":"+label.address.toLowerCase();const prev=dedup.get(k);if(!prev||label.labels.length>prev.labels.length)dedup.set(k,label);}
 return{status:dedup.size?"ready":failures.length?"partial":"empty",labels:[...dedup.values()],addressesScanned,calls,chains:[...groups.keys()],failures,source:"Bitquery Address Labels",sourceUrl:"https://docs.bitquery.io/docs/labels/address-labels-api/",caveat:"Provider labels are attributed intelligence, not cryptographic proof of wallet ownership. Unknown addresses remain unattributed; coverage is limited to wallet addresses observed in sampled DEX trades and provider coverage."};
}

const allowed=new Set(["signed-attestation","official-entity-registry","provider-verified-label","exchange-published-proof"]);
export function assessWalletAttribution({chain,address,claims=[]}={}){
  const a=norm(address),c=norm(chain).toLowerCase();
  const valid=c==="solana"?SOL.test(a):EVM.test(a);
  if(!valid)return{status:"invalid-address",verified:false,confidence:0,chain:c,address:a,entity:null,evidence:[],reason:"Address format does not match the selected chain."};
  const evidence=(claims||[]).filter(x=>x&&allowed.has(x.type)&&x.verified===true&&x.source&&x.sourceUrl&&/^https:\/\//i.test(x.sourceUrl)&&((x.type==="official-entity-registry"&&x.registryRecordId)||(x.type==="signed-attestation"&&x.signatureVerified===true&&x.attestationId)||(x.type==="provider-verified-label"&&x.providerLabelId)||(x.type==="exchange-published-proof"&&x.proofId)));
  const signed=evidence.some(x=>x.type==="signed-attestation"&&x.signatureVerified===true);
  const registry=evidence.some(x=>x.type==="official-entity-registry"&&x.registryRecordId);
  const exchange=evidence.some(x=>x.type==="exchange-published-proof"&&x.entityType==="exchange");
  const independent=new Set(evidence.map(x=>String(x.source).toLowerCase())).size;
  const verified=!!(signed||registry||exchange)&&independent>=1;
  const confidence=verified?Math.min(.99,.82+Math.min(.15,Math.max(0,independent-1)*.07)+(signed ? 0.02 : 0)):Math.min(.45,evidence.length*.12);
  const entity=verified?(evidence.find(x=>x.entityName)?.entityName||null):null;
  return{status:verified?"verified":evidence.length?"unconfirmed-evidence":"unattributed",verified,confidence:Number(confidence.toFixed(3)),chain:c,address:a,entity,
    entityType:verified?(evidence.find(x=>x.entityType)?.entityType||"unknown"):null,
    evidence:evidence.map(x=>({type:x.type,source:x.source,sourceUrl:x.sourceUrl,verifiedAt:x.verifiedAt||null,recordId:x.registryRecordId||null})),
    reason:verified?"Attribution supported by explicit verified evidence.":"No qualifying ownership proof; address remains unattributed."};
}
const canonicalChain=value=>{const c=String(value||"").toLowerCase();return BITQUERY_CHAIN_MAP[c]||c;};
export function aggregateAttributedWalletSwapFlows(trades,attributions,{now=Date.now(),maxAgeMs=24*60*60*1000}={}){
 const map=new Map((attributions||[]).filter(a=>a.verified||a.providerAttributed).map(a=>[canonicalChain(a.chain)+":"+String(a.address).toLowerCase(),a]));
 const rows=(trades||[]).filter(t=>t&&t.trader&&Number.isFinite(Number(t.timestamp))&&now-Number(t.timestamp)<=maxAgeMs);
 let buyUsd=0,sellUsd=0,verifiedTrades=0,providerAttributedTrades=0;const entities=new Map();
 for(const t of rows){const attribution=map.get(canonicalChain(t.chainId||t.chain)+":"+String(t.trader).toLowerCase());if(!attribution)continue;
  const amount=Math.max(0,Number(t.amountUsd)||0);if(t.side==="buy")buyUsd+=amount;else if(t.side==="sell")sellUsd+=amount;else continue;
  if(attribution.verified)verifiedTrades++;else if(attribution.providerAttributed)providerAttributedTrades++;
  const key=attribution.entity||attribution.entityName||attribution.address;entities.set(key,(entities.get(key)||0)+(t.side==="buy"?amount:-amount));
 }
 const total=buyUsd+sellUsd,netflowUsd=buyUsd-sellUsd,attributedTrades=verifiedTrades+providerAttributedTrades;
 return{status:attributedTrades?"ready":"unavailable",basis:"manual-verified-and-provider-attributed-geckoterminal-swap-sample",buyUsd,sellUsd,netflowUsd,score:total?Number((netflowUsd/total).toFixed(4)):0,verifiedTrades,providerAttributedTrades,attributedTrades,
  entities:[...entities].map(([entity,netflowUsd])=>({entity,netflowUsd})).sort((a,b)=>Math.abs(b.netflowUsd)-Math.abs(a.netflowUsd)).slice(0,25),
  coverage:{sampledTrades:rows.length,attributedTrades,verifiedTrades,providerAttributedTrades},caveat:"Manual proof-verified and third-party provider-labelled wallets are reported separately. Only observed swaps from sampled pools are counted; provider labels are not cryptographic proof and no identity is inferred for unknown addresses."};
}
export function aggregateAttributedWalletFlows(transfers,attributions,{asset=null,now=Date.now(),maxAgeMs=24*60*60*1000}={}){
  const map=new Map((attributions||[]).map(a=>[String(a.chain).toLowerCase()+":"+String(a.address).toLowerCase(),a]));
  const rows=(transfers||[]).filter(t=>t&&Number.isFinite(Number(t.timestamp))&&now-Number(t.timestamp)<=maxAgeMs&&(!asset||String(t.asset).toUpperCase()===String(asset).toUpperCase()));
  let inflow=0,outflow=0,verifiedCount=0,unattributedCount=0;
  const entities=new Map();
  for(const t of rows){
    const from=map.get(String(t.chain).toLowerCase()+":"+String(t.from).toLowerCase());
    const to=map.get(String(t.chain).toLowerCase()+":"+String(t.to).toLowerCase());
    const amount=Math.max(0,Number(t.usdValue)||0);
    if(from?.verified){outflow+=amount;verifiedCount++;const k=from.entity||from.address;entities.set(k,(entities.get(k)||0)-amount);}
    if(to?.verified){inflow+=amount;verifiedCount++;const k=to.entity||to.address;entities.set(k,(entities.get(k)||0)+amount);}
    if(!from?.verified&&!to?.verified)unattributedCount++;
  }
  const netflow=inflow-outflow,total=inflow+outflow;
  return{status:verifiedCount?"ready":"unavailable",basis:"verified-address-attribution-only",inflowUsd:inflow,outflowUsd:outflow,netflowUsd:netflow,
    score:total?Math.max(-1,Math.min(1,netflow/total)):0,verifiedTransferSides:verifiedCount,unattributedTransfers:unattributedCount,
    entities:[...entities].map(([entity,netflowUsd])=>({entity,netflowUsd})).sort((a,b)=>Math.abs(b.netflowUsd)-Math.abs(a.netflowUsd)).slice(0,25),
    caveat:"Only transfers touching explicitly verified addresses are attributed. Unknown counterparties, exchange omnibus wallets and internal transfers can distort net flows."};
}
