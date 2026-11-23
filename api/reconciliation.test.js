import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBalanceReconciliation } from './reconciliation.js';

test('reconciles spot fills and base/quote fees against a configured opening balance', () => {
  const events = [
    { kind:'ledger-transaction', eventType:'fill', accountId:'main', symbol:'BTC/USDT', side:'buy', quantity:1, price:100, fee:.01, feeCurrency:'BTC' },
    { kind:'ledger-transaction', eventType:'fill', accountId:'main', symbol:'BTC/USDT', side:'sell', quantity:.25, price:120, fee:1, feeCurrency:'USDT' }
  ];
  const result = calculateBalanceReconciliation({ events, balances:{total:{BTC:.74,USDT:929}}, openingBalances:{BTC:0,USDT:1000} });
  assert.equal(result.rows.find(x => x.currency === 'BTC').status, 'matched');
  assert.equal(result.rows.find(x => x.currency === 'USDT').status, 'matched');
  assert.equal(result.status, 'matched');
  assert.equal(result.complete, true);
});

test('never assumes a zero opening balance when no baseline is configured', () => {
  const result = calculateBalanceReconciliation({ events:[], balances:{total:{BTC:2}} });
  assert.equal(result.rows[0].status, 'baseline_missing');
  assert.equal(result.rows[0].impliedOpeningBalance, 2);
  assert.equal(result.complete, false);
});

test('reports a real balance difference when a baseline exists', () => {
  const result = calculateBalanceReconciliation({ events:[], balances:{total:{USDT:90}}, openingBalances:{USDT:100} });
  assert.equal(result.rows[0].status, 'mismatch');
  assert.equal(result.rows[0].difference, -10);
  assert.equal(result.status, 'mismatch');
});

test('marks unsupported cash-flow directions as unresolved instead of inventing movement', () => {
  const result = calculateBalanceReconciliation({ events:[{kind:'ledger-transaction',eventType:'transfer',accountId:'main',currency:'USDT',quantity:5}], balances:{total:{USDT:5}}, openingBalances:{USDT:0} });
  assert.equal(result.unresolvedEventCount, 1);
  assert.equal(result.complete, false);
});

test('does not treat an omitted exchange currency as a zero balance',()=>{
 const result=calculateBalanceReconciliation({events:[{kind:'ledger-transaction',eventType:'fill',accountId:'main',symbol:'BTC/USDT',side:'buy',quantity:1,price:100,fee:0,feeCurrency:'USDT'}],balances:{total:{USDT:900}},openingBalances:{BTC:0,USDT:1000}});
 const btc=result.rows.find(x=>x.currency==='BTC');
 assert.equal(btc.status,'exchange_balance_missing');
 assert.equal(btc.actualTotal,null);
 assert.equal(btc.impliedOpeningBalance,null);
 assert.equal(result.complete,false);
 assert.equal(result.status,'exchange_balance_incomplete');
});
