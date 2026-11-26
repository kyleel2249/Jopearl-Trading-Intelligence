import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { humanizeAgentOutput } from '../src/lib/agent-report.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => readFileSync(join(root, file), 'utf8');

test('server agent runners never store raw JSON as the human-readable output', () => {
  const foundation = read('functions/intelligence-foundation.js');
  assert.doesNotMatch(foundation, /output\s*=\s*structured\s*\?\s*JSON\.stringify/);
  assert.match(foundation, /formatAgentReport\(structured\)/);
  assert.match(read('functions/organization-intelligence.js'), /humanizeAgentOutput\(typeof synthesis/);
  assert.match(read('functions/api/[[path]].js'), /humanizeAgentOutput\(typeof output/);
});

test('UI panels that show agent or engine output convert JSON to plain language', () => {
  for (const file of ['src/AutonomousDepartments.jsx', 'src/MarketDigitalTwin.jsx', 'src/Phase15To21Workspaces.jsx', 'src/ReflectiveJournal.jsx']) {
    assert.match(read(file), /humanizeAgentOutput/, file + ' must render agent output through the humanizer');
  }
  assert.doesNotMatch(read('src/AutonomousDepartments.jsx'), /<pre>\{item\.result\.output\}<\/pre>/);
});

test('previously stored JSON mission output is healed at display time', () => {
  const stored = JSON.stringify({ summary: 'Funding is neutral.', findings: ['OI flat'], risks: [], nextActions: ['Re-check at the NY open'], handoffs: [] });
  const shown = humanizeAgentOutput(stored);
  assert.match(shown, /^Summary\nFunding is neutral\./);
  assert.doesNotMatch(shown, /[{}\[\]"]/);
});
