import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeOrderBook, normalizeOrderBookMessage } from './microstructure.js';

test('normalizes and sorts Bitget depth snapshots',()=>{
 const book=normalizeOrderBookMessage({data:[{ts:'1000',bids:[['99','2'],['100','1']],asks:[['102','1'],['101','3']]}]});
 assert.equal(book.bids[0].price,100); assert.equal(book.asks[0].price,101);
});
test('computes spread, notional imbalance and microprice from measured levels',()=>{
 const book={bids:[{price:100,size:10,notional:1000},{price:99,size:2,notional:198}],asks:[{price:101,size:2,notional:202},{price:102,size:2,notional:204}]};
 const result=analyzeOrderBook(book);
 assert.equal(result.status,'ready'); assert.equal(result.spread,1);
 assert.ok(result.imbalancePct>0); assert.ok(result.microprice>result.mid);
});
test('rejects crossed or empty books without inventing metrics',()=>{
 assert.equal(analyzeOrderBook({bids:[],asks:[]}).status,'unavailable');
 assert.equal(analyzeOrderBook({bids:[{price:101,size:1,notional:101}],asks:[{price:100,size:1,notional:100}]}).status,'invalid');
});
test('ignores malformed levels and rejects a crossed snapshot',()=>{
 assert.equal(normalizeOrderBookMessage({data:[{bids:[['101','1']],asks:[['100','1']]}]}),null);
});
