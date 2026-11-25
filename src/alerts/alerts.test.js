import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { evaluateAlerts, normalizeAlertConfig, meetsSeverity, ALERT_DEFAULTS } from './alert-engine.js';
import { deliverAlerts, formatAlertText, signPayload, webhookUrl, configuredChannels } from './delivery.js';
import { calibrationReport } from '../gainz-alpha/calibration.js';

const HOUR = 3600e3, NOW = Date.UTC(2026, 5, 1, 12);
const rec = (i, outcome, returnR, extra = {}) => ({ id: 'r' + i, candleTs: NOW - (1000 - i) * HOUR, outcome, returnR, confidence: 60, preset: 'balanced', setupType: 'sweep', session: 'london', symbol: 'BTC/USDT', timeframe: '1h', ...extra });

test('normalizeAlertConfig applies defaults, clamps ranges and ignores junk', () => {
  assert.deepEqual(normalizeAlertConfig({}), { ...ALERT_DEFAULTS });
  const cfg = normalizeAlertConfig({ JPTI_ALERT_MIN_SEVERITY: 'CRITICAL', JPTI_ALERT_MAX_CONSECUTIVE_LOSSES: '1', JPTI_ALERT_DAILY_LOSS_R: '9999', JPTI_ALERT_DRAWDOWN_R: 'abc' });
  assert.equal(cfg.minSeverity, 'critical');
  assert.equal(cfg.maxConsecutiveLosses, 2);
  assert.equal(cfg.dailyLossR, 100);
  assert.equal(cfg.drawdownR, ALERT_DEFAULTS.drawdownR);
  assert.equal(normalizeAlertConfig({ JPTI_ALERT_MIN_SEVERITY: 'loud' }).minSeverity, 'warning');
});

test('evaluateAlerts requires an explicit clock so results are reproducible', () => {
  assert.throws(() => evaluateAlerts({ records: [] }), TypeError);
});

test('a loss streak fires at the limit, escalates three losses later, and keys on the last loss', () => {
  const wins = Array.from({ length: 20 }, (_, i) => rec(i, 'win', 1));
  const five = [...wins, ...Array.from({ length: 5 }, (_, i) => rec(20 + i, 'loss', -1))];
  const a = evaluateAlerts({ records: five, now: NOW }).alerts.filter((x) => x.rule === 'loss-streak');
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, 'warning');
  assert.equal(a[0].data.streak, 5);
  const eight = [...wins, ...Array.from({ length: 8 }, (_, i) => rec(20 + i, 'loss', -1))];
  assert.equal(evaluateAlerts({ records: eight, now: NOW }).alerts.find((x) => x.rule === 'loss-streak').severity, 'critical');
  const four = [...wins, ...Array.from({ length: 4 }, (_, i) => rec(20 + i, 'loss', -1))];
  assert.equal(evaluateAlerts({ records: four, now: NOW }).alerts.filter((x) => x.rule === 'loss-streak').length, 0);
  const broken = [...five.slice(0, -1), rec(99, 'win', 1)];
  assert.equal(evaluateAlerts({ records: broken, now: NOW }).alerts.filter((x) => x.rule === 'loss-streak').length, 0);
});

test('identical state on a later run produces the same alert ids so storage can dedupe them', () => {
  const rows = [...Array.from({ length: 10 }, (_, i) => rec(i, 'win', 1)), ...Array.from({ length: 6 }, (_, i) => rec(10 + i, 'loss', -1))];
  const first = evaluateAlerts({ records: rows, now: NOW }).alerts.map((a) => a.id).sort();
  const later = evaluateAlerts({ records: rows, now: NOW + 5 * 60e3 }).alerts.map((a) => a.id).sort();
  assert.deepEqual(first, later);
  assert.ok(new Set(first).size === first.length);
});

test('daily loss limit counts only the last 24 hours', () => {
  const old = Array.from({ length: 10 }, (_, i) => ({ ...rec(i, 'loss', -1), candleTs: NOW - 3 * 24 * HOUR - i * HOUR }));
  assert.equal(evaluateAlerts({ records: old, now: NOW }).alerts.filter((a) => a.rule === 'daily-loss-limit').length, 0);
  const fresh = Array.from({ length: 7 }, (_, i) => ({ ...rec(i, 'loss', -1), candleTs: NOW - (i + 1) * HOUR }));
  const hit = evaluateAlerts({ records: fresh, now: NOW }).alerts.find((a) => a.rule === 'daily-loss-limit');
  assert.equal(hit.severity, 'critical');
  assert.equal(hit.data.netR, -7);
});

test('drawdown limit measures the current fall from the recent peak, not a recovered one', () => {
  const peakThenFall = [...Array.from({ length: 15 }, (_, i) => rec(i, 'win', 1)), ...Array.from({ length: 12 }, (_, i) => rec(15 + i, 'loss', -1))];
  const hit = evaluateAlerts({ records: peakThenFall, now: NOW }).alerts.find((a) => a.rule === 'drawdown-limit');
  assert.equal(hit.data.drawdownR, 12);
  const recovered = [...peakThenFall, ...Array.from({ length: 13 }, (_, i) => rec(30 + i, 'win', 1))];
  assert.equal(evaluateAlerts({ records: recovered, now: NOW }).alerts.filter((a) => a.rule === 'drawdown-limit').length, 0);
});

test('edge-decay alerts fire only when status worsens, and recovery is announced once', () => {
  const report = (status) => ({ groups: { strategy: [{ key: 'alpha / reversal', n: 300, status, edge: { status, z: -2.4, recent: { expectancy: -0.4 }, baseline: { expectancy: 0.5 } } }] } });
  const first = evaluateAlerts({ report: report('decaying'), previousStatuses: {}, now: NOW });
  assert.equal(first.alerts.length, 1);
  assert.equal(first.alerts[0].rule, 'edge-decay');
  assert.equal(first.alerts[0].severity, 'critical');
  assert.deepEqual(first.statuses, { 'strategy|alpha / reversal': 'decaying' });
  const repeat = evaluateAlerts({ report: report('decaying'), previousStatuses: first.statuses, now: NOW + HOUR });
  assert.equal(repeat.alerts.length, 0);
  const escalated = evaluateAlerts({ report: report('decaying'), previousStatuses: { 'strategy|alpha / reversal': 'watch' }, now: NOW });
  assert.equal(escalated.alerts[0].severity, 'critical');
  const recovered = evaluateAlerts({ report: report('healthy'), previousStatuses: first.statuses, now: NOW + 2 * HOUR });
  assert.equal(recovered.alerts.length, 1);
  assert.equal(recovered.alerts[0].rule, 'edge-recovered');
  assert.equal(recovered.alerts[0].severity, 'info');
  assert.equal(evaluateAlerts({ report: report('insufficient'), previousStatuses: {}, now: NOW }).alerts.length, 0);
});

test('watch status is informational by default and only pages when alertOnWatch is enabled', () => {
  const report = { groups: { strategy: [{ key: 'balanced / sweep', n: 120, status: 'watch', edge: { status: 'watch', z: -1.4, recent: { expectancy: 0.4 }, baseline: { expectancy: 0.9 } } }] } };
  const quiet = evaluateAlerts({ report, previousStatuses: {}, now: NOW });
  assert.equal(quiet.alerts.length, 0);
  assert.deepEqual(quiet.statuses, { 'strategy|balanced / sweep': 'watch' }, 'status is still recorded for the next run');
  const loud = evaluateAlerts({ report, previousStatuses: {}, config: { alertOnWatch: true }, now: NOW });
  assert.equal(loud.alerts.length, 1);
  assert.equal(loud.alerts[0].severity, 'warning');
  assert.equal(normalizeAlertConfig({ JPTI_ALERT_ON_WATCH: 'TRUE' }).alertOnWatch, true);
  assert.equal(normalizeAlertConfig({ JPTI_ALERT_ON_WATCH: 'nope' }).alertOnWatch, false);
});

test('a strategy that flaps in and out of decaying within one day produces a single alert id', () => {
  const report = (status) => ({ groups: { strategy: [{ key: 'alpha / reversal', n: 300, status, edge: { status, z: -2, recent: { expectancy: -0.3 }, baseline: { expectancy: 0.5 } } }] } });
  const day = Date.UTC(2026, 5, 1, 1);
  const a = evaluateAlerts({ report: report('decaying'), previousStatuses: { 'strategy|alpha / reversal': 'healthy' }, now: day }).alerts;
  const b = evaluateAlerts({ report: report('decaying'), previousStatuses: { 'strategy|alpha / reversal': 'healthy' }, now: day + 10 * HOUR }).alerts;
  const nextDay = evaluateAlerts({ report: report('decaying'), previousStatuses: { 'strategy|alpha / reversal': 'healthy' }, now: day + 30 * HOUR }).alerts;
  assert.equal(a[0].id, b[0].id, 'storage dedupes the repeat within the day');
  assert.notEqual(a[0].id, nextDay[0].id, 'a new day can alert again');
});

test('a real report from decaying outcomes drives an edge-decay alert end to end', () => {
  let s = 17; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const rows = Array.from({ length: 300 }, (_, i) => { const win = r() < (i < 240 ? 0.55 : 0.08); return rec(i, win ? 'win' : 'loss', win ? 2 : -1, { candleTs: NOW - (300 - i) * 7 * 24 * HOUR }); });
  const report = calibrationReport(rows);
  const { alerts } = evaluateAlerts({ records: rows, report, previousStatuses: {}, now: NOW });
  assert.ok(alerts.some((a) => a.rule === 'edge-decay' && a.severity === 'critical'));
});

test('miscalibration alert needs the report flag and carries the measured error', () => {
  const alerts = evaluateAlerts({ report: { groups: {}, overall: { miscalibrated: true, ece: 0.31, n: 400 } }, now: NOW }).alerts;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].rule, 'miscalibration');
  assert.equal(alerts[0].data.ece, 0.31);
});

test('severity filtering orders info < warning < critical', () => {
  assert.equal(meetsSeverity({ severity: 'info' }, 'warning'), false);
  assert.equal(meetsSeverity({ severity: 'warning' }, 'warning'), true);
  assert.equal(meetsSeverity({ severity: 'critical' }, 'warning'), true);
  assert.equal(meetsSeverity({ severity: 'warning' }, 'critical'), false);
});

const alertOf = (severity, n = 1) => ({ id: 'a' + n, rule: 'x', severity, title: 'Title ' + n, message: 'Message ' + n, key: 'k', createdAt: 'now', data: {} });

test('formatAlertText lists alerts, caps the digest and stays inside the Telegram size limit', () => {
  const text = formatAlertText(Array.from({ length: 14 }, (_, i) => alertOf('critical', i)));
  assert.match(text, /JPTI alerts \(14\)/);
  assert.match(text, /\.\.\.and 4 more\./);
  assert.ok(text.length <= 4000);
  assert.ok(formatAlertText([{ ...alertOf('warning'), message: 'x'.repeat(9000) }]).length <= 4000);
});

test('webhook URLs must be https and channels reflect only complete configuration', () => {
  assert.equal(webhookUrl({ JPTI_ALERT_WEBHOOK_URL: 'http://hooks.example.com/x' }), null);
  assert.equal(webhookUrl({ JPTI_ALERT_WEBHOOK_URL: 'not a url' }), null);
  assert.equal(webhookUrl({ JPTI_ALERT_WEBHOOK_URL: 'https://hooks.example.com/x' }), 'https://hooks.example.com/x');
  assert.deepEqual(configuredChannels({}), []);
  assert.deepEqual(configuredChannels({ JPTI_TELEGRAM_BOT_TOKEN: 't' }), []);
  assert.deepEqual(configuredChannels({ JPTI_TELEGRAM_BOT_TOKEN: 't', JPTI_TELEGRAM_CHAT_ID: '1', JPTI_ALERT_WEBHOOK_URL: 'https://h.example.com/' }), ['webhook', 'telegram']);
});

test('signPayload matches an independent HMAC-SHA256 so receivers can verify it', async () => {
  const body = '{"a":1}';
  assert.equal(await signPayload('s3cret', body), createHmac('sha256', 's3cret').update(body).digest('hex'));
});

test('deliverAlerts posts a signed webhook and a Telegram digest, filtering below the minimum severity', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; };
  const env = { JPTI_ALERT_WEBHOOK_URL: 'https://hooks.example.com/jpti', JPTI_ALERT_WEBHOOK_SECRET: 'whsec', JPTI_TELEGRAM_BOT_TOKEN: 'bot:token', JPTI_TELEGRAM_CHAT_ID: '42' };
  const result = await deliverAlerts([alertOf('info', 1), alertOf('warning', 2), alertOf('critical', 3)], { env, fetchImpl, minSeverity: 'warning' });
  assert.equal(result.eligible, 2);
  assert.deepEqual(result.delivered, ['webhook', 'telegram']);
  assert.equal(calls.length, 2);
  const hook = calls[0];
  assert.equal(hook.url, 'https://hooks.example.com/jpti');
  assert.equal(hook.init.headers['x-jpti-signature'], 'sha256=' + createHmac('sha256', 'whsec').update(hook.init.body).digest('hex'));
  assert.deepEqual(JSON.parse(hook.init.body).alerts.map((a) => a.id), ['a2', 'a3']);
  assert.equal(calls[1].url, 'https://api.telegram.org/botbot%3Atoken/sendMessage');
  const tg = JSON.parse(calls[1].init.body);
  assert.equal(tg.chat_id, '42');
  assert.match(tg.text, /Title 3/);
  assert.doesNotMatch(tg.text, /Title 1/);
});

test('delivery failures are reported per channel without leaking secrets', async () => {
  const env = { JPTI_ALERT_WEBHOOK_URL: 'https://hooks.example.com/jpti', JPTI_TELEGRAM_BOT_TOKEN: 'SECRET-BOT-TOKEN', JPTI_TELEGRAM_CHAT_ID: '42' };
  const fetchImpl = async (url) => {
    if (url.includes('telegram')) throw new Error('connect failed for ' + url);
    return { ok: false, status: 502 };
  };
  const result = await deliverAlerts([alertOf('critical')], { env, fetchImpl });
  assert.deepEqual(result.delivered, []);
  assert.deepEqual(result.failed, [{ channel: 'webhook', error: 'HTTP 502' }, { channel: 'telegram', error: 'request failed' }]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET-BOT-TOKEN/);
});

test('a hung endpoint is aborted at the timeout instead of stalling the scheduled run', async () => {
  const env = { JPTI_ALERT_WEBHOOK_URL: 'https://hooks.example.com/slow' };
  const fetchImpl = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const started = Date.now();
  const result = await deliverAlerts([alertOf('critical')], { env, fetchImpl, timeoutMs: 30 });
  assert.deepEqual(result.failed, [{ channel: 'webhook', error: 'timeout' }]);
  assert.ok(Date.now() - started < 1000);
});

test('with no channel configured or nothing eligible nothing is sent', async () => {
  let called = 0;
  const fetchImpl = async () => { called++; return { ok: true, status: 200 }; };
  assert.deepEqual((await deliverAlerts([alertOf('critical')], { env: {}, fetchImpl })).channels, []);
  assert.equal((await deliverAlerts([alertOf('info')], { env: { JPTI_ALERT_WEBHOOK_URL: 'https://h.example.com/' }, fetchImpl })).eligible, 0);
  assert.equal(called, 0);
});
