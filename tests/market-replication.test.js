import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeReplicationPlan, boundReplicationPlanToSubrequestBudget, marketTypesForExchange, selectReplicationMarkets,
  normalizeTickerObservation, normalizeCandleObservations, replicationObservationKey,
  detectCandleGaps, buildCrossExchangeConsensus
} from '../src/market-replication-engine.js';
import { createMarketReplicationHandler } from '../functions/api/replication.js';

const nowValue = Date.parse('2026-11-26T09:00:00.000Z');
const fixedNow = () => new Date(nowValue);

function makeDb() {
  const observations = new Map(), runs = new Map(), cursors = new Map();
  const db = {
    observations, runs, cursors,
    prepare(sql) {
      return {
        sql, args: [],
        bind(...args) { this.args = args; return this; },
        async run() {
          if (sql.startsWith('INSERT INTO jpti_market_replication_runs')) {
            const [runId, startedAt, plan, counts, errors] = this.args;
            runs.set(runId, { run_id: runId, status: 'running', started_at: startedAt, plan_json: plan, counts_json: counts, errors_json: errors });
          } else if (sql.startsWith('UPDATE jpti_market_replication_runs')) {
            const [status, finishedAt, duration, counts, errors, runId] = this.args;
            Object.assign(runs.get(runId), { status, finished_at: finishedAt, duration_ms: duration, counts_json: counts, errors_json: errors });
          } else if (sql.startsWith('INSERT INTO jpti_market_replication_cursors')) {
            cursors.set(this.args[0], this.args[1]);
          }
          return { meta: { changes: 1 } };
        },
        async all() {
          if (sql.includes('FROM jpti_market_observations WHERE')) {
            const [kind, ...rest] = this.args;
            const limit = rest.at(-1);
            const rows = [...observations.values()].filter(row => row.observation_kind === kind);
            return { results: rows.slice(-limit).reverse().map(row => ({ payload: row.payload })) };
          }
          if (sql.includes('FROM jpti_market_replication_runs')) return { results: [...runs.values()].reverse().slice(0, 5) };
          if (sql.includes('GROUP BY exchange')) return { results: [] };
          return { results: [] };
        },
        async first() {
          if (sql.includes('COUNT(*) AS observations')) return { observations: observations.size, exchanges: new Set([...observations.values()].map(x => x.exchange)).size, symbols: new Set([...observations.values()].map(x => x.symbol)).size, last_received_at: null };
          return null;
        }
      };
    },
    async batch(statements) {
      return statements.map(statement => {
        const [key, exchange, marketType, symbol, kind, timeframe, observedAt, receivedAt, payload, quality] = statement.args;
        const existed = observations.has(key);
        if (!existed) observations.set(key, { observation_key: key, exchange, market_type: marketType, symbol, observation_kind: kind, timeframe, observed_at: observedAt, received_at: receivedAt, payload, quality });
        return { meta: { changes: existed ? 0 : 1 } };
      });
    }
  };
  return db;
}

const ticker = { symbol: 'BTC/USDT', timestamp: nowValue - 1000, last: 90000, bid: 89999, ask: 90001, high: 91000, low: 88000, baseVolume: 100, quoteVolume: 9000000, percentage: 1.2 };
const candles = [[nowValue - 60000, 89000, 91000, 88000, 90000, 12], [nowValue - 120000, 88000, 90000, 87000, 89000, 10]];

test('replication plan bounds symbols, exchanges, market categories and timeframes', () => {
  const plan = normalizeReplicationPlan({ exchanges: ['BINANCE', 'bitget', 'unknown'], symbols: ['BTC/USDT', 'bad symbol'], marketTypes: ['spot', 'coin-m', 'unknown'], timeframes: ['1m', 'bad'], marketLimit: 99 });
  assert.deepEqual(plan.exchanges, ['binance', 'bitget']);
  assert.deepEqual(plan.symbols, ['BTC/USDT']);
  assert.deepEqual(plan.marketTypes, ['spot', 'coin-m']);
  assert.deepEqual(plan.timeframes, ['1m']);
  assert.equal(plan.limit, 20);
});

test('catalogue replication limit is independently bounded from live ticker sampling', () => {
  const plan = normalizeReplicationPlan({ marketLimit: 1, catalogLimit: 8 });
  assert.equal(plan.limit, 1);
  assert.equal(plan.catalogLimit, 8);
  assert.equal(normalizeReplicationPlan({ catalogLimit: 99 }).catalogLimit, 20);
});

test('replication planner stays within Cloudflare subrequest budget for all venue categories', () => {
  const plan = normalizeReplicationPlan({ exchanges: ['binance', 'bybit', 'okx', 'bitget'], timeframes: ['1m', '5m', '15m', '1h'], marketLimit: 10 });
  const bounded = boundReplicationPlanToSubrequestBudget(plan, 8, 45);
  assert.equal(bounded.limit, 1);
  assert.equal(bounded.timeframes.length, 3);
  assert.ok(bounded.requestBudget.estimatedSubrequests <= 45);
});

test('replication runner can isolate Bitget primary coverage while preserving supplemental venue plans', () => {
  const primary = normalizeReplicationPlan({}, { JPTI_REPLICATION_EXCHANGES: 'bitget' });
  const supplemental = normalizeReplicationPlan({}, { JPTI_REPLICATION_EXCHANGES: 'binance,bybit,okx' });
  assert.deepEqual(primary.exchanges, ['bitget']);
  assert.deepEqual(supplemental.exchanges, ['binance', 'bybit', 'okx']);
  assert.deepEqual(primary.marketTypes, ['spot', 'margin', 'usdt-m', 'coin-m', 'usdc-m']);
  assert.ok(supplemental.exchanges.every(exchange => marketTypesForExchange(exchange, supplemental.marketTypes).length === 1));
});

test('default allowlist covers Bitget USDT, inverse and USDC contract symbols', () => {
  const plan = normalizeReplicationPlan();
  assert.ok(plan.symbols.includes('BTC/USDT'));
  assert.ok(plan.symbols.includes('BTC/USD:BTC'));
  assert.ok(plan.symbols.includes('BTC/USDC:USDC'));
});

test('only Bitget receives the five supported public product categories', () => {
  assert.deepEqual(marketTypesForExchange('binance'), ['spot']);
  assert.deepEqual(marketTypesForExchange('bitget'), ['spot', 'margin', 'usdt-m', 'coin-m', 'usdc-m']);
});

test('market selection respects the configured base/quote allowlist and cap', () => {
  const rows = [{ symbol: 'ETH/USDT', active: true }, { symbol: 'BTC/USDT:USDT', active: true }, { symbol: 'DOGE/USDT', active: true }, { symbol: 'BTC/USD:BTC', active: true }, { symbol: 'BTC/USDT', active: false }];
  assert.deepEqual(selectReplicationMarkets(rows, ['BTC/USDT', 'ETH/USDT'], 5).map(x => x.symbol), ['BTC/USDT:USDT', 'ETH/USDT']);
});

test('ticker observations reject missing timestamps and negative prices', () => {
  assert.equal(normalizeTickerObservation({ exchange: 'binance', marketType: 'spot', symbol: 'BTC/USDT', ticker: { ...ticker, timestamp: null } }), null);
  assert.equal(normalizeTickerObservation({ exchange: 'binance', marketType: 'spot', symbol: 'BTC/USDT', ticker: { ...ticker, last: -1 } }), null);
  const row = normalizeTickerObservation({ exchange: 'binance', marketType: 'spot', symbol: 'BTC/USDT', ticker, receivedAt: nowValue });
  assert.equal(row.spreadPct > 0, true);
  assert.equal(row.quality.validSpread, true);
});

test('OHLCV observations validate candles, deduplicate timestamps and sort ascending', () => {
  const rows = normalizeCandleObservations({ exchange: 'bitget', marketType: 'spot', symbol: 'BTC/USDT', timeframe: '1m', candles: [...candles, candles[0], [nowValue, 1, 0, 2, 1, -1]], receivedAt: nowValue });
  assert.equal(rows.length, 2);
  assert.ok(Date.parse(rows[0].observedAt) < Date.parse(rows[1].observedAt));
  assert.equal(rows.every(row => row.quality.validOhlc), true);
});

test('candle gap detection reports missing intervals without fabricating candles', () => {
  const rows = normalizeCandleObservations({ exchange: 'binance', marketType: 'spot', symbol: 'BTC/USDT', timeframe: '1m', candles: [candles[1], [nowValue, 90000, 92000, 89000, 91000, 11]], receivedAt: nowValue });
  const report = detectCandleGaps(rows);
  assert.equal(report.gapCount, 1);
  assert.equal(report.missingCandles, 1);
});

test('cross-exchange consensus uses median and flags price outliers', () => {
  const rows = ['binance', 'bybit', 'okx'].map((exchange, index) => ({ exchange, marketType: 'spot', symbol: 'BTC/USDT', kind: 'ticker', last: [90000, 90010, 92000][index], observedAt: new Date(nowValue).toISOString(), receivedAt: new Date(nowValue).toISOString() }));
  const consensus = buildCrossExchangeConsensus(rows);
  assert.equal(consensus.length, 1);
  assert.equal(consensus[0].venueCount, 3);
  assert.equal(consensus[0].medianPrice, 90010);
  assert.equal(consensus[0].outliers[0].exchange, 'okx');
});

test('observation keys are stable and isolate exchange, product, symbol, kind and time', () => {
  const a = { exchange: 'bitget', marketType: 'spot', symbol: 'BTC/USDT', kind: 'ohlcv', timeframe: '1m', observedAt: new Date(nowValue).toISOString() };
  assert.equal(replicationObservationKey(a), replicationObservationKey({ ...a }));
  assert.notEqual(replicationObservationKey(a), replicationObservationKey({ ...a, exchange: 'binance' }));
});

test('replication write endpoint fails closed without a valid private token', async () => {
  const handler = createMarketReplicationHandler({ provider: { request: async () => null }, now: fixedNow, verifyToken: async () => ({ ok: false, status: 401, error: 'denied' }) });
  const response = await handler({ request: new Request('https://jpti.example/api/replication', { method: 'POST', body: '{}' }), env: { JPTI_DB: makeDb() } });
  assert.equal(response.status, 401);
});

test('replication acquires and durably deduplicates ticker and OHLCV observations', async () => {
  const db = makeDb();
  const provider = {
    async request(path) {
      if (path.includes('/markets?')) return { status: 200, body: { markets: [{ symbol: 'BTC/USDT', active: true }] } };
      if (path.includes('/ticker/')) return { status: 200, body: ticker };
      if (path.includes('/ohlcv/')) return { status: 200, body: { candles } };
      return { status: 404, body: { error: 'not found' } };
    }
  };
  const handler = createMarketReplicationHandler({ provider, now: fixedNow, verifyToken: async () => ({ ok: true }) });
  const request = () => new Request('https://jpti.example/api/replication', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-jpti-api-token': 'secret' },
    body: JSON.stringify({ exchanges: ['binance'], symbols: ['BTC/USDT'], timeframes: ['1m'], marketLimit: 1, candleLimit: 20 })
  });
  const first = await handler({ request: request(), env: { JPTI_DB: db } });
  const firstBody = await first.json();
  assert.equal(first.status, 200);
  assert.equal(firstBody.status, 'completed');
  assert.equal(firstBody.counts.inserted, 3);
  const second = await handler({ request: request(), env: { JPTI_DB: db } });
  const secondBody = await second.json();
  assert.equal(second.status, 200);
  assert.equal(secondBody.counts.inserted, 0);
  assert.equal(secondBody.counts.duplicates, 3);
  assert.equal(db.observations.size, 3);
  assert.equal(db.runs.size, 2);
});

test('Bitget derivatives retain native instrument IDs across ticker and candle requests', async () => {
  const db = makeDb();
  const requested = [];
  const provider = {
    async request(path) {
      requested.push(path);
      if (path.includes('/markets?')) return { status: 200, body: { markets: [{ id: 'BTCUSDT_UMCBL', symbol: 'BTC/USDT:USDT', active: true }] } };
      if (path.includes('/ticker/')) return { status: 200, body: { ...ticker, symbol: 'BTC/USDT:USDT' } };
      if (path.includes('/ohlcv/')) return { status: 200, body: { candles } };
      return { status: 404, body: { error: 'not found' } };
    }
  };
  const handler = createMarketReplicationHandler({ provider, now: fixedNow, verifyToken: async () => ({ ok: true }) });
  const response = await handler({ request: new Request('https://jpti.example/api/replication', { method: 'POST', body: JSON.stringify({ exchanges: ['bitget'], marketTypes: ['usdt-m'], symbols: ['BTC/USDT'], timeframes: ['1m'], marketLimit: 1 }) }), env: { JPTI_DB: db } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.counts.inserted, 3);
  assert.ok(requested.filter(path => path.includes('/ticker/') || path.includes('/ohlcv/')).every(path => path.includes('instrumentId=BTCUSDT_UMCBL')));
});

test('history endpoint reads persisted observations without exposing credentials', async () => {
  const db = makeDb();
  const provider = { request: async path => path.includes('/markets?') ? { status: 200, body: { markets: [{ symbol: 'BTC/USDT', active: true }] } } : path.includes('/ticker/') ? { status: 200, body: ticker } : { status: 200, body: { candles } } };
  const handler = createMarketReplicationHandler({ provider, now: fixedNow, verifyToken: async () => ({ ok: true }) });
  await handler({ request: new Request('https://jpti.example/api/replication', { method: 'POST', body: JSON.stringify({ exchanges: ['binance'], symbols: ['BTC/USDT'], timeframes: ['1m'], marketLimit: 1 }) }), env: { JPTI_DB: db } });
  const response = await handler({ request: new Request('https://jpti.example/api/replication?exchange=binance&symbol=BTC%2FUSDT&kind=ohlcv&timeframe=1m'), env: { JPTI_DB: db } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.count, 2);
  assert.equal(body.observations[0].exchange, 'binance');
});


test('replication history exposes authenticated D1 market instrument metadata for diagnostics',async()=>{
 const db=makeDb();
 const observedAt=new Date(nowValue-1000).toISOString();
 const receivedAt=new Date(nowValue).toISOString();
 db.observations.set('bitget-market-btc',{observation_key:'bitget-market-btc',exchange:'bitget',market_type:'spot',symbol:'BTC/USDT',observation_kind:'markets',timeframe:'',observed_at:observedAt,received_at:receivedAt,payload:JSON.stringify({exchange:'bitget',marketType:'spot',symbol:'BTC/USDT',kind:'markets',observedAt,receivedAt,id:'BTCUSDT',active:true,productCategory:'SPOT'})});
 const handler=createMarketReplicationHandler({provider:{request:async()=>null},now:fixedNow});
 const response=await handler({request:new Request('https://jpti.example/api/replication?exchange=bitget&kind=markets&marketType=spot&limit=20'),env:{JPTI_DB:db}});
 const body=await response.json();
 assert.equal(response.status,200);
 assert.equal(body.kind,'markets');
 assert.equal(body.count,1);
 assert.equal(body.observations[0].id,'BTCUSDT');
 assert.equal(body.observations[0].marketType,'spot');
});
