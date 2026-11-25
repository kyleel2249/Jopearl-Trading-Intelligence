// Wallet identity is only labelled verified when a cryptographically or registry-verifiable claim exists.
// A wallet's activity alone never proves that it belongs to an institution.
const EVM=/^0x[a-fA-F0-9]{40}$/;
const SOL=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const norm=(s)=>String(s||"").trim();
const allowed=new Set(["signed-attestation","official-entity-registry","provider-verified-label","exchange-published-proof"]);
export function assessWalletAttribution({chain,address,claims=[]}={}){
  const a=norm(address),c=norm(chain).toLowerCase();
  const valid=c==="solana"?SOL.test(a):EVM.test(a);
  if(!valid)return{status:"invalid-address",verified:false,confidence:0,chain:c,address:a,entity:null,evidence:[],reason:"Address format does not match the selected chain."};
  const evidence=(claims||[]).filter(x=>x&&allowed.has(x.type)&&x.verified===true&&x.source&&x.sourceUrl&&/^https:\/\//i.test(x.sourceUrl));
  const signed=evidence.some(x=>x.type==="signed-attestation"&&x.signatureVerified===true);
  const registry=evidence.some(x=>x.type==="official-entity-registry"&&x.registryRecordId);
  const exchange=evidence.some(x=>x.type==="exchange-published-proof"&&x.entityType==="exchange");
  const independent=new Set(evidence.map(x=>String(x.source).toLowerCase())).size;
  const verified=!!(signed||registry||exchange)&&independent>=1;
  const confidence=verified?Math.min(.99,.82+Math.min(.15,Math.max(0,independent-1)*.07)+(signed?.02:0)):Math.min(.45,evidence.length*.12);
  const entity=verified?(evidence.find(x=>x.entityName)?.entityName||null):null;
  return{status:verified?"verified":evidence.length?"unconfirmed-evidence":"unattributed",verified,confidence:Number(confidence.toFixed(3)),chain:c,address:a,entity,
    entityType:verified?(evidence.find(x=>x.entityType)?.entityType||"unknown"):null,
    evidence:evidence.map(x=>({type:x.type,source:x.source,sourceUrl:x.sourceUrl,verifiedAt:x.verifiedAt||null,recordId:x.registryRecordId||null})),
    reason:verified?"Attribution supported by explicit verified evidence.":"No qualifying ownership proof; address remains unattributed."};
}
export function aggregateAttributedWalletSwapFlows(trades,attributions,{now=Date.now(),maxAgeMs=24*60*60*1000}={}){
  const map=new Map((attributions||[]).filter(a=>a.verified).map(a=>[String(a.chain).toLowerCase()+":"+String(a.address).toLowerCase(),a]));
  const rows=(trades||[]).filter(t=>t&&t.trader&&Number.isFinite(Number(t.timestamp))&&now-Number(t.timestamp)<=maxAgeMs);
  let buyUsd=0,sellUsd=0,verifiedTrades=0;const entities=new Map();
  for(const t of rows){const attribution=map.get(String(t.chainId||t.chain).toLowerCase()+":"+String(t.trader).toLowerCase());if(!attribution?.verified)continue;
    const amount=Math.max(0,Number(t.amountUsd)||0);if(t.side==="buy")buyUsd+=amount;else if(t.side==="sell")sellUsd+=amount;else continue;
    verifiedTrades++;const key=attribution.entity||attribution.address;entities.set(key,(entities.get(key)||0)+(t.side==="buy"?amount:-amount));
  }
  const total=buyUsd+sellUsd,netflowUsd=buyUsd-sellUsd;
  return{status:verifiedTrades?"ready":"unavailable",basis:"verified-wallet-geckoterminal-swap-sample",buyUsd,sellUsd,netflowUsd,
    score:total?Number((netflowUsd/total).toFixed(4)):0,verifiedTrades,entities:[...entities].map(([entity,netflowUsd])=>({entity,netflowUsd})).sort((a,b)=>Math.abs(b.netflowUsd)-Math.abs(a.netflowUsd)).slice(0,25),
    coverage:{sampledTrades:rows.length,verifiedTrades},caveat:"Only swaps from explicitly verified wallet addresses are included. Sampled pools and provider coverage are incomplete; a verified address does not establish that all activity is institutional."};
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
