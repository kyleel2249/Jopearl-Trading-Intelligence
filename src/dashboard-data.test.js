import test from 'node:test';
import assert from 'node:assert/strict';
import {
  averageTrueRange, relativeVolume, atrRatio, liquidityPools, chartLevelsFromPools, upcomingEvents, eventRisk,
  volatilityRisk, spreadPercent, tradePlan, macroReading, MACRO_SERIES, nextMatchingEvent, timeAgo, utcClock,
  sessionRangeRows, performanceSummary, systemsStatus, cleanCandles, priceChange
} from './dashboard-data.js';

const base = 1700000000000;
const bars = (n, fn = i => ({ o: 100, h: 101, l: 99, c: 100, v: 1000 })) =>
  Array.from({ length: n }, (_, i) => { const x = fn(i); return [base + i * 900000, x.o, x.h, x.l, x.c, x.v]; });

test('cleanCandles drops malformed rows and sorts ascending', () => {
  const rows = cleanCandles([[2, 1, 2, 1, 1, 5], [1, 1, 2, 1, 1, 5], [3, 'x', 2, 1, 1, 5], [4, 1, 1, 2, 1, 5], [5, 1]]);
  assert.deepEqual(rows.map(r => r[0]), [1, 2]);
});

test('ATR is null without enough data and equals the constant range for flat bars', () => {
  assert.equal(averageTrueRange(bars(10)), null);
  assert.ok(Math.abs(averageTrueRange(bars(40)) - 2) < 1e-9);
});

test('relative volume compares the latest bar with the prior baseline', () => {
  const rows = bars(30, i => ({ o: 100, h: 101, l: 99, c: 100, v: i === 29 ? 3000 : 1000 }));
  assert.equal(relativeVolume(rows), 3);
  assert.equal(relativeVolume(bars(5)), null);
});

test('ATR ratio rises when recent ranges expand', () => {
  const calm = atrRatio(bars(120));
  const wide = atrRatio(bars(120, i => i > 100 ? { o: 100, h: 106, l: 94, c: 100, v: 1 } : { o: 100, h: 101, l: 99, c: 100, v: 1 }));
  assert.ok(Math.abs(calm - 1) < 1e-9);
  assert.ok(wide > 1.3);
});

test('liquidity pools find equal-high and equal-low clusters from prior bars only', () => {
  const rows = bars(40, i => ({ o: 100, h: i === 5 || i === 20 ? 110 : 101, l: i === 8 ? 90 : 99, c: 100, v: 1 }));
  rows.push([base + 99 * 900000, 100, 150, 50, 100, 1]); // in-progress bar must not set the pools
  const pools = liquidityPools(rows);
  assert.equal(pools.status, 'ready');
  assert.equal(pools.buySide.price, 110);
  assert.equal(pools.buySide.touches, 2);
  assert.equal(pools.sellSide.price, 90);
  assert.equal(chartLevelsFromPools(pools).length, 2);
  assert.equal(liquidityPools(bars(3)).status, 'insufficient');
  assert.deepEqual(chartLevelsFromPools({ status: 'insufficient' }), []);
});

test('calendar helpers keep only upcoming high/medium events and derive event risk', () => {
  const now = base;
  const ev = (title, hours, impact) => ({ title, impact, scheduledAt: new Date(now + hours * 3600000).toISOString() });
  const events = [ev('Past', -5, 'high'), ev('Low thing', 1, 'low'), ev('CPI', 2, 'high'), ev('Speech', 30, 'medium'), ev('Far', 100, 'high')];
  assert.deepEqual(upcomingEvents(events, now).map(e => e.title), ['CPI', 'Speech']);
  assert.equal(eventRisk(events, now).level, 'high');
  assert.equal(eventRisk([ev('Speech', 30, 'medium')], now).level, 'none');
  assert.equal(eventRisk(null, now).level, 'unknown');
  assert.equal(nextMatchingEvent([ev('FOMC Statement', 10, 'high')], /FOMC/i, now).title, 'FOMC Statement');
});

test('volatility risk regime maps ratio and event risk and never guesses without data', () => {
  assert.equal(volatilityRisk({ ratio: null }).level, 'UNAVAILABLE');
  assert.equal(volatilityRisk({ ratio: 1 }).level, 'NORMAL');
  assert.equal(volatilityRisk({ ratio: 1.4 }).level, 'CAUTION');
  assert.equal(volatilityRisk({ ratio: 1.0, eventLevel: 'high' }).level, 'CAUTION');
  assert.equal(volatilityRisk({ ratio: 2 }).level, 'HIGH');
  assert.equal(volatilityRisk({ ratio: 0.5 }).level, 'LOW');
});

test('spread percent requires a valid bid/ask pair', () => {
  assert.equal(spreadPercent({ bid: 100, ask: 100.1 }).toFixed(4), '0.1000');
  assert.equal(spreadPercent({ bid: 101, ask: 100 }), null);
  assert.equal(spreadPercent({}), null);
});

test('trade plan computes stops, targets, R:R and sizing for both sides, and rejects invalid input', () => {
  const buy = tradePlan({ side: 'buy', entry: 100, riskPercent: 1, stopPercent: 2, targetPercent: 4, equity: 10000 });
  assert.equal(buy.stopPrice, 98);
  assert.equal(buy.targetPrice, 104);
  assert.equal(buy.rewardRisk, 2);
  assert.equal(buy.riskAmount, 100);
  assert.equal(buy.notional, 5000);
  assert.equal(buy.quantity, 50);
  const sell = tradePlan({ side: 'sell', entry: 100, riskPercent: 1, stopPercent: 2, targetPercent: 4 });
  assert.equal(sell.stopPrice, 102);
  assert.equal(sell.targetPrice, 96);
  assert.equal(sell.notional, null);
  assert.equal(tradePlan({ entry: 100, riskPercent: 1, stopPercent: 0, targetPercent: 4 }), null);
  assert.equal(tradePlan({ entry: -1, riskPercent: 1, stopPercent: 1, targetPercent: 2 }), null);
});

test('macro readings: level, year-over-year and monthly change; missing data stays null', () => {
  const [fed, cpi, , nfp] = MACRO_SERIES;
  assert.equal(macroReading(fed, [{ date: '2026-10-01', value: '4.50' }]).display, '4.50%');
  const cpiObs = Array.from({ length: 14 }, (_, i) => ({ date: 'd' + i, value: String(i === 0 ? 312 : i === 12 ? 300 : 305) }));
  assert.equal(macroReading(cpi, cpiObs).display, '4.0%');
  assert.equal(macroReading(cpi, cpiObs.slice(0, 5)), null);
  assert.equal(macroReading(nfp, [{ date: 'a', value: '159228' }, { date: 'b', value: '159000' }]).display, '+228K');
  assert.equal(macroReading(fed, [{ date: 'a', value: '.' }]), null);
  assert.equal(macroReading(fed, undefined), null);
});

test('time helpers format relative time and the UTC clock', () => {
  assert.equal(timeAgo(base - 3 * 60000, base), '3m ago');
  assert.equal(timeAgo(base - 5 * 3600000, base), '5h ago');
  assert.equal(timeAgo('garbage', base), '');
  assert.deepEqual(utcClock(Date.UTC(2026, 3, 23, 14, 32, 17)), { time: '14:32:17 UTC', date: 'Apr 23, 2026' });
});

test('session range rows scale bars against the widest session and tolerate missing history', () => {
  const sessions = [{ id: 'london', name: 'London', active: true }, { id: 'tokyo', name: 'Tokyo', active: false }, { id: 'sydney', name: 'Sydney', active: false }];
  const analytics = { history: { london: { averageRange: 2, observations: 4 }, tokyo: { averageRange: 1, observations: 4 }, sydney: { averageRange: null, observations: 0 } } };
  const rows = sessionRangeRows(sessions, analytics, 100);
  assert.deepEqual(rows.map(r => r.barPercent), [100, 50, 0]);
  assert.equal(rows[2].rangePercent, null);
});

test('performance summary reads the first populated currency bucket and returns null without data', () => {
  assert.equal(performanceSummary(null), null);
  const s = performanceSummary({ byCurrency: [{ quoteCurrency: 'USDT', closedExitExecutions: 12, winRatePercent: 66.7, profitFactor: 1.82, maxDrawdownCurrency: 54, netRealizedPnl: 200 }] });
  assert.deepEqual(s, { quoteCurrency: 'USDT', closed: 12, winRate: 66.7, profitFactor: 1.82, maxDrawdown: 54, net: 200 });
});

test('systems status distinguishes offline, degraded and healthy states', () => {
  assert.equal(systemsStatus({ health: null, jobs: [] }).tone, 'bad');
  assert.equal(systemsStatus({ health: { status: 'ok' }, jobs: [{ status: 'live' }, { status: 'starting' }] }).tone, 'warn');
  assert.equal(systemsStatus({ health: { status: 'ok' }, jobs: [{ status: 'live' }] }).label, 'All Systems Operational');
});

test('systems status reports direct exchange mode honestly instead of healthy or offline', () => {
  const s = systemsStatus({ health: { status: 'degraded', directMode: true }, jobs: [] });
  assert.equal(s.tone, 'warn');
  assert.equal(s.label, 'Direct Exchange Mode');
});

test('price change is derived from last and percentage, and never invented', () => {
  assert.equal(priceChange({ last: 110, percentage: 10 }).toFixed(6), '10.000000');
  assert.equal(priceChange({ last: 90, percentage: -10 }).toFixed(6), '-10.000000');
  assert.equal(priceChange({ last: 5, percentage: 1, change: 0.2 }), 0.2);
  assert.equal(priceChange({ last: 5 }), null);
  assert.equal(priceChange({ last: 5, percentage: -100 }), null);
  assert.equal(priceChange({}), null);
});
