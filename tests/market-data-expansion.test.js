import test from "node:test";
import assert from "node:assert/strict";
import {parseBisDataflows,parseBisSdmxObservations,normalizeBisMonitor} from "../src/chart-intelligence/bis-flows.js";
import {normalizeBitqueryWalletLabels,fetchBitqueryWalletLabels,aggregateAttributedWalletSwapFlows} from "../src/chart-intelligence/wallet-attribution.js";
import {parseFomcCalendar,parseBoeMpcCalendar,parseEcbCalendar,parseBojCalendar,parseEiaReleaseSchedule} from "../src/chart-intelligence/event-calendars.js";

test("BIS catalogue discovers all dataflows and flags financial datasets",()=>{
 const rows=parseBisDataflows({structure:{dataflows:[{id:"WS_CBPOL",agencyID:"BIS",version:"1.0",name:[{lang:"en","#text":"Central bank policy rates"}]},{id:"WS_LBS_D_PUB",agencyID:"BIS",version:"1.0",name:[{lang:"en","#text":"Locational banking statistics"}]},{id:"OTHER",agencyID:"BIS",version:"1.0",name:[{lang:"en","#text":"General demographic statistics"}]}]}});
 assert.equal(rows.length,3);assert.equal(rows.filter(x=>x.relevance==="financial-context").length,2);assert.equal(rows[0].flowRef,"BIS,WS_CBPOL,1.0");
});
test("BIS SDMX observations preserve time, series, reporter and counterparty dimensions",()=>{
 const payload={structure:{dimensions:{series:[{id:"REF_AREA",values:[{id:"US"}]},{id:"COUNTERPART_AREA",values:[{id:"GB"}]},{id:"MEASURE",values:[{id:"CLAIMS"}]}],observation:[{id:"TIME_PERIOD",values:[{id:"2025-Q4"}]}]}},dataSets:[{series:{"0:0:0":{observations:{"0":[123.4]}}}}]};
 const rows=parseBisSdmxObservations(payload,{dataflowId:"WS_LBS_D_PUB"});assert.equal(rows.length,1);assert.equal(rows[0].reporter,"US");assert.equal(rows[0].counterparty,"GB");assert.equal(rows[0].period,"2025-Q4");assert.equal(rows[0].value,123.4);
});
test("BIS monitor reports catalogue coverage and scanned series",()=>{
 const result=normalizeBisMonitor({catalogue:[{id:"A",relevance:"financial-context"},{id:"B",relevance:"financial-context"},{id:"C",relevance:"general-statistics"}],datasets:[{id:"A",status:"ready",seriesCount:5,observations:[]}],now:Date.UTC(2026,0,1)});
 assert.equal(result.totalDataflows,3);assert.equal(result.financialDataflows,2);assert.equal(result.seriesObserved,5);assert.equal(result.coveragePct,50);
});
test("Bitquery labels are provider-attributed, never upgraded to verified",()=>{
 const labels=normalizeBitqueryWalletLabels([{Address:"0x1111111111111111111111111111111111111111",Chain:"ethereum",Label:{Type:"cex-hot-wallet",Value:"Example Exchange hot wallet"},RecordedAt:"2026-11-25T00:00:00Z"}]);
 assert.equal(labels.length,1);assert.equal(labels[0].providerAttributed,true);assert.equal(labels[0].verified,false);assert.equal(labels[0].entityName,"Example Exchange hot wallet");
});
test("Bitquery enrichment batches observed addresses and aggregates provider labels",async()=>{
 let calls=0;const mock=async(url,init)=>{calls++;const body=JSON.parse(init.body);assert.equal(body.variables.addresses.length,1);return{ok:true,json:async()=>({data:{Metadata:{Labels:[{Address:body.variables.addresses[0],Chain:"ethereum",Label:{Type:"cex-hot-wallet",Value:"Exchange X"},RecordedAt:"2026-11-25T00:00:00Z"}]}}})};};
 const trades=[{chainId:"eth",trader:"0x2222222222222222222222222222222222222222",timestamp:Date.now(),side:"buy",amountUsd:100}];
 const result=await fetchBitqueryWalletLabels(trades,{apiToken:"test",fetchImpl:mock});assert.equal(calls,1);assert.equal(result.labels.length,1);
 const flow=aggregateAttributedWalletSwapFlows(trades,result.labels,{now:Date.now()});assert.equal(flow.providerAttributedTrades,1);assert.equal(flow.verifiedTrades,0);assert.equal(flow.netflowUsd,100);
});
test("FOMC and BoE official calendar parsers create dated events",()=>{
 const now=Date.UTC(2026,0,1);const fomc=parseFomcCalendar("2026 FOMC Meetings January 27-28 March 17-18",{now});assert.equal(fomc.length,2);assert.equal(fomc[0].importance,"critical");
 const boe=parseBoeMpcCalendar("2026 confirmed dates Thursday 5 February Thursday 19 March",{now});assert.equal(boe.length,2);assert.equal(boe[0].country,"GB");
});
test("ECB and BoJ calendar parsers retain official meeting source",()=>{
 const now=Date.UTC(2026,0,1);const ecb=parseEcbCalendar("16/12/2026 Governing Council of the ECB: monetary policy meeting in Frankfurt",{now});assert.equal(ecb.length,1);assert.equal(ecb[0].country,"EA");
 const boj=parseBojCalendar("2026 Jan. 22 (Thurs.), 23 (Fri.)",{now});assert.ok(boj.length>=1);assert.equal(boj[0].country,"JP");
});
test("EIA release schedule uses alternate release date and time columns",()=>{
 const html="<table><tr><th>Week ending</th><th>Alternate release date</th><th>Release day</th><th>Release time</th></tr><tr><td>January 16, 2026</td><td>January 22, 2026</td><td>Thursday</td><td>12:00 p.m.</td></tr></table>";
 const rows=parseEiaReleaseSchedule(html,{now:Date.UTC(2026,0,1)});assert.equal(rows.length,1);assert.equal(rows[0].category,"energy");
});
