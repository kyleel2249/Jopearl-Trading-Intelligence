import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFuturesComparison, calculateCrossVenueEdges } from './futures-intelligence.js';

const venue=(exchange,bid,ask,buyAvg=ask,sellAvg=bid)=>({exchange,status:'ok',
 prices:{last:(bid+ask)/2,mark:null,index:null,bid,ask},
 book:{buyDepth:{averagePrice:buyAvg,remainingBase:0},sellDepth:{averagePrice:sellAvg,remainingBase:0}}});

test('calculates net cross-venue edge after estimated two-sided fees',()=>{
 const edges=calculateCrossVenueEdges([venue('a',99,100),venue('b',102,103)],{takerFeeBps:5});
 const edge=edges.find(x=>x.buyExchange==='a'&&x.sellExchange==='b');
 assert.ok(edge);
 assert.equal(edge.estimatedFeesBps,10);
 assert.ok(edge.netEdgeBps>0);
});
test('depth-aware average prices are preferred over displayed top of book',()=>{
 const edges=calculateCrossVenueEdges([venue('a',99,100,101),venue('b',103,104,102,102)],{takerFeeBps:0});
 const edge=edges.find(x=>x.buyExchange==='a'&&x.sellExchange==='b');
 assert.equal(edge.buyPrice,101);
 assert.equal(edge.sellPrice,102);
 assert.equal(edge.executableAssessment,'depth_checked_estimate');
});
test('comparison never calls mark or index price a last price',()=>{
 const report=buildFuturesComparison('BTC/USDT:USDT',[venue('a',99,100),venue('b',101,102)],{takerFeeBps:6});
 assert.equal(report.priceConsensus.medianLast,100.5);
 assert.equal(report.safety.liveExecutionEnabled,false);
 assert.equal(report.safety.automaticExecutionEnabled,false);
});
test('insufficient book depth is explicitly labelled',()=>{
 const a=venue('a',99,100);a.book.buyDepth.remainingBase=1;
 const b=venue('b',102,103);b.book.sellDepth.remainingBase=1;
 const edge=calculateCrossVenueEdges([a,b],{takerFeeBps:0}).find(x=>x.buyExchange==='a'&&x.sellExchange==='b');
 assert.equal(edge.executableAssessment,'insufficient_top_depth');
});
