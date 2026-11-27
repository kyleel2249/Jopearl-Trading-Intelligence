import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = fs.readFileSync(path.join(root, 'migrations/d1/0020_market_catalog_observations.sql'), 'utf8');

test('D1 market observation migration permits durable instrument catalogue rows', () => {
  assert.match(migration, /observation_kind TEXT NOT NULL CHECK \(observation_kind IN \('ticker','ohlcv','markets'\)\)/);
});

test('D1 market observation migration preserves existing observations before replacing the table', () => {
  assert.match(migration, /INSERT INTO jpti_market_observations_rebuild[\s\S]*SELECT[\s\S]*FROM jpti_market_observations/);
  assert.match(migration, /DROP TABLE jpti_market_observations/);
  assert.match(migration, /ALTER TABLE jpti_market_observations_rebuild RENAME TO jpti_market_observations/);
});

test('D1 market observation migration recreates lookup indexes and records its version', () => {
  assert.match(migration, /CREATE INDEX jpti_market_observations_lookup/);
  assert.match(migration, /CREATE INDEX jpti_market_observations_time/);
  assert.match(migration, /0020_market_catalog_observations/);
});
