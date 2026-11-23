import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG_REGISTRY, CONFIG_CATEGORIES, classifyKey, validateValue, auditConfiguration,
  restartRequiredFor, isServerEligibleKey, exchangeEnvKey
} from './config-registry.js';

test('every registry entry is unique, categorised and complete', () => {
  const names = CONFIG_REGISTRY.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length, 'duplicate registry names');
  for (const entry of CONFIG_REGISTRY) {
    assert.ok(CONFIG_CATEGORIES.includes(entry.category), entry.name + ' has an unknown category');
    assert.ok(entry.description.length > 10, entry.name + ' needs a description');
    assert.ok(['backend', 'frontend', 'ci'].includes(entry.scope));
  }
});

test('every secret-format entry is flagged sensitive and nothing frontend is sensitive', () => {
  for (const entry of CONFIG_REGISTRY) {
    if (entry.format === 'secret') assert.equal(entry.sensitive, true, entry.name);
    if (entry.scope === 'frontend') assert.equal(entry.sensitive, false, entry.name);
  }
});

test('registry documents every variable listed in .env.example', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const names = [...text.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1]);
  assert.ok(names.length >= 8, 'Cloudflare frontend environment template should be populated');
  const missing = names.filter((name) => !classifyKey(name));
  assert.deepEqual(missing, [], 'registry is missing: ' + missing.join(', '));
});

test('dynamic CCXT exchange credentials and throttle keys are classified', () => {
  const entry = classifyKey('JPTI_BITSTAMP_API_KEY');
  assert.equal(entry.category, 'Trading Exchanges');
  assert.equal(entry.sensitive, true);
  assert.equal(entry.dynamic, true);
  assert.equal(classifyKey('JPTI_FINNHUB_MIN_INTERVAL_MS').format, 'integer');
  assert.equal(classifyKey('TOTALLY_UNKNOWN'), null);
  assert.equal(exchangeEnvKey('gate.io', 'API_KEY'), 'JPTI_GATE_IO_API_KEY');
});

test('value validation covers formats and ranges', () => {
  const f = (name, value) => validateValue(classifyKey(name), value);
  assert.equal(f('JPTI_ENABLE_LIVE_TRADING', 'true').ok, true);
  assert.equal(f('JPTI_ENABLE_LIVE_TRADING', 'True').ok, false);
  assert.equal(f('JPTI_API_PORT', '70000').ok, false);
  assert.equal(f('JPTI_API_PORT', '8787').ok, true);
  assert.equal(f('JPTI_EXCHANGE_TIMEOUT_MS', '500').ok, false);
  assert.equal(f('JPTI_STORAGE_BACKEND', 'mysql').ok, false);
  assert.equal(f('VITE_API_BASE_URL', 'http://192.168.1.2:8787').ok, false);
  assert.equal(f('VITE_API_BASE_URL', 'http://localhost:8787').ok, true);
  assert.equal(f('VITE_API_BASE_URL', 'https://jpti.example.com/api').ok, false);
  assert.equal(f('VITE_WS_URL', 'ws://example.com').ok, false);
  assert.equal(f('VITE_WS_URL', 'wss://example.com/ws').ok, true);
  assert.equal(f('JPTI_CORS_ORIGINS', 'https://localhost,capacitor://localhost,https://a.example.com').ok, true);
  assert.equal(f('JPTI_CORS_ORIGINS', 'https://a.example.com/path').ok, false);
  assert.equal(f('JPTI_RECONCILE_OPENING_BALANCES_JSON', '{}').ok, true);
  assert.equal(f('JPTI_RECONCILE_OPENING_BALANCES_JSON', '[1]').ok, false);
  assert.equal(f('JPTI_MONITOR_MARKETS', 'binance:BTC/USDT,bybit:ETH/USDT:USDT').ok, true);
  assert.equal(f('JPTI_MONITOR_MARKETS', 'BTCUSDT').ok, false);
  assert.equal(f('JPTI_FINNHUB_API_KEY', 'replace-with-key').severity, 'warning');
  assert.equal(f('DATABASE_URL', 'postgres://u:p@db.example.com:5432/jpti').ok, true);
  assert.equal(f('DATABASE_URL', 'mysql://x').ok, false);
  assert.equal(f('VITE_API_PATH_PREFIX', '/jpti').ok, true);
  assert.equal(f('VITE_API_PATH_PREFIX', 'jpti').ok, false);
  assert.equal(f('JPTI_FINNHUB_API_KEY', '').ok, true);
});

test('auditor finds conflicts, missing requirements, duplicates, public secrets and unknown keys', () => {
  const report = auditConfiguration({
    JPTI_STORAGE_BACKEND: 'postgres',
    JPTI_ENABLE_LIVE_TRADING: 'true',
    JPTI_TRADING_MODE: 'paper',
    JPTI_API_HOST: '0.0.0.0',
    JPTI_BINANCE_API_KEY: 'abcdefghij',
    VITE_SECRET_THING: 'oops',
    MYSTERY_SETTING: '1',
    JPTI_API_TOKEN: 'replace-with-a-long-random-secret'
  }, { duplicates: { JPTI_API_PORT: [3, 9] } });
  const codes = report.issues.map((issue) => issue.code + ':' + issue.key);
  assert.ok(codes.includes('missing-required:DATABASE_URL'));
  assert.ok(codes.includes('conflict:JPTI_ENABLE_LIVE_TRADING'));
  assert.ok(codes.includes('missing-required:JPTI_ALLOW_REMOTE_API'));
  assert.ok(codes.includes('incomplete-pair:JPTI_BINANCE_API_SECRET'));
  assert.ok(codes.includes('public-secret:VITE_SECRET_THING'));
  assert.ok(codes.includes('unclassified:MYSTERY_SETTING'));
  assert.ok(codes.includes('duplicate:JPTI_API_PORT'));
  assert.ok(codes.includes('placeholder:JPTI_API_TOKEN'));
  assert.deepEqual(report.unclassified, ['MYSTERY_SETTING']);
  assert.equal(report.ok, false);
});

test('a clean paper-mode configuration has no errors', () => {
  const report = auditConfiguration({ JPTI_TRADING_MODE: 'paper', JPTI_ENABLE_LIVE_TRADING: 'false', JPTI_API_HOST: '127.0.0.1', JPTI_API_PORT: '8787' });
  assert.equal(report.counts.error, 0);
  assert.equal(report.ok, true);
});

test('restart tracking distinguishes hot-applied provider keys from start-up settings', () => {
  assert.deepEqual(restartRequiredFor(['JPTI_FINNHUB_API_KEY', 'JPTI_API_PORT', 'NOT_IN_REGISTRY']).sort(), ['JPTI_API_PORT', 'NOT_IN_REGISTRY']);
  assert.equal(isServerEligibleKey('JPTI_API_TOKEN'), true);
  assert.equal(isServerEligibleKey('VITE_API_BASE_URL'), false);
  assert.equal(isServerEligibleKey('JPTI_CONFIG_ENCRYPTION_KEY'), false);
});
