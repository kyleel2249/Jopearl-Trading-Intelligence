import { withExchange } from './exchanges.js';
import express from 'express';

export const intelligenceRouter = express.Router();

const CHAINS = {
  ethereum: 'eth-mainnet', base: 'base-mainnet', polygon: 'polygon-mainnet',
  arbitrum: 'arb-mainnet', optimism: 'opt-mainnet'
};
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SERIES = /^[A-Z0-9_]{1,32}$/;

async function fetchJson(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, headers: { accept: 'application/json', ...(options.headers || {}) } });
    if (!response.ok) throw Object.assign(new Error(`Provider returned HTTP ${response.status}`), { status: 502 });
    return await response.json();
  } finally { clearTimeout(timer); }
}

function source(name, status, fetchedAt, details = {}) {
  return { name, status, fetchedAt, ...details };
}

async function settledSource(name, task) {
  const fetchedAt = new Date().toISOString();
  try { return { data: await task(), source: source(name, 'live', fetchedAt) }; }
  catch (error) { return { data: null, source: source(name, 'unavailable', fetchedAt, { error: error.name === 'AbortError' ? 'Provider request timed out' : error.message }) }; }
}

export function scoreMarketContext({ priceChangePct = null, volumeChangePct = null, netExchangeFlow = null, stablecoinSupplyChangePct = null, orderBookImbalancePct = null, fundingRate = null, timeframeAlignment = null, macroBias = null } = {}) {
  let score = 0;
  const evidence = [];
  if (Number.isFinite(priceChangePct)) { const points = Math.max(-2, Math.min(2, priceChangePct / 3)); score += points; evidence.push({ factor: 'price momentum', value: priceChangePct, contribution: points }); }
  if (Number.isFinite(volumeChangePct)) { const points = Math.max(-1.5, Math.min(1.5, volumeChangePct / 20)) * (Number.isFinite(priceChangePct) && priceChangePct < 0 ? -1 : 1); score += points; evidence.push({ factor: 'relative volume', value: volumeChangePct, contribution: points }); }
  if (Number.isFinite(netExchangeFlow)) { const points = netExchangeFlow < 0 ? 1 : netExchangeFlow > 0 ? -1 : 0; score += points; evidence.push({ factor: 'net exchange flow', value: netExchangeFlow, contribution: points }); }
  if (Number.isFinite(stablecoinSupplyChangePct)) { const points = Math.max(-1, Math.min(1, stablecoinSupplyChangePct / 5)); score += points; evidence.push({ factor: 'stablecoin supply change', value: stablecoinSupplyChangePct, contribution: points }); }
  if (Number.isFinite(orderBookImbalancePct)) { const points = Math.max(-1, Math.min(1, orderBookImbalancePct / 30)); score += points; evidence.push({ factor: 'top-of-book depth imbalance', value: orderBookImbalancePct, contribution: points }); }
  if (Number.isFinite(fundingRate)) { const points = Math.max(-1, Math.min(1, -fundingRate * 10000)); score += points; evidence.push({ factor: 'perpetual funding (contrarian)', value: fundingRate, contribution: points }); }
  if (Number.isFinite(timeframeAlignment)) { const points = Math.max(-0.75, Math.min(0.75, timeframeAlignment * 0.75)); score += points; evidence.push({ factor: 'multi-timeframe alignment', value: timeframeAlignment, contribution: points }); }
  if (macroBias === 'risk-on') { score += 0.75; evidence.push({ factor: 'macro regime', value: macroBias, contribution: 0.75 }); }
  if (macroBias === 'risk-off') { score -= 0.75; evidence.push({ factor: 'macro regime', value: macroBias, contribution: -0.75 }); }
  const direction = score >= 1.25 ? 'bullish bias' : score <= -1.25 ? 'bearish bias' : 'mixed / neutral';
  return { score: Number(score.toFixed(2)), direction, confidence: evidence.length < 2 ? 'low' : evidence.length < 4 ? 'moderate' : 'higher', evidence, caveat: 'Heuristic research score, not a probability, forecast, or trade instruction. Missing inputs are not treated as zero evidence.' };
}


intelligenceRouter.post('/score', express.json(), (req, res) => {
  const input = req.body || {};
  const numeric = ['priceChangePct', 'volumeChangePct', 'netExchangeFlow', 'stablecoinSupplyChangePct', 'orderBookImbalancePct', 'fundingRate', 'timeframeAlignment'];
  for (const field of numeric) if (input[field] !== undefined && !Number.isFinite(input[field])) return res.status(400).json({ error: `${field} must be a finite number.` });
  if (input.macroBias !== undefined && !['risk-on', 'risk-off', 'neutral'].includes(input.macroBias)) return res.status(400).json({ error: 'macroBias must be risk-on, risk-off or neutral.' });
  res.json({ generatedAt: new Date().toISOString(), ...scoreMarketContext(input) });
});


intelligenceRouter.get('/market/:exchange/:symbol/context', async (req, res) => {
  const exchangeId = String(req.params.exchange || '').toLowerCase();
  const symbol = String(req.params.symbol || '').toUpperCase().replace('-', '/');
  const timeframe = String(req.query.timeframe || '1h');
  if (!/^[A-Z0-9]{2,20}\/[A-Z0-9]{2,20}$/.test(symbol)) return res.status(400).json({ error: 'Invalid market symbol.' });
  if (!/^(1m|3m|5m|15m|30m|1h|2h|4h|6h|8h|12h|1d|3d|1w|1M)$/.test(timeframe)) return res.status(400).json({ error: 'Unsupported timeframe.' });
  try {
    const market = await withExchange(exchangeId, { privateAccess: false }, async (client) => {
      if (!client.markets[symbol]) throw Object.assign(new Error('Market is not listed on the selected exchange.'), { status: 404 });
      if (!client.has?.fetchOHLCV) throw Object.assign(new Error('OHLCV is unavailable for this exchange.'), { status: 501 });
      const tfList = [...new Set([timeframe, '15m', '1h', '4h', '1d'])].filter((tf) => !client.timeframes || client.timeframes[tf]);
      const [candles, ticker, orderBook, fundingRate, multiRows] = await Promise.all([
        client.fetchOHLCV(symbol, timeframe, undefined, 80),
        client.has?.fetchTicker ? client.fetchTicker(symbol) : Promise.resolve(null),
        client.has?.fetchOrderBook ? client.fetchOrderBook(symbol, 20).catch(() => null) : Promise.resolve(null),
        (client.has?.fetchFundingRate && client.market(symbol).contract) ? client.fetchFundingRate(symbol).catch(() => null) : Promise.resolve(null),
        Promise.all(tfList.map(async (tf) => ({ timeframe: tf, candles: await client.fetchOHLCV(symbol, tf, undefined, 40).catch(() => null) })))
      ]);
      return { candles, ticker, orderBook, fundingRate, multiRows };
    });
    const rows = (market.candles || []).filter((row) => Array.isArray(row) && row.length >= 6 && row.slice(1,6).every((n) => Number.isFinite(Number(n))));
    if (rows.length < 25) return res.status(422).json({ error: 'At least 25 valid candles are required for context analysis.', candleCount: rows.length });
    const closed = rows.slice(0, -1);
    const last = closed[closed.length - 1];
    const base = closed[Math.max(0, closed.length - 21)];
    const priceChangePct = base[4] ? ((last[4] - base[4]) / base[4]) * 100 : null;
    const priorVolumes = closed.slice(-21, -1).map((row) => Number(row[5])).filter(Number.isFinite);
    const averageVolume = priorVolumes.length ? priorVolumes.reduce((a,b)=>a+b,0) / priorVolumes.length : null;
    const volumeChangePct = averageVolume > 0 ? ((Number(last[5]) - averageVolume) / averageVolume) * 100 : null;
    const multiTimeframe = (market.multiRows || []).map((item) => {
      const valid = (item.candles || []).filter((row) => Array.isArray(row) && row.length >= 6 && Number.isFinite(Number(row[4])));
      const closedRows = valid.slice(0, -1);
      if (closedRows.length < 22) return { timeframe: item.timeframe, bias: 'unavailable', changePct: null };
      const end = closedRows[closedRows.length - 1][4], start = closedRows[closedRows.length - 21][4];
      const changePct = start ? ((end - start) / start) * 100 : 0;
      return { timeframe: item.timeframe, bias: changePct > 0.15 ? 'bullish' : changePct < -0.15 ? 'bearish' : 'neutral', changePct: Number(changePct.toFixed(3)) };
    });
    const usableTf = multiTimeframe.filter((item) => item.bias !== 'unavailable' && item.bias !== 'neutral');
    const timeframeAlignment = usableTf.length ? usableTf.reduce((sum,item)=>sum+(item.bias==='bullish'?1:-1),0) / usableTf.length : null;
    const bidDepth = (market.orderBook?.bids || []).slice(0,20).reduce((sum,[price,amount])=>sum+Number(price)*Number(amount),0);
    const askDepth = (market.orderBook?.asks || []).slice(0,20).reduce((sum,[price,amount])=>sum+Number(price)*Number(amount),0);
    const orderBookImbalancePct = bidDepth + askDepth > 0 ? ((bidDepth-askDepth)/(bidDepth+askDepth))*100 : null;
    const fundingRate = Number.isFinite(Number(market.fundingRate?.fundingRate)) ? Number(market.fundingRate.fundingRate) : null;
    const [globalResult, chainResult] = await Promise.all([
      settledSource('CoinGecko global market', () => fetchJson('https://api.coingecko.com/api/v3/global')),
      settledSource('DeFiLlama chain TVL', () => fetchJson('https://api.llama.fi/v2/chains'))
    ]);
    const global = globalResult.data?.data || null;
    const globalChange = Number(global?.market_cap_change_percentage_24h_usd);
    const score = scoreMarketContext({
      priceChangePct,
      volumeChangePct,
      orderBookImbalancePct,
      fundingRate,
      timeframeAlignment,
      macroBias: Number.isFinite(globalChange) ? (globalChange > 1 ? 'risk-on' : globalChange < -1 ? 'risk-off' : 'neutral') : 'neutral'
    });
    const chainRows = Array.isArray(chainResult.data) ? chainResult.data : [];
    res.set('Cache-Control', 'public, max-age=30');
    res.json({
      generatedAt: new Date().toISOString(), exchange: exchangeId, symbol, timeframe,
      market: { lastPrice: market.ticker?.last ?? last[4], quoteVolume24h: market.ticker?.quoteVolume ?? null, priceChangePct: priceChangePct == null ? null : Number(priceChangePct.toFixed(4)), latestClosedCandleAt: new Date(last[0]).toISOString(), lastClosedVolume: last[5], averagePriorVolume: averageVolume, volumeChangePct: volumeChangePct == null ? null : Number(volumeChangePct.toFixed(2)), orderBookImbalancePct: orderBookImbalancePct == null ? null : Number(orderBookImbalancePct.toFixed(2)), fundingRate },
      multiTimeframe,
      broadContext: { globalMarketCapChange24hPct: Number.isFinite(globalChange) ? globalChange : null, btcDominancePct: global?.market_cap_percentage?.btc ?? null, chainTvlLeaders: chainRows.slice().sort((a,b)=>(Number(b.tvl)||0)-(Number(a.tvl)||0)).slice(0,5).map((x)=>({name:x.name,tvl:x.tvl})) },
      score,
      limitations: ['Exchange price/volume calculations use closed candles; the newest possibly incomplete candle is excluded.', 'Broad risk regime is a coarse proxy derived from aggregate crypto market-cap change, not a macroeconomic forecast.', 'Exchange netflows, wallet attribution and FRED macro releases are not included in this pair-specific score. Funding and order-book depth are included only when the exchange adapter exposes them.', 'The score is a research aid, not a probability, recommendation or order instruction.'],
      sources: [source('Selected CCXT exchange OHLCV/ticker', 'live', new Date().toISOString(), { timeframe, candlesUsed: closed.length }), globalResult.source, chainResult.source]
    });
  } catch (error) { res.status(error.status || 502).json({ error: error.message || 'Market context analysis failed' }); }
});

intelligenceRouter.get('/overview', async (_req, res) => {
  const [global, chains, stablecoins, fees] = await Promise.all([
    settledSource('CoinGecko global crypto market', () => fetchJson('https://api.coingecko.com/api/v3/global')),
    settledSource('DeFiLlama chain TVL', () => fetchJson('https://api.llama.fi/v2/chains')),
    settledSource('DeFiLlama stablecoin supply', () => fetchJson('https://stablecoins.llama.fi/stablecoins?includePrices=true')),
    settledSource('DeFiLlama protocol fees', () => fetchJson('https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true'))
  ]);
  const stablecoinRows = Array.isArray(stablecoins.data?.peggedAssets) ? stablecoins.data.peggedAssets : [];
  const chainRows = Array.isArray(chains.data) ? chains.data : [];
  const feeRows = Array.isArray(fees.data?.protocols) ? fees.data.protocols : [];
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    generatedAt: new Date().toISOString(),
    global: global.data?.data || null,
    chains: chainRows.slice(0, 30).map((item) => ({ name: item.name, tvl: item.tvl, tokenSymbol: item.tokenSymbol, gecko_id: item.gecko_id })),
    stablecoins: { totalCirculatingUsd: stablecoins.data?.peggedAssets ? stablecoinRows.reduce((sum, item) => sum + (Number(item.circulating?.peggedUSD) || 0), 0) : null,
      leaders: stablecoinRows.slice().sort((a, b) => (Number(b.circulating?.peggedUSD) || 0) - (Number(a.circulating?.peggedUSD) || 0)).slice(0, 10).map((item) => ({ name: item.name, symbol: item.symbol, circulatingUsd: item.circulating?.peggedUSD })) },
    protocolFees: feeRows.slice().sort((a, b) => (Number(b.total24h) || 0) - (Number(a.total24h) || 0)).slice(0, 10).map((item) => ({ name: item.name, total24h: item.total24h, total7d: item.total7d })),
    sources: [global.source, chains.source, stablecoins.source, fees.source]
  });
});

intelligenceRouter.get('/macro/:seriesId', async (req, res, next) => {
  const seriesId = req.params.seriesId.toUpperCase();
  if (!SERIES.test(seriesId)) return res.status(400).json({ error: 'Invalid FRED series identifier.' });
  const key = process.env.JPTI_FRED_API_KEY;
  if (!key) return res.status(503).json({ error: 'FRED API key is not configured. Set JPTI_FRED_API_KEY on the server.' });
  const limit = Math.min(1000, Math.max(1, Number.parseInt(req.query.limit || '120', 10) || 120));
  const observationStart = String(req.query.observation_start || '').slice(0, 10);
  if (observationStart && !/^\d{4}-\d{2}-\d{2}$/.test(observationStart)) return res.status(400).json({ error: 'observation_start must use YYYY-MM-DD.' });
  try {
    const url = new URL('https://api.stlouisfed.org/fred/series/observations');
    url.search = new URLSearchParams({ series_id: seriesId, api_key: key, file_type: 'json', sort_order: 'desc', limit: String(limit), ...(observationStart ? { observation_start: observationStart } : {}) }).toString();
    const payload = await fetchJson(url);
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ seriesId, count: payload.observations?.length || 0, observations: payload.observations || [], source: source('Federal Reserve Bank of St. Louis FRED', 'live', new Date().toISOString(), { seriesId, units: 'provider-defined' }) });
  } catch (error) { next(error); }
});

intelligenceRouter.get('/onchain/evm/:chain/:address/transfers', async (req, res) => {
  const chain = req.params.chain.toLowerCase();
  const address = req.params.address;
  if (!CHAINS[chain]) return res.status(400).json({ error: 'Unsupported Alchemy EVM network.', supported: Object.keys(CHAINS) });
  if (!ADDRESS.test(address)) return res.status(400).json({ error: 'Invalid EVM address.' });
  const key = process.env.JPTI_ALCHEMY_API_KEY;
  if (!key) return res.status(503).json({ error: 'Alchemy API key is not configured. Set JPTI_ALCHEMY_API_KEY on the server.' });
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || '25', 10) || 25));
  const categories = ['external', 'internal', 'erc20'];
  const endpoint = `https://${CHAINS[chain]}.g.alchemy.com/v2/${encodeURIComponent(key)}`;
  try {
    const [outgoing, incoming] = await Promise.all(['outgoing', 'incoming'].map(async (direction) => {
      const params = { fromBlock: '0x0', toBlock: 'latest', category: categories, withMetadata: true, excludeZeroValue: true,
        maxCount: `0x${pageSize.toString(16)}`, [direction === 'outgoing' ? 'fromAddress' : 'toAddress']: address };
      const result = await fetchJson(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: direction, method: 'alchemy_getAssetTransfers', params: [params] }) });
      if (result.error) throw new Error(result.error.message || 'Alchemy transfer query failed');
      return result.result?.transfers || [];
    }));
    const unique = new Map([...outgoing, ...incoming].map((item) => [item.uniqueId || item.hash + item.from + item.to + item.value, item]));
    const transfers = [...unique.values()].sort((a, b) => (Number(b.metadata?.blockTimestamp ? Date.parse(b.metadata.blockTimestamp) : 0) || 0) - (Number(a.metadata?.blockTimestamp ? Date.parse(a.metadata.blockTimestamp) : 0) || 0));
    res.set('Cache-Control', 'no-store');
    res.json({ chain, address, transfers, count: transfers.length, source: source('Alchemy Transfers API', 'live', new Date().toISOString(), { coverage: 'external, internal and ERC-20 transfers returned by provider; not a complete attribution of wallet activity' }) });
  } catch (error) { res.status(502).json({ error: error.message || 'On-chain provider request failed' }); }
});

intelligenceRouter.get('/onchain/solana/:address/transactions', async (req, res) => {
  const address = req.params.address;
  if (!SOLANA_ADDRESS.test(address)) return res.status(400).json({ error: 'Invalid Solana address.' });
  const key = process.env.JPTI_HELIUS_API_KEY;
  if (!key) return res.status(503).json({ error: 'Helius API key is not configured. Set JPTI_HELIUS_API_KEY on the server.' });
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || '25', 10) || 25));
  try {
    const url = new URL(`https://api.helius.xyz/v0/addresses/${encodeURIComponent(address)}/transactions`);
    url.search = new URLSearchParams({ 'api-key': key, limit: String(limit) }).toString();
    const transactions = await fetchJson(url);
    res.set('Cache-Control', 'no-store');
    res.json({ chain: 'solana', address, transactions, count: Array.isArray(transactions) ? transactions.length : 0,
      source: source('Helius Enhanced Transactions API', 'live', new Date().toISOString(), { coverage: 'provider-indexed address history; token and program parsing depends on provider support' }) });
  } catch (error) { res.status(502).json({ error: error.message || 'Solana transaction provider request failed' }); }
});
