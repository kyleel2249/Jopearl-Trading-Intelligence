const has = (env, ...keys) => keys.every(key => Boolean(String(env[key] || '').trim()));
const statusFor = (sources, providers) => {
  const configured = sources.filter(id => providers[id]?.configured).length;
  const publicCount = sources.filter(id => providers[id]?.public).length;
  if (configured + publicCount === 0) return 'not_configured';
  if (configured + publicCount === sources.length) return 'configured_partial_coverage';
  return 'partially_configured';
};

export function buildUniversalCoverage(env = process.env, exchanges = []) {
  const providers = {
    ccxt: { configured: exchanges.length > 0, public: false, scope: 'Public exchange market metadata and supported public endpoints; individual instruments/capabilities vary by venue.' },
    dexscreener: { configured: true, public: true, scope: 'Provider-limited multi-chain DEX pair discovery and token-pair observations.' },
    rugcheck: { configured: true, public: true, scope: 'Solana token risk observations; not a safety guarantee.' },
    goplus: { configured: true, public: true, scope: 'Selected EVM token security observations; unsupported chains fail closed.' },
    coingecko: { configured: true, public: true, scope: 'Crypto reference and aggregate market data; not an executable quote.' },
    defillama: { configured: true, public: true, scope: 'DeFi TVL, stablecoin and protocol metrics; protocol identity must be verified.' },
    alpaca: { configured: has(env, 'JPTI_ALPACA_API_KEY', 'JPTI_ALPACA_API_SECRET'), public: false, scope: 'US equities and crypto data subject to account/feed entitlements; paper account activity is read-only.' },
    finnhub: { configured: has(env, 'JPTI_FINNHUB_API_KEY'), public: false, scope: 'Equity quotes/candles and selected market news subject to plan and exchange coverage.' },
    alphavantage: { configured: has(env, 'JPTI_ALPHAVANTAGE_API_KEY'), public: false, scope: 'Equity and selected cross-asset reference/time-series endpoints subject to quota and plan.' },
    twelvedata: { configured: has(env, 'JPTI_TWELVEDATA_API_KEY'), public: false, scope: 'Cross-asset quote/time-series coverage depends on symbol mapping, exchange and plan.' },
    fred: { configured: has(env, 'JPTI_FRED_API_KEY'), public: false, scope: 'Macroeconomic series, not live tradable instrument quotes.' },
    alchemy: { configured: has(env, 'JPTI_ALCHEMY_API_KEY'), public: false, scope: 'Indexed EVM chain data for configured networks; not a complete chain archive.' },
    helius: { configured: has(env, 'JPTI_HELIUS_API_KEY'), public: false, scope: 'Solana enhanced transaction data; not a complete wallet-intent model.' },
    infura: { configured: has(env, 'JPTI_INFURA_API_KEY'), public: false, scope: 'Allowlisted read-only EVM RPC methods; not price data.' },
    gdelt: { configured: true, public: true, scope: 'Global news discovery; source credibility and event classification require validation.' }
  };

  const assetClasses = [
    { id: 'crypto_spot', label: 'Crypto spot', sources: ['ccxt', 'coingecko'], execution: 'T-Bots paper watchlist supports configured exchange spot pairs.' },
    { id: 'crypto_perpetual', label: 'Crypto perpetuals', sources: ['ccxt'], execution: 'Research context only in the universal T-Bots feed; no universal derivatives executor.' },
    { id: 'crypto_futures_options', label: 'Crypto futures & options', sources: ['ccxt'], execution: 'Venue and contract-specific; no universal order adapter.' },
    { id: 'dex_tokens', label: 'Multi-chain DEX tokens', sources: ['dexscreener', 'rugcheck', 'goplus'], execution: 'T-Bots paper positions only; provider/chain coverage is limited.' },
    { id: 'defi_protocols', label: 'DeFi protocols', sources: ['defillama'], execution: 'Research and ranking only; no protocol execution.' },
    { id: 'equities_etfs', label: 'Equities & ETFs', sources: ['alpaca', 'finnhub', 'alphavantage', 'twelvedata'], execution: 'Market-data integrations exist; T-Bots asset-class execution adapter is not implemented.' },
    { id: 'forex', label: 'Forex', sources: ['twelvedata', 'fred'], execution: 'Research framework only; no dedicated FX execution adapter.' },
    { id: 'commodities', label: 'Commodities', sources: ['twelvedata', 'fred'], execution: 'Research framework only; instrument/contract coverage depends on provider.' },
    { id: 'indices', label: 'Indices', sources: ['twelvedata', 'fred'], execution: 'Research framework only; index quote and tradable derivative are distinct instruments.' },
    { id: 'bonds_rates', label: 'Bonds & rates', sources: ['fred', 'twelvedata'], execution: 'Macro series and selected quote coverage; no bond execution adapter.' },
    { id: 'onchain', label: 'On-chain activity', sources: ['alchemy', 'helius', 'infura'], execution: 'Selected chain read-only observations; no signing, bridging or withdrawals.' },
    { id: 'news_events', label: 'News & events', sources: ['gdelt', 'finnhub', 'alphavantage'], execution: 'Discovery only; event verification and timestamps required.' }
  ].map(item => {
    const available = item.sources.filter(id => providers[id].configured || providers[id].public);
    const missing = item.sources.filter(id => !providers[id].configured && !providers[id].public);
    return { ...item, status: available.length === item.sources.length ? 'available_with_limits' : available.length ? 'partial' : 'not_configured',
      availableSources: available, missingSources: missing };
  });

  return {
    generatedAt: new Date().toISOString(),
    assessment: 'configuration_and_catalog_only',
    providers,
    assetClasses,
    exchangeCatalog: { supportedVenueCount: exchanges.length, derivativeCapableVenueCount: exchanges.filter(x => x.capabilities?.fetchFundingRate || x.capabilities?.fetchPositions).length },
    watchlists: {
      cexEntriesConfigured: String(env.JPTI_TBOTS_CEX_MARKETS || '').split(',').map(x => x.trim()).filter(Boolean).length,
      dexEntriesConfigured: String(env.JPTI_TBOTS_DEX_WATCHLIST || '').split(',').map(x => x.trim()).filter(Boolean).length
    },
    caveats: [
      'This endpoint reports configured credentials and adapter/catalog coverage only. It does not perform provider health checks or prove that a specific symbol is entitled, live or tradable.',
      'Provider coverage, rate limits, exchange permissions, regional eligibility and market-data licensing vary. Missing configuration is never interpreted as a zero market value.',
      'Only configured CEX watchlist pairs are passed to T-Bots. Equities, FX, commodities, indices and bonds do not yet have T-Bots execution adapters.',
      'All T-Bots trading remains paper-only. No wallet signing, DEX swaps, live exchange orders, bridging or withdrawals are enabled.'
    ]
  };
}
