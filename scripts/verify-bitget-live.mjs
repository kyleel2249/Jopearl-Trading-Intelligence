// Live Bitget + Cloudflare Pages regression verification.
// Usage: JPTI_PAGES_URL=https://<your-pages-domain> node scripts/verify-bitget-live.mjs
// Read-only: verifies public market data only. Bitget may return HTTP 403 to a
// particular Cloudflare/GitHub egress region; that condition is reported as a
// regional warning, not misreported as an application or credential failure.
const base = String(process.env.JPTI_PAGES_URL || 'https://jpti.pages.dev').replace(/\/+$/, '');
const bitget = 'https://api.bitget.com';
const categories = [
  { key: 'spot', label: 'Spot', productCategory: 'SPOT', marketDataCategory: 'SPOT' },
  { key: 'margin', label: 'Margin', productCategory: 'MARGIN', marketDataCategory: 'SPOT' },
  { key: 'usdt-futures', label: 'USDT-M', productCategory: 'USDT-FUTURES', marketDataCategory: 'USDT-FUTURES' },
  { key: 'coin-futures', label: 'Coin-M', productCategory: 'COIN-FUTURES', marketDataCategory: 'COIN-FUTURES' },
  { key: 'usdc-futures', label: 'USDC-M', productCategory: 'USDC-FUTURES', marketDataCategory: 'USDC-FUTURES' }
];
const timeoutMs = 15000;
const results = [];
function assert(condition, message) { if (!condition) throw new Error(message); }
async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal, cache: 'no-store' });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(url + ' returned HTTP ' + response.status + ': ' + JSON.stringify(body).slice(0, 360));
      error.status = response.status;
      error.body = body;
      throw error;
    }
    assert(body && typeof body === 'object', url + ' did not return JSON.');
    return body;
  } finally { clearTimeout(timer); }
}
function encodeSymbol(symbol) { return encodeURIComponent(symbol); }
function validateCandles(candles, label) {
  assert(Array.isArray(candles) && candles.length >= 20, label + ': insufficient candle rows.');
  for (const candle of candles) {
    assert(Array.isArray(candle) && candle.length >= 6 && candle.slice(0, 6).every((n) => Number.isFinite(Number(n))), label + ': malformed OHLCV candle.');
    assert(Number(candle[2]) >= Number(candle[3]), label + ': candle high is below low.');
  }
}
function isKnownRegional403(error) {
  const text = String(error?.message || '');
  return error?.status === 502 && /HTTP 403/.test(text);
}
async function verifyDirectCategory(category, row) {
  const instrumentBody = await getJson(bitget + '/api/v3/market/instruments?category=' + encodeURIComponent(category.productCategory));
  assert(instrumentBody.code === '00000' && Array.isArray(instrumentBody.data), category.label + ': Bitget returned an invalid instrument response.');
  const selected = instrumentBody.data.filter((market) => market.status === 'online' && String(market.baseCoin || '').toUpperCase() === 'BTC').slice(0, 2);
  assert(selected.length > 0, category.label + ': direct Bitget API returned no BTC instruments.');
  row.checks.push('direct Bitget instrument catalogue');
  for (const market of selected) {
    assert(market.symbol, category.label + ': Bitget instrument is missing its exact symbol ID.');
    const tickerBody = await getJson(bitget + '/api/v3/market/tickers?category=' + encodeURIComponent(category.marketDataCategory) + '&symbol=' + encodeURIComponent(market.symbol));
    const ticker = tickerBody.data?.[0];
    assert(tickerBody.code === '00000' && Number.isFinite(Number(ticker?.lastPrice)) && Number(ticker.lastPrice) > 0,
      category.label + ' ' + market.symbol + ': invalid direct ticker.');
    row.checks.push('direct ticker ' + market.symbol);
    const candleBody = await getJson(bitget + '/api/v3/market/history-candles?category=' + encodeURIComponent(category.marketDataCategory) + '&symbol=' + encodeURIComponent(market.symbol) + '&interval=1H&limit=40');
    assert(candleBody.code === '00000', category.label + ' ' + market.symbol + ': Bitget rejected direct candles.');
    validateCandles(candleBody.data, category.label + ' ' + market.symbol);
    row.checks.push('direct candles ' + market.symbol);
  }
  if (selected.length > 1) {
    const second = selected[1];
    const switched = await getJson(bitget + '/api/v3/market/tickers?category=' + encodeURIComponent(category.marketDataCategory) + '&symbol=' + encodeURIComponent(second.symbol));
    assert(switched.data?.[0]?.symbol === second.symbol, category.label + ': direct symbol switch returned stale data.');
    row.checks.push('direct symbol switching');
  }
}
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
    let marketBody;
    try {
      marketBody = await getJson(marketUrl);
    } catch (edgeError) {
      if (!isKnownRegional403(edgeError)) throw edgeError;
      row.edgeStatus = 'upstream-403';
      try {
        await verifyDirectCategory(category, row);
        row.status = 'passed-with-edge-region-warning';
        row.warning = 'The Pages Worker received HTTP 403 from Bitget in this runner region; direct Bitget public endpoints passed.';
      } catch (directError) {
        if (directError?.status === 403) {
          row.status = 'region-blocked';
          row.warning = 'Both the Pages Worker and this GitHub runner received HTTP 403 from Bitget. This region cannot validate live Bitget data; the browser-direct fallback is covered by automated tests.';
          results.push(row);
          console.warn('WARN ' + category.label + ': ' + row.warning);
          continue;
        }
        throw directError;
      }
      results.push(row);
      console.warn('WARN ' + category.label + ': ' + row.warning);
      continue;
    }
    assert(Array.isArray(marketBody.markets), category.label + ': markets is not an array.');
    assert(marketBody.markets.length > 0, category.label + ': no BTC market returned.');
    const matches = marketBody.markets.filter((market) => market.productCategory === category.productCategory);
    assert(matches.length > 0, category.label + ': selector returned no instruments in ' + category.productCategory + '.');
    row.checks.push('market catalogue');
    const selected = matches.slice(0, 2);
    for (const market of selected) {
      assert(market.symbol && market.id, category.label + ': instrument is missing symbol/id.');
      const instrumentQuery = '&instrumentId=' + encodeURIComponent(market.id);
      const ticker = await getJson(base + '/api/exchanges/bitget/ticker/' + encodeSymbol(market.symbol) + '?type=' + encodeURIComponent(category.key) + instrumentQuery);
      assert(Number.isFinite(Number(ticker.last)) && Number(ticker.last) > 0, category.label + ' ' + market.symbol + ': invalid ticker last price.');
      row.checks.push('ticker ' + market.symbol);
      const candles = await getJson(base + '/api/exchanges/bitget/ohlcv/' + encodeSymbol(market.symbol) + '?type=' + encodeURIComponent(category.key) + '&timeframe=1h&limit=40' + instrumentQuery);
      validateCandles(candles.candles, category.label + ' ' + market.symbol);
      row.checks.push('candles ' + market.symbol);
    }
    if (selected.length > 1) {
      const first = selected[0].symbol, second = selected[1];
      const switched = await getJson(base + '/api/exchanges/bitget/ticker/' + encodeSymbol(second.symbol) + '?type=' + encodeURIComponent(category.key) + '&instrumentId=' + encodeURIComponent(second.id));
      assert(switched.symbol === second.symbol, category.label + ': symbol switch returned stale symbol ' + switched.symbol + ' instead of ' + second.symbol + '.');
      assert(first !== second.symbol, category.label + ': test fixture did not select two distinct symbols.');
      row.checks.push('symbol switching');
    }
    row.status = 'passed';
  } catch (error) {
    row.status = 'failed';
    row.error = String(error?.message || error);
    console.error('FAIL ' + category.label + ': ' + row.error);
  }
  results.push(row);
  if (row.status === 'passed') console.log('PASS ' + category.label + ': ' + row.checks.join(', '));
}
const failures = results.filter((row) => row.status === 'failed');
const regional = results.filter((row) => row.status === 'region-blocked' || row.status === 'passed-with-edge-region-warning');
console.log(JSON.stringify({
  target: base,
  status: failures.length ? 'failed' : regional.length ? 'passed-with-regional-warnings' : 'passed',
  results
}, null, 2));
if (failures.length) process.exitCode = 1;
