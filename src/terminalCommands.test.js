import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTerminalCommand } from './terminalCommands.js';
test('terminal parses safe utility commands',()=>{assert.deepEqual(parseTerminalCommand('HELP'),{action:'help'});assert.deepEqual(parseTerminalCommand('status'),{action:'status'});});
test('terminal routes known workspaces and normalizes market symbols',()=>{assert.deepEqual(parseTerminalCommand('open "Risk Management"'),{action:'open',value:'Risk Management'});assert.deepEqual(parseTerminalCommand('symbol btc-usdt'),{action:'symbol',value:'BTC/USDT'});});
test('terminal rejects unknown workspaces, malformed symbols and arbitrary shell input',()=>{assert.ok(parseTerminalCommand('open secrets').error);assert.ok(parseTerminalCommand('symbol BTC').error);assert.ok(parseTerminalCommand('rm -rf /').error);assert.ok(parseTerminalCommand('whoami').error);});
test('watchlist commands require a valid BASE/QUOTE market',()=>{assert.deepEqual(parseTerminalCommand('watch sol/usdt'),{action:'watch',value:'SOL/USDT'});assert.ok(parseTerminalCommand('unwatch SOL').error);});
