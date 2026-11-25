#!/usr/bin/env node
// Runs the rolling walk-forward backtest on a candle file and prints a JSON report.
//   node scripts/walk-forward.mjs candles.json --symbol BTC/USDT --timeframe 1h --grid balanced,alpha,precision
// The file holds [[timestampMs, open, high, low, close, volume], ...] oldest first (the OHLCV shape the API serves).
// Exit codes: 0 report produced, 1 invalid input or configuration, 2 not enough candles.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { rollingWalkForward, DEFAULT_GRID } from '../src/gainz-alpha/walkforward.js';

const NUMERIC = { train: 'trainBars', test: 'testBars', step: 'stepBars', window: 'window', 'max-hold': 'maxHold', 'min-train-trades': 'minTrainTrades', fee: 'feePct', spread: 'spreadPct', slippage: 'slippagePct' };
const USAGE = 'Usage: node scripts/walk-forward.mjs <candles.json> [--symbol S] [--timeframe 1h] [--grid balanced,alpha] [--train 400] [--test 150] [--step N] [--window 250] [--max-hold 24] [--min-train-trades 15] [--fee 0.0005] [--spread X] [--slippage X] [--risk 1] [--runs 2000] [--block 1] [--seed 1] [--trades]';

export function parseArguments(argv) {
  const options = {}, monteCarlo = {};
  let file = null, includeTrades = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { if (file) throw new Error('Unexpected argument: ' + arg); file = arg; continue; }
    const name = arg.slice(2);
    if (name === 'trades') { includeTrades = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error('Missing value for --' + name);
    if (name === 'symbol' || name === 'timeframe') options[name] = value;
    else if (name === 'grid') options.grid = value.split(',').map((id) => id.trim()).filter(Boolean).map((id) => ({ id, preset: id }));
    else if (NUMERIC[name]) { const n = Number(value); if (!Number.isFinite(n)) throw new Error('--' + name + ' needs a number, got ' + value); options[NUMERIC[name]] = n; }
    else if (name === 'risk' || name === 'runs' || name === 'block' || name === 'seed') {
      const n = Number(value); if (!Number.isFinite(n)) throw new Error('--' + name + ' needs a number, got ' + value);
      monteCarlo[{ risk: 'riskPerTradePct', runs: 'runs', block: 'blockSize', seed: 'seed' }[name]] = n;
    } else throw new Error('Unknown option --' + name);
  }
  if (!file) throw new Error('A candle file is required.');
  return { file, options: { ...options, monteCarlo }, includeTrades };
}

export function runCli(argv, { read = (path) => readFileSync(path, 'utf8') } = {}) {
  let parsed;
  try { parsed = parseArguments(argv); } catch (error) { return { code: 1, error: error.message + '\n' + USAGE }; }
  let candles;
  try { candles = JSON.parse(read(parsed.file)); } catch (error) { return { code: 1, error: 'Could not read candles from ' + parsed.file + ': ' + error.message }; }
  if (!Array.isArray(candles) || !candles.every((row) => Array.isArray(row) && row.length >= 5)) return { code: 1, error: 'The candle file must be a JSON array of [timestamp, open, high, low, close, volume] rows.' };
  const report = rollingWalkForward(candles, { grid: DEFAULT_GRID, ...parsed.options });
  if (report.status === 'error') return { code: 1, error: report.reason };
  if (!parsed.includeTrades && report.oos) report.oos = { summary: report.oos.summary, trades: report.oos.trades.length + ' trades (use --trades to include them)' };
  return { code: report.status === 'insufficient' ? 2 : 0, report };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runCli(process.argv.slice(2));
  if (result.error) console.error(result.error);
  if (result.report) console.log(JSON.stringify(result.report, null, 2));
  process.exit(result.code);
}
