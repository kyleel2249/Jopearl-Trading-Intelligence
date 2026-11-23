import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 18000 + (process.pid % 10000);
const base = 'http://127.0.0.1:' + port;
const dataDir = await mkdtemp(join(tmpdir(), 'jpti-smoke-'));
const child = spawn(process.execPath, ['api/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: 'development',
    JPTI_API_HOST: '127.0.0.1',
    JPTI_API_PORT: String(port),
    JPTI_SERVE_WEB: 'true',
    JPTI_WEB_DIST: 'dist',
    JPTI_SCHEDULER_ENABLED: 'false',
    JPTI_STORAGE_BACKEND: 'file',
    JPTI_DATA_DIR: dataDir,
    JPTI_TRADING_MODE: 'paper',
    JPTI_ENABLE_LIVE_TRADING: 'false',
    JPTI_ALLOW_LOCAL_PRIVATE_ACCESS: 'false'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk.toString(); });
child.stderr.on('data', chunk => { logs += chunk.toString(); });

async function request(path) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(path + ' returned HTTP ' + response.status);
  return response;
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error('JPTI server exited before readiness.\n' + logs);
    try {
      const response = await request('/api/health');
      const health = await response.json();
      if (health.status !== 'ok' || health.mode !== 'paper' || health.liveTradingEnabled !== false) {
        throw new Error('Unexpected health response: ' + JSON.stringify(health));
      }
      ready = true;
      break;
    } catch (error) {
      if (attempt === 39) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  if (!ready) throw new Error('JPTI API did not become ready.\n' + logs);

  const mobilePreflight = await fetch(base + '/api/health', { method: 'OPTIONS', headers: { origin: 'http://localhost', 'access-control-request-method': 'GET', 'access-control-request-headers': 'content-type' } });
  if (mobilePreflight.status !== 204 || mobilePreflight.headers.get('access-control-allow-origin') !== 'http://localhost') {
    throw new Error('Capacitor Android localhost CORS preflight was not accepted.');
  }
  const deniedPreflight = await fetch(base + '/api/health', { method: 'OPTIONS', headers: { origin: 'https://untrusted.example', 'access-control-request-method': 'GET' } });
  if (deniedPreflight.status !== 403) throw new Error('Untrusted CORS origin was not rejected.');
  const sourcesResponse = await request('/api/institutional/sources');
  const sourcePayload = await sourcesResponse.json();
  const sourceNames = (sourcePayload.sources || []).map(item => item.name);
  for (const expected of ['Forex Factory calendar feed', 'Federal Reserve speeches RSS', 'FRED macro observations', 'CFTC Commitments of Traders']) {
    if (!sourceNames.includes(expected)) throw new Error('Institutional source registry missing: ' + expected);
  }

  const pageResponse = await request('/');
  const html = await pageResponse.text();
  if (!html.includes('<div id="root"') && !html.includes("id='root'")) {
    throw new Error('Production web shell did not contain the React root element.');
  }
  const assetPath = html.match(/(?:src|href)="([^"]*\/assets\/[^"]+)"/)?.[1];
  if (!assetPath) throw new Error('Production web shell did not reference a built asset.');
  const assetResponse = await request(assetPath);
  const asset = await assetResponse.text();
  if (asset.length < 1000) throw new Error('Built application asset appears empty or truncated.');

  console.log(JSON.stringify({
    status: 'passed',
    checks: ['API startup', 'paper-mode health endpoint', 'institutional source registry', 'production React shell', 'built frontend asset delivery'],
    sourceCount: sourceNames.length,
    asset: assetPath
  }, null, 2));
} catch (error) {
  console.error('JPTI runtime smoke test failed:', error);
  console.error(logs);
  process.exitCode = 1;
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await rm(dataDir, { recursive: true, force: true });
}
