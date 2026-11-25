import test from 'node:test';
import assert from 'node:assert/strict';
import { replaySymbol, buildReplayRequest, fundingCost, metricsFromPnl, summarizeReplay, rankSummaries, COMPARABLE_PRODUCTS } from '../src/lib/backtest-compare.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, a + ' != ' + b);
const trade = (side, hours, pnl, entry = 100, quantity = 10) => ({ side, entryAt: '2026-01-01T00:00:00Z', exitAt: new Date(Date.parse('2026-01-01T00:00:00Z') + hours * 3600000).toISOString(), entry, quantity, pnl });

test('coin-margined and CFD products are not comparable; replay symbols drop the settle suffix', () => {
  assert.deepEqual(COMPARABLE_PRODUCTS, ['spot', 'margin', 'futures', 'usdc-futures']);
  assert.equal(replaySymbol('btc/usdt:usdt'), 'BTC/USDT');
  const request = buildReplayRequest({ candles: [], symbol: 'BTC/USDT:USDT', timeframe: '1h', feeBps: 6, slippageBps: 5, initialCapital: 10000, riskPercent: '0.5' });
  assert.equal(request.symbol, 'BTC/USDT');
  assert.equal(request.config.riskPercent, 0.5);
});

test('funding cost: longs pay and shorts receive positive funding, scaled by holding time', () => {
  near(fundingCost(trade('buy', 8, 0), 0.0001), 1000 * 0.0001);       // notional 1000, one 8h period
  near(fundingCost(trade('buy', 16, 0), 0.0001), 1000 * 0.0001 * 2);
  near(fundingCost(trade('sell', 8, 0), 0.0001), -1000 * 0.0001);
  assert.equal(fundingCost(trade('buy', 8, 0), null), 0);
});

test('metrics are computed from adjusted PnL with a hand-checked drawdown', () => {
  const m = metricsFromPnl([100, -50, -100, 200], 1000);
  assert.equal(m.trades, 4);
  assert.equal(m.winRatePercent, 50);
  near(m.profitFactor, 300 / 150);
  near(m.netPnl, 150);
  near(m.expectancy, 37.5);
  // equity 1000 -> 1100 (peak) -> 1050 -> 950 (trough) -> 1150: drawdown (1100-950)/1100
  near(m.maxDrawdownPercent, (150 / 1100) * 100, 1e-9);
  assert.equal(metricsFromPnl([], 1000).winRatePercent, null);
});

test('summaries subtract funding only for leveraged products', () => {
  const replay = { trades: [trade('buy', 8, 50), trade('buy', 8, -20)], overall: { netPnl: 30 }, outOfSample: { netPnl: 5, trades: 1 }, data: { candles: new Array(300).fill(0) } };
  const spot = summarizeReplay('spot', replay, { initialCapital: 10000, fundingRatePer8h: 0.001 });
  near(spot.fundingCost, 0); near(spot.netPnl, 30);
  const fut = summarizeReplay('futures', replay, { initialCapital: 10000, fundingRatePer8h: 0.001 });
  near(fut.fundingCost, 2);               // 2 trades x 1000 notional x 0.001
  near(fut.netPnl, 28);
  assert.equal(fut.candles, 300);
  assert.equal(fut.engineNetPnl, 30);
  assert.equal(summarizeReplay('futures', {}, { initialCapital: 100 }).trades, 0);
});

test('ranking orders by adjusted net PnL', () => {
  const ranked = rankSummaries([{ product: 'a', netPnl: 5, trades: 3 }, { product: 'b', netPnl: 9, trades: 1 }, { product: 'c', netPnl: 5, trades: 8 }]);
  assert.deepEqual(ranked.map((r) => r.product + r.rank), ['b1', 'c2', 'a3']);
});
