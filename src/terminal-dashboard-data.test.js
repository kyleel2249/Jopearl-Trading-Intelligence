import test from 'node:test';
import assert from 'node:assert/strict';
import {
  instrumentProfile, compactSymbol, formatPrice, zoneOffsetMinutes, sessionUtcWindow, intersectWindows, buildSessionStrip,
  killzoneSchedule, atrValue, volatilityRiskView, liquidityRanges, imbalanceLabel, fundingLabel, macroRows, upcomingCalendar,
  parseFeedDate, newsAndSpeakers, journalPerformance, sizeTicket, ticketLevels, systemStatus, earningsRows, utcClock, formatDuration
} from './terminal-dashboard-data.js';
import { TRADING_SESSIONS } from './session-intelligence.js';

const at = (iso) => Date.parse(iso);

test('instrument profile: FX pip, JPY pip, crypto points', () => {
  assert.equal(instrumentProfile('EUR/USDT', 1.13).pip, 0.0001);
  assert.equal(instrumentProfile('EUR/USDT', 1.13).unit, 'pips');
  assert.equal(instrumentProfile('USD/JPY', 150).pip, 0.01);
  const btc = instrumentProfile('BTC/USDT', 65000);
  assert.deepEqual([btc.pip, btc.unit], [1, 'pts']);
  assert.equal(compactSymbol('EUR/USDT'), 'EURUSDT');
  assert.equal(formatPrice(1.13474, instrumentProfile('EUR/USDT', 1.13)), '1.13474');
  assert.equal(formatPrice(null, btc), '—');
});

test('zone offsets are DST aware', () => {
  assert.equal(zoneOffsetMinutes(at('2026-01-15T12:00:00Z'), 'Europe/London'), 0);
  assert.equal(zoneOffsetMinutes(at('2026-07-15T12:00:00Z'), 'Europe/London'), 60);
  assert.equal(zoneOffsetMinutes(at('2026-01-15T12:00:00Z'), 'America/New_York'), -300);
  assert.equal(zoneOffsetMinutes(at('2026-07-15T12:00:00Z'), 'America/New_York'), -240);
  assert.equal(zoneOffsetMinutes(at('2026-01-15T12:00:00Z'), 'Australia/Sydney'), 660);
});

test('session UTC windows wrap midnight for Sydney', () => {
  const sydney = TRADING_SESSIONS.find((s) => s.id === 'sydney');
  const w = sessionUtcWindow(sydney, at('2026-01-15T12:00:00Z'));
  assert.equal(w.open, '21:00');
  assert.equal(w.close, '06:00');
  const london = TRADING_SESSIONS.find((s) => s.id === 'london');
  assert.deepEqual([sessionUtcWindow(london, at('2026-01-15T12:00:00Z')).open, sessionUtcWindow(london, at('2026-01-15T12:00:00Z')).close], ['08:00', '17:00']);
});

test('London / New York overlap in winter is 13:00-17:00 UTC', () => {
  const strip = buildSessionStrip(at('2026-01-15T14:30:00Z'));
  assert.equal(strip.overlap.open, '13:00');
  assert.equal(strip.overlap.close, '17:00');
  assert.equal(strip.overlap.active, true);
  assert.equal(strip.overlapActive, true);
  const later = buildSessionStrip(at('2026-01-15T18:00:00Z'));
  assert.equal(later.overlap.active, false);
  assert.equal(later.overlap.startsInMinutes, 19 * 60);
});

test('intersectWindows handles wrapped windows and disjoint windows', () => {
  const a = { openMinute: 21 * 60, closeMinute: 6 * 60 };
  const b = { openMinute: 0, closeMinute: 9 * 60 };
  const x = intersectWindows(a, b);
  assert.equal(x.open, '00:00');
  assert.equal(x.close, '06:00');
  assert.equal(intersectWindows({ openMinute: 60, closeMinute: 120 }, { openMinute: 300, closeMinute: 400 }), null);
});

test('killzone: active during London open, otherwise next upcoming', () => {
  const during = killzoneSchedule(at('2026-01-15T09:00:00Z'));
  assert.equal(during.active.name, 'London Open');
  assert.equal(during.active.label, '08:00 – 11:00');
  assert.ok(during.active.remainingMinutes > 0);
  const quiet = killzoneSchedule(at('2026-01-15T05:00:00Z'));
  assert.equal(quiet.active, null);
  assert.ok(quiet.next.startsInMinutes >= 0);
});

test('ATR ignores the in-progress candle and needs history', () => {
  const rows = Array.from({ length: 20 }, (_, i) => [i, 1, 1.002, 0.998, 1, 10]);
  assert.ok(Math.abs(atrValue(rows, 14) - 0.004) < 1e-9);
  assert.equal(atrValue(rows.slice(0, 5), 14), null);
});

test('volatility risk view maps event state and never fabricates', () => {
  const profile = instrumentProfile('EUR/USDT', 1.13);
  const none = volatilityRiskView({ eventRisk: null, ticker: null, candles: [], profile, sources: [] });
  assert.equal(none.state.label, 'UNAVAILABLE');
  assert.equal(none.eventRisk, 'Unavailable');
  assert.equal(none.spreadPips, null);
  const live = volatilityRiskView({
    eventRisk: { state: 'CAUTION', affectedEvents: [{ impact: 'high' }], dynamicVolatility: { relativeVolume: 1.6 } },
    ticker: { bid: 1.1347, ask: 1.13478 }, candles: [], profile, sources: [{ name: 'Forex Factory public calendar feed', status: 'live' }]
  });
  assert.equal(live.state.tone, 'warn');
  assert.equal(live.eventRisk, 'High');
  assert.equal(live.relativeVolume, 1.6);
  assert.ok(Math.abs(live.spreadPips - 0.8) < 0.01);
  assert.equal(volatilityRiskView({ eventRisk: { state: 'NORMAL', affectedEvents: [] }, profile, sources: [] }).eventRisk, 'Unavailable');
  assert.equal(volatilityRiskView({ eventRisk: { state: 'NORMAL', affectedEvents: [] }, profile, sources: [{ name: 'Forex Factory public calendar feed', status: 'live' }] }).eventRisk, 'None');
});

test('liquidity ranges, imbalance and funding labels', () => {
  const liquidity = { referencePrice: 1.135, pools: [
    { side: 'buy-side', level: 1.137, touches: 2 }, { side: 'buy-side', level: 1.1385, touches: 1 }, { side: 'buy-side', level: 1.14, touches: 1 },
    { side: 'sell-side', level: 1.132, touches: 2 }, { side: 'sell-side', level: 1.1335, touches: 1 }
  ] };
  const r = liquidityRanges(liquidity, 1.135);
  assert.deepEqual([r.buySide.low, r.buySide.high], [1.137, 1.1385]);
  assert.deepEqual([r.sellSide.low, r.sellSide.high], [1.132, 1.1335]);
  assert.equal(liquidityRanges({ pools: [] }, 1).buySide, null);
  assert.deepEqual(imbalanceLabel(68.4), { text: '+68% Buy', tone: 'up' });
  assert.equal(imbalanceLabel(-12).text, '-12% Sell');
  assert.equal(imbalanceLabel(null).text, '—');
  assert.equal(fundingLabel(0.0001), '+0.010%');
  assert.equal(fundingLabel(undefined), '—');
});

test('macro rows come only from supplied observations', () => {
  const empty = macroRows(null, [], at('2026-04-23T00:00:00Z'));
  assert.equal(empty.configured, false);
  assert.ok(empty.rows.every((row) => row.value === '—'));
  const m = macroRows({ indicators: [
    { id: 'FEDFUNDS', latest: '4.33', latestDate: '2026-03-01' }, { id: 'CPIAUCSL', yearOverYearPercent: 2.43 },
    { id: 'PCEPI', yearOverYearPercent: 2.6 }, { id: 'PAYEMS', latest: '159500', previous: '159272' }
  ] }, [{ title: 'FOMC Statement', scheduledAt: '2026-05-07T18:00:00Z' }, { title: 'FOMC Minutes', scheduledAt: '2026-04-01T18:00:00Z' }], at('2026-04-23T00:00:00Z'));
  assert.deepEqual(m.rows.map((r) => r.value), ['4.33%', '2.4%', '2.6%', '+228K']);
  assert.equal(m.nextFomc.label, 'May 7, 2026');
});

test('calendar filters by impact, currency and window', () => {
  const now = at('2026-04-23T13:00:00Z');
  const events = [
    { id: 1, title: 'Core Durable Goods', currency: 'USD', impact: 'high', scheduledAt: '2026-04-23T14:30:00Z', category: 'economic' },
    { id: 2, title: 'New Home Sales', currency: 'USD', impact: 'medium', scheduledAt: '2026-04-23T15:00:00Z', category: 'economic' },
    { id: 3, title: 'BOJ Rate', currency: 'JPY', impact: 'high', scheduledAt: '2026-04-23T14:00:00Z', category: 'economic' },
    { id: 4, title: 'Low thing', currency: 'USD', impact: 'low', scheduledAt: '2026-04-23T14:00:00Z', category: 'economic' },
    { id: 5, title: 'Old', currency: 'USD', impact: 'high', scheduledAt: '2026-04-22T14:00:00Z', category: 'economic' },
    { id: 6, title: 'Fed speaks', currency: 'USD', impact: 'high', scheduledAt: '2026-04-23T16:00:00Z', category: 'central-bank-speaker' }
  ];
  const rows = upcomingCalendar(events, 'EUR/USDT', now, 5);
  assert.deepEqual(rows.map((r) => r.id), [1, 2]);
  assert.equal(rows[0].time, '14:30');
});

test('feed dates and news/speaker merge', () => {
  assert.equal(parseFeedDate('20260423T143000Z'), Date.UTC(2026, 3, 23, 14, 30, 0));
  assert.equal(parseFeedDate('garbage'), null);
  const now = at('2026-04-23T15:00:00Z');
  const items = newsAndSpeakers({
    news: [{ id: 'a', title: 'ECB signals cautious approach', publishedAt: '20260423T143000Z', domain: 'x.com' }, { id: 'b', title: 'ECB signals cautious approach', publishedAt: '20260423T140000Z' }],
    calendar: [{ id: 'c', title: 'Fed Governor remarks', category: 'central-bank-speaker', scheduledAt: '2026-04-23T14:57:00Z', provider: 'official:Federal Reserve speeches' }, { id: 'd', title: 'Future speech', category: 'central-bank-speaker', scheduledAt: '2026-04-24T14:57:00Z' }]
  }, now, 5);
  assert.deepEqual(items.map((i) => i.id), ['c', 'a']);
  assert.equal(items[0].ago, '3m ago');
});

test('earnings rows keep only real upcoming events', () => {
  const rows = earningsRows([
    { symbol: 'AAPL', events: [{ scheduledAt: '2026-04-24T12:00:00Z', earningsMetrics: { releaseTiming: 'amc' } }] },
    { symbol: 'MSFT', events: [] }
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].symbol, rows[0].timing], ['AAPL', 'AMC']);
});

test('journal performance computes win rate, profit factor and drawdown in R', () => {
  assert.equal(journalPerformance([]).winRate, null);
  const p = journalPerformance([
    { outcome: 'win', returnR: 2, createdAt: '2026-01-01' }, { outcome: 'loss', returnR: -1, createdAt: '2026-01-02' },
    { outcome: 'loss', returnR: -1, createdAt: '2026-01-03' }, { outcome: 'win', returnR: 3, createdAt: '2026-01-04' }
  ]);
  assert.equal(p.winRate, 50);
  assert.equal(p.profitFactor, 2.5);
  assert.equal(p.maxDrawdownR, 2);
});

test('trade ticket sizing and levels', () => {
  const profile = instrumentProfile('EUR/USDT', 1.1347);
  const size = sizeTicket({ equity: 10000, riskPercent: 1, stopPips: 30, profile, price: 1.1347 });
  assert.ok(Math.abs(size.riskAmount - 100) < 1e-9);
  assert.ok(Math.abs(size.quantity - 100 / 0.003) < 1e-6);
  assert.equal(sizeTicket({ equity: 0, riskPercent: 1, stopPips: 30, profile, price: 1 }), null);
  const buy = ticketLevels({ side: 'buy', price: 1.1347, stopPips: 30, targetPips: 100, profile });
  assert.ok(buy.stop < 1.1347 && buy.target > 1.1347);
  assert.ok(Math.abs(buy.rewardRisk - 100 / 30) < 1e-9);
  const sell = ticketLevels({ side: 'sell', price: 1.1347, stopPips: 30, targetPips: 100, profile });
  assert.ok(sell.stop > 1.1347 && sell.target < 1.1347);
});

test('system status and helpers', () => {
  assert.equal(systemStatus({ health: null, operations: null, loadError: 'x' }).tone, 'bad');
  assert.equal(systemStatus({ health: { status: 'ok', mode: 'paper' }, operations: { jobs: [{ label: 'A', status: 'live' }] } }).label, 'All Systems Operational');
  assert.equal(systemStatus({ health: { status: 'ok' }, operations: { jobs: [{ label: 'Feed', status: 'error' }] } }).label, 'Degraded');
  assert.equal(utcClock(at('2026-04-23T14:32:17Z')).time, '14:32:17 UTC');
  assert.equal(utcClock(at('2026-04-23T14:32:17Z')).date, 'Thu, Apr 23, 2026');
  assert.equal(formatDuration(135), '2h 15m');
});
