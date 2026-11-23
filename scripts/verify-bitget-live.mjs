// Live Bitget + Cloudflare Pages regression verification.
// Usage: JPTI_PAGES_URL=https://<your-pages-domain> node scripts/verify-bitget-live.mjs
// The test is read-only and uses public market endpoints only.
const base = String(process.env.JPTI_PAGES_URL || 'https://jpti.pages.dev').replace(/\/+$/, '');
const categories = [
  { key: 'spot', label: 'Spot', productCategory: 'SPOT', marketDataCategory: 'SPOT' },
  { key: 'margin', label: 'Margin', productCategory: 'MARGIN', marketDataCategory: 'SPOT' },
  { key: 'usdt-futures', label: 'USDT-M', productCategory: 'USDT-FUTURES', marketDataCategory: 'USDT-FUTURES' },
  { key: 'coin-futures', label: 'Coin-M', productCategory: 'COIN-FUTURES', marketDataCategory: 'COIN-FUTURES' },
  { key: 'usdc-futures', label: 'USDC-M', productCategory: 'USDC-FUTURES', marketDataCategory: 'USDC-FUTURES' }
];
const timeoutMs = 12000;
const results = [];
function assert(condition, message) { if (!condition) throw new Error(message); }
async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal, cache: 'no-store' });
    const body = await response.json().catch(() => null);
    assert(response.ok, url + ' returned HTTP ' + response.status + ': ' + JSON.stringify(body).slice(0, 240));
    assert(body && typeof body === 'object', url + ' did not return JSON.');
    return body;
  } finally { clearTimeout(timer); }
}
function encodeSymbol(symbol) { return encodeURIComponent(symbol); }
const platformHealth = await getJson(base + '/api/health');
const advertisedTypes = platformHealth.capabilities?.bitgetProductTypes || [];
for (const required of ['spot', 'margin', 'futures', 'coin-futures', 'usdc-futures']) {
  assert(advertisedTypes.includes(required), 'Cloudflare API health does not advertise Bitget ' + required + '.');
}
console.log('PASS Cloudflare API health: ' + advertisedTypes.join(', '));
const storageResponse = await fetch(base + '/api/storage/health', { headers: { accept: 'application/json' }, cache: 'no-store' });
const storageHealth = await storageResponse.json().catch(() => null);
assert(storageResponse.ok && storageHealth?.status === 'ok',
  'Cloudflare D1/KV health is not ready: HTTP ' + storageResponse.status + ' ' + JSON.stringify(storageHealth));
console.log('PASS Cloudflare D1/KV storage health');
for (const category of categories) {
  const row = { category: category.label, checks: [] };
  try {
    const marketUrl = base + '/api/exchanges/bitget/markets?type=' + encodeURIComponent(category.key) + '&search=BTC';
    const marketBody = await getJson(marketUrl);
    assert(Array.isArray(marketBody.markets), category.label + ': markets is not an array.');
    assert(marketBody.markets.length > 0, category.label + ': no BTC market returned.');
    const matches = marketBody.markets.filter((m) => m.productCategory === category.productCategory);
    assert(matches.length > 0, category.label + ': selector returned no instruments in ' + category.productCategory + '.');
    row.checks.push('market catalogue');
    const selected = matches.slice(0, 2);
    for (const market of selected) {
      assert(market.symbol && market.id, category.label + ': instrument is missing symbol/id.');
      const ticker = await getJson(base + '/api/exchanges/bitget/ticker/' + encodeSymbol(market.symbol) + '?type=' + encodeURIComponent(category.key));
      assert(Number.isFinite(Number(ticker.last)) && Number(ticker.last) > 0, category.label + ' ' + market.symbol + ': invalid ticker last price.');
      row.checks.push('ticker ' + market.symbol);
      const candles = await getJson(base + '/api/exchanges/bitget/ohlcv/' + encodeSymbol(market.symbol) + '?type=' + encodeURIComponent(category.key) + '&timeframe=1h&limit=40');
      assert(Array.isArray(candles.candles) && candles.candles.length >= 20, category.label + ' ' + market.symbol + ': insufficient candle rows.');
      for (const candle of candles.candles) {
        assert(Array.isArray(candle) && candle.length >= 6 && candle.slice(0, 6).every((n) => Number.isFinite(Number(n))), category.label + ' ' + market.symbol + ': malformed OHLCV candle.');
        assert(Number(candle[2]) >= Number(candle[3]), category.label + ' ' + market.symbol + ': candle high is below low.');
      }
      row.checks.push('candles ' + market.symbol);
    }
    // Re-request the next symbol through the same category to catch stale symbol state/cache keys.
    if (selected.length > 1) {
      const first = selected[0].symbol, second = selected[1].symbol;
      const switched = await getJson(base + '/api/exchanges/bitget/ticker/' + encodeSymbol(second) + '?type=' + encodeURIComponent(category.key));
      assert(switched.symbol === second, category.label + ': symbol switch returned stale symbol ' + switched.symbol + ' instead of ' + second + '.');
      assert(first !== second, category.label + ': test fixture did not select two distinct symbols.');
      row.checks.push('symbol switching');
    }
    row.status = 'passed';
  } catch (error) {
    row.status = 'failed';
    row.error = String(error?.message || error);
    results.push(row);
    console.error('FAIL ' + category.label + ': ' + row.error);
    continue;
  }
  results.push(row);
  console.log('PASS ' + category.label + ': ' + row.checks.join(', '));
}
console.log(JSON.stringify({ target: base, results }, null, 2));
if (results.some((row) => row.status !== 'passed')) process.exitCode = 1;
