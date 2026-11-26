// JPTI configuration registry.
//
// Isomorphic on purpose (no imports, no Node APIs): the browser Connection Manager,
// the API server and the tests all use the same definitions.
//
// Provenance: every entry below was taken from a variable that is documented in
// .env.example / .env.frontend.example or is read directly by api/server.js,
// api/exchanges.js, api/providers.js, src/lib/config.js or the CI workflows.
// Nothing here is invented. Keys that are not listed are never dropped; the
// auditor reports them as "unclassified" until their purpose is verified.

export const CONFIG_CATEGORIES = Object.freeze([
  'Core Application',
  'API and Backend',
  'Database',
  'Authentication and Security',
  'Trading Exchanges',
  'Trading Risk and Governance',
  'Market Data Providers',
  'WebSocket Connections',
  'AI and Intelligence Services',
  'Blockchain and On-chain Data',
  'Wallet and Network Integrations',
  'Notifications and Messaging',
  'Analytics and Monitoring',
  'Background Workers and Scheduling',
  'Cloud Infrastructure',
  'Android and Mobile',
  'Advanced Configuration'
]);

const E = (name, category, service, description, extra = {}) => Object.freeze({
  name, category, service, description,
  format: 'string',
  required: false,
  sensitive: false,
  scope: 'backend', // backend | frontend (compiled into the public bundle) | ci (GitHub Actions, not editable here)
  restart: true,    // conservative default: assume the value is read at start-up
  dependencies: [],
  test: null,       // id understood by api/connection-tests.js (or 'websocket' for the browser)
  defaultValue: '',
  ...extra
});

const secret = (name, category, service, description, extra = {}) =>
  E(name, category, service, description, { format: 'secret', sensitive: true, ...extra });

const entries = [];
const add = (...items) => entries.push(...items);

// ---------------------------------------------------------------- Core Application
add(
  E('JPTI_TRADING_MODE', 'Core Application', 'Trading policy', 'Trading mode. "paper" keeps every order simulated.', { defaultValue: 'paper', dependencies: ['JPTI_ENABLE_LIVE_TRADING'] }),
  E('JPTI_ENABLE_LIVE_TRADING', 'Core Application', 'Trading policy', 'Master switch that allows live exchange orders. Never enabled automatically.', { format: 'boolean', defaultValue: 'false', dependencies: ['JPTI_TRADING_MODE', 'JPTI_LIVE_TRADING_SIGNOFF', 'JPTI_API_TOKEN'] }),
  E('JPTI_LIVE_TRADING_SIGNOFF', 'Core Application', 'Trading policy', 'Explicit operator acknowledgement of live-trading risk. Leave blank unless independently reviewed.'),
  E('JPTI_MAX_ORDER_NOTIONAL_USDT', 'Core Application', 'Trading policy', 'Maximum notional value of a single order in USDT.', { format: 'number', min: 0, defaultValue: '100', restart: false }),
  E('JPTI_AI_HOURLY_LIMIT', 'Core Application', 'AI spending guard', 'Maximum Workers AI model calls per rolling hour across agents, missions and the journal mentor. A positive whole number, or \"unlimited\". Over the cap, work is blocked with HTTP 429 before any model call.', { defaultValue: '60', restart: false }),
  E('JPTI_AI_DAILY_LIMIT', 'Core Application', 'AI spending guard', 'Maximum Workers AI model calls per rolling 24 hours. A positive whole number, or \"unlimited\".', { defaultValue: '400', restart: false }),
  E('JPTI_EVENT_RISK_FAIL_CLOSED', 'Core Application', 'Trading policy', 'Block live orders when the economic-calendar feed is unavailable.', { format: 'boolean', defaultValue: 'true', restart: false }),
  E('JPTI_DATA_DIR', 'Core Application', 'Local storage', 'Directory for the durable local event ledger. Keep outside public/static folders.', { format: 'path', defaultValue: 'data' }),
  E('VITE_APP_NAME', 'Core Application', 'Frontend build', 'Application display name (compiled into the public bundle).', { scope: 'frontend', defaultValue: 'JPTI' }),
  E('VITE_APP_ENV', 'Core Application', 'Frontend build', 'Frontend environment label (compiled into the public bundle).', { scope: 'frontend', defaultValue: 'development' })
);

// ---------------------------------------------------------------- API and Backend
add(
  E('JPTI_API_HOST', 'API and Backend', 'JPTI API', 'Interface the API binds to. Non-loopback hosts require JPTI_ALLOW_REMOTE_API=true and JPTI_API_TOKEN.', { format: 'host', defaultValue: '127.0.0.1' }),
  E('JPTI_API_PORT', 'API and Backend', 'JPTI API', 'API listening port (PORT takes precedence).', { format: 'port', defaultValue: '8787' }),
  E('PORT', 'API and Backend', 'JPTI API', 'Platform-provided listening port; overrides JPTI_API_PORT.', { format: 'port' }),
  E('JPTI_CORS_ORIGINS', 'API and Backend', 'JPTI API', 'Comma-separated browser/WebView origins allowed to call the API (include the Capacitor WebView origin for the Android app).', { format: 'origin-list', dependencies: ['VITE_API_BASE_URL'] }),
  E('JPTI_CORS_ORIGINS_EXTRA', 'API and Backend', 'JPTI API', 'Comma-separated origins merged into the CORS allow-list without replacing the built-in or JPTI_CORS_ORIGINS entries. Wildcards must look like https://*.example.com.', { format: 'origin-list' }),
  E('JPTI_TRUST_PROXY', 'API and Backend', 'JPTI API', 'Number of trusted reverse-proxy hops (for example 1 behind Cloudflare) so rate limits see real client IPs. "true" means one hop; blank, 0 or false disables it.', { format: 'string' }),
  E('JPTI_ALLOW_LOCAL_PRIVATE_ACCESS', 'API and Backend', 'JPTI API', 'Desktop-only: allow private routes without a token when bound to loopback.', { format: 'boolean', defaultValue: 'false' }),
  E('JPTI_ALLOW_REMOTE_API', 'API and Backend', 'JPTI API', 'Required acknowledgement before binding to a non-loopback host.', { format: 'boolean', defaultValue: 'false', dependencies: ['JPTI_API_HOST', 'JPTI_API_TOKEN'] }),
  E('JPTI_SERVE_WEB', 'API and Backend', 'JPTI API', 'Serve the built web app (dist) from the API process, giving app and API one public origin.', { format: 'boolean', defaultValue: 'false' }),
  E('JPTI_WEB_DIST', 'API and Backend', 'JPTI API', 'Directory of the built web app when JPTI_SERVE_WEB=true.', { format: 'path', defaultValue: 'dist' }),
  E('JPTI_TBOTS_PUBLIC_DIR', 'API and Backend', 'T-Bots', 'Static directory of the bundled T-Bots paper-trading UI.', { format: 'path', defaultValue: 'integrations/t-bots/public' }),
  E('JPTI_STREAM_MAX_CLIENTS', 'API and Backend', 'Market stream gateway', 'Maximum concurrent server-sent-event clients.', { format: 'integer', min: 1, max: 10000, defaultValue: '25' }),
  E('VITE_API_BASE_URL', 'API and Backend', 'Frontend build', 'Public Cloudflare Pages origin for native Android WebViews; leave blank for Cloudflare Pages web builds.', { scope: 'frontend', format: 'url', protocols: ['https:', 'http:'], test: 'api-health' }),
  E('VITE_API_PATH_PREFIX', 'API and Backend', 'Frontend build', 'Optional reverse-proxy path prefix placed before /api (for example /jpti).', { scope: 'frontend', format: 'path-prefix' })
);

// ---------------------------------------------------------------- Authentication and Security
add(
  secret('JPTI_API_TOKEN', 'Authentication and Security', 'JPTI API access token', 'Shared secret for private API routes and the configuration manager. Use at least 24 random characters.', { test: 'api-security', minLength: 24, restart: false })
);

// ---------------------------------------------------------------- Database
add(
  E('JPTI_STORAGE_BACKEND', 'Database', 'Persistence', 'Storage backend: file (local default) or postgres (durable).', { format: 'enum', values: ['file', 'postgres'], defaultValue: 'file', test: 'database', dependencies: ['DATABASE_URL'] }),
  secret('DATABASE_URL', 'Database', 'PostgreSQL', 'PostgreSQL connection string. Required when JPTI_STORAGE_BACKEND=postgres.', { format: 'url', protocols: ['postgres:', 'postgresql:'], test: 'database', dependencies: ['JPTI_STORAGE_BACKEND'] }),
  E('JPTI_DATABASE_SSL', 'Database', 'PostgreSQL', 'Enable TLS for managed/cloud PostgreSQL.', { format: 'boolean', defaultValue: 'false' }),
  E('JPTI_DATABASE_SSL_REJECT_UNAUTHORIZED', 'Database', 'PostgreSQL', 'Keep TLS certificate verification on (recommended).', { format: 'boolean', defaultValue: 'true' }),
  E('JPTI_DATABASE_SSL_CA', 'Database', 'PostgreSQL', 'PEM CA certificate (literal \\n allowed) or base64-encoded PEM used to verify the database TLS certificate. Takes precedence over JPTI_DATABASE_SSL_CA_FILE.', { dependencies: ['JPTI_DATABASE_SSL'] }),
  E('JPTI_DATABASE_SSL_CA_FILE', 'Database', 'PostgreSQL', 'Path to a PEM CA certificate file used to verify the database TLS certificate.', { format: 'path', dependencies: ['JPTI_DATABASE_SSL'] }),
  E('JPTI_DATABASE_QUERY_TIMEOUT_MS', 'Database', 'PostgreSQL', 'Client-side query timeout in milliseconds.', { format: 'integer', min: 1, defaultValue: '60000' }),
  E('JPTI_DATABASE_POOL_MAX', 'Database', 'PostgreSQL', 'Maximum pooled connections.', { format: 'integer', min: 1, max: 500, defaultValue: '10' })
);

// ---------------------------------------------------------------- Trading Exchanges
const EXCHANGES = [
  ['BINANCE', false], ['BYBIT', true], ['OKX', true], ['KUCOIN', true], ['KRAKEN', false],
  ['COINBASE', false], ['BITGET', true], ['GATEIO', false], ['MEXC', false], ['HTX', false]
];
for (const [id, hasPassword] of EXCHANGES) {
  const label = id.charAt(0) + id.slice(1).toLowerCase();
  add(
    secret('JPTI_' + id + '_API_KEY', 'Trading Exchanges', label, label + ' API key. Use a read-only key with withdrawals disabled.', { test: 'exchange', exchangeId: id }),
    secret('JPTI_' + id + '_API_SECRET', 'Trading Exchanges', label, label + ' API secret.', { test: 'exchange', exchangeId: id, dependencies: ['JPTI_' + id + '_API_KEY'] })
  );
  if (hasPassword) add(secret('JPTI_' + id + '_PASSWORD', 'Trading Exchanges', label, label + ' API passphrase.', { test: 'exchange', exchangeId: id }));
}
add(
  secret('JPTI_BITGET_API_PASSPHRASE', 'Trading Exchanges', 'Bitget CFD market data', 'Bitget UTA API passphrase for the signed Cloudflare CFD market-data service. Use a read-only key; this secret is consumed only by the Cloudflare Pages Function.', { dependencies: ['JPTI_BITGET_API_KEY', 'JPTI_BITGET_API_SECRET'] }),
  E('JPTI_EXCHANGE_TIMEOUT_MS', 'Trading Exchanges', 'CCXT gateway', 'Per-request exchange timeout in milliseconds.', { format: 'integer', min: 1000, max: 120000, defaultValue: '15000' }),
  E('JPTI_RECONCILE_EXCHANGES', 'Trading Exchanges', 'Reconciliation', 'Comma-separated exchange IDs for read-only balance reconciliation.', { format: 'csv-ids' }),
  E('JPTI_RECONCILE_OPENING_BALANCES_JSON', 'Trading Exchanges', 'Reconciliation', 'JSON object keyed by exchange then currency; verified opening balances only.', { format: 'json-object', defaultValue: '{}' }),
  E('JPTI_MONITOR_MARKETS', 'Trading Exchanges', 'Market monitor', 'Comma-separated exchange:symbol entries for the live monitor.', { format: 'markets' }),
  E('JPTI_FILL_SYNC_MARKETS', 'Trading Exchanges', 'Fill sync', 'Comma-separated exchange:symbol entries for private fill polling (read-only keys).', { format: 'markets' }),
  E('JPTI_FILL_SYNC_LOOKBACK_DAYS', 'Trading Exchanges', 'Fill sync', 'Historical fill look-back in days.', { format: 'integer', min: 1, max: 365, defaultValue: '7' }),
  E('JPTI_FILL_SYNC_PAGE_SIZE', 'Trading Exchanges', 'Fill sync', 'Fills per page.', { format: 'integer', min: 1, max: 1000, defaultValue: '250' }),
  E('JPTI_FILL_SYNC_MAX_PAGES', 'Trading Exchanges', 'Fill sync', 'Maximum pages per sync.', { format: 'integer', min: 1, max: 1000, defaultValue: '20' }),
  E('JPTI_FILL_SYNC_OVERLAP_MINUTES', 'Trading Exchanges', 'Fill sync', 'Overlap window that recovers late-arriving fills.', { format: 'integer', min: 0, max: 1440, defaultValue: '3' }),
  E('JPTI_TBOTS_CEX_MARKETS', 'Trading Exchanges', 'T-Bots', 'Cross-exchange spot paper watchlist (exchange:symbol, max 30).', { format: 'markets', max: 30 }),
  E('JPTI_MARKET_CACHE_TTL_MS', 'Trading Exchanges', 'CCXT gateway', 'Exchange market-metadata cache lifetime in milliseconds (values below 30000 are raised to 30000).', { format: 'integer', min: 30000, defaultValue: '300000' }),
  E('JPTI_CROSS_VENUE_OUTLIER_PERCENT', 'Trading Exchanges', 'Cross-exchange comparison', 'Cross-exchange quote outlier threshold (percent).', { format: 'number', min: 0, defaultValue: '0.5' }),
  E('JPTI_FUTURES_CACHE_MS', 'Trading Exchanges', 'Futures intelligence', 'Futures data cache lifetime (ms).', { format: 'integer', min: 0, defaultValue: '2000' }),
  E('JPTI_FUTURES_ESTIMATED_TAKER_FEE_BPS', 'Trading Exchanges', 'Futures intelligence', 'Estimated taker fee in basis points.', { format: 'number', min: 0, defaultValue: '6' }),
  E('JPTI_FUTURES_UNIVERSE_CACHE_MS', 'Trading Exchanges', 'Futures intelligence', 'Futures universe cache lifetime (ms).', { format: 'integer', min: 0, defaultValue: '900000' })
);

// ---------------------------------------------------------------- Trading Risk and Governance
add(
  E('JPTI_GOVERNANCE_MIN_CLOSED_TRADES', 'Trading Risk and Governance', 'Paper governance', 'Closed trades required before a strategy can be validated.', { format: 'integer', min: 1, defaultValue: '20' }),
  E('JPTI_GOVERNANCE_MIN_PROFIT_FACTOR', 'Trading Risk and Governance', 'Paper governance', 'Minimum profit factor for validation.', { format: 'number', min: 0, defaultValue: '1.05' }),
  E('JPTI_GOVERNANCE_MAX_TRIAL_SIZE_PCT', 'Trading Risk and Governance', 'Paper governance', 'Maximum trial position size (percent).', { format: 'number', min: 0, max: 100, defaultValue: '1' }),
  E('JPTI_GOVERNANCE_VALIDATED_SIZE_PCT', 'Trading Risk and Governance', 'Paper governance', 'Validated position size (percent).', { format: 'number', min: 0, max: 100, defaultValue: '2' }),
  E('JPTI_TBOTS_MAX_CONSECUTIVE_LOSSES', 'Trading Risk and Governance', 'T-Bots', 'Consecutive-loss circuit breaker.', { format: 'integer', min: 1, defaultValue: '3' }),
  E('JPTI_TBOTS_DAILY_LOSS_LIMIT_USD', 'Trading Risk and Governance', 'T-Bots', 'Daily loss limit in USD.', { format: 'number', min: 0, defaultValue: '100' }),
  E('JPTI_TBOTS_DAILY_LOSS_LIMIT_PCT', 'Trading Risk and Governance', 'T-Bots', 'Shared paper-equity drawdown (percent) that pauses T-Bots integration; values are clamped to 1-30.', { format: 'number', min: 1, max: 30, defaultValue: '10', restart: false }),
  E('JPTI_TBOTS_MAX_DRAWDOWN_PCT', 'Trading Risk and Governance', 'T-Bots', 'Shared paper drawdown (percent) at which the universal engine pauses trading; values are clamped to 1-50.', { format: 'number', min: 1, max: 50, defaultValue: '10', restart: false }),
  E('JPTI_PORTFOLIO_STRESS_SHOCK_PERCENT', 'Trading Risk and Governance', 'Portfolio risk', 'Uniform downside shock (percent) applied in the portfolio stress estimate; values are clamped to 0-100.', { format: 'number', min: 0, max: 100, defaultValue: '10', restart: false }),
  E('JPTI_TBOTS_PREFLIGHT_MAX_EVIDENCE_AGE_SECONDS', 'Trading Risk and Governance', 'T-Bots', 'Maximum age of pre-flight evidence (15-300 seconds).', { format: 'integer', min: 15, max: 300, defaultValue: '90' }),
  E('JPTI_FUTURES_PAPER_MAX_NOTIONAL_USD', 'Trading Risk and Governance', 'Futures paper desk', 'Maximum simulated notional per futures paper leg (USD).', { format: 'number', min: 0, defaultValue: '1000' })
);

// ---------------------------------------------------------------- Market Data Providers
// restart:false = the key is read from process.env on every request (verified in api/providers.js).
add(
  secret('JPTI_ALPACA_API_KEY', 'Market Data Providers', 'Alpaca', 'Alpaca API key ID (market data and paper account).', { test: 'alpaca', restart: false }),
  secret('JPTI_ALPACA_API_SECRET', 'Market Data Providers', 'Alpaca', 'Alpaca API secret.', { test: 'alpaca', restart: false, dependencies: ['JPTI_ALPACA_API_KEY'] }),
  secret('JPTI_QUIVER_API_KEY', 'Market Data Providers', 'Quiver Quantitative', 'Quiver Quantitative token (congressional trading data).', { test: 'quiver', restart: false }),
  secret('JPTI_FINNHUB_API_KEY', 'Market Data Providers', 'Finnhub', 'Finnhub API key.', { test: 'finnhub', restart: false }),
  secret('JPTI_ALPHAVANTAGE_API_KEY', 'Market Data Providers', 'Alpha Vantage', 'Alpha Vantage API key (free tier quotas are small; testing consumes one request).', { test: 'alphavantage', restart: false }),
  secret('JPTI_TWELVEDATA_API_KEY', 'Market Data Providers', 'Twelve Data', 'Twelve Data API key.', { test: 'twelvedata', restart: false }),
  secret('JPTI_FRED_API_KEY', 'Market Data Providers', 'FRED', 'FRED (St. Louis Fed) API key for macro series.', { test: 'fred' }),
  E('JPTI_ENABLE_ALPHAVANTAGE_CONSENSUS', 'Market Data Providers', 'Alpha Vantage', 'Include Alpha Vantage in cross-provider quote consensus.', { format: 'boolean', defaultValue: 'false', restart: false, dependencies: ['JPTI_ALPHAVANTAGE_API_KEY'] }),
  E('JPTI_ENABLE_BITGET_CONSENSUS', 'Market Data Providers', 'Bitget public market data', 'Include the public Bitget ticker in cross-provider quote consensus. Defaults on; can be disabled if rate-limits or symbol mapping conflicts arise.', { format: 'boolean', defaultValue: 'true', restart: false }),
  E('JPTI_BITGET_SNAPSHOT_CACHE_MS', 'Market Data Providers', 'Bitget market intelligence', 'Bitget public snapshot cache duration in milliseconds (1000–15000).', { format: 'integer', min: 1000, max: 15000, defaultValue: '5000', restart: false }),
  E('JPTI_QUOTE_CACHE_TTL_MS', 'Market Data Providers', 'Quote consensus', 'Quote cache lifetime in ms (code clamps to 10000-300000; read at start-up).', { format: 'integer', min: 10000, max: 300000, defaultValue: '30000' }),
  E('JPTI_QUOTE_STALE_AFTER_SECONDS', 'Market Data Providers', 'Quote consensus', 'Age after which a quote is flagged stale (60-3600).', { format: 'integer', min: 60, max: 3600, defaultValue: '900', restart: false }),
  E('JPTI_QUOTE_OUTLIER_THRESHOLD_PERCENT', 'Market Data Providers', 'Quote consensus', 'Outlier threshold in percent (minimum 0.75).', { format: 'number', min: 0.75, defaultValue: '1.5', restart: false }),
  E('JPTI_LIQUID_API_BASE_URL', 'Market Data Providers', 'Liquid (legacy)', 'Legacy Liquid public-products probe base URL. Not an active execution venue.', { format: 'url', protocols: ['https:'], defaultValue: 'https://api.liquid.com', test: 'liquid', restart: false }),
  E('JPTI_FOREX_FACTORY_CALENDAR_URL', 'Market Data Providers', 'Economic calendar', 'Optional approved economic-calendar JSON feed URL.', { format: 'url', protocols: ['https:'], test: 'calendar' })
);

// ---------------------------------------------------------------- Blockchain and On-chain Data
add(
  secret('JPTI_ALCHEMY_API_KEY', 'Blockchain and On-chain Data', 'Alchemy', 'Alchemy key for EVM transfer history (Ethereum, Base, Polygon, Arbitrum, Optimism).', { test: 'alchemy' }),
  secret('JPTI_HELIUS_API_KEY', 'Blockchain and On-chain Data', 'Helius', 'Helius key for Solana enhanced transaction history.', { test: 'helius' }),
  secret('JPTI_INFURA_API_KEY', 'Blockchain and On-chain Data', 'Infura', 'Infura key for read-only JSON-RPC.', { test: 'infura', restart: false }),
  E('JPTI_TBOTS_DEX_WATCHLIST', 'Blockchain and On-chain Data', 'T-Bots', 'Multi-chain DEX watchlist as chain:contract-address entries (max 60).', { format: 'dex-list', max: 60 })
);

// ---------------------------------------------------------------- Background Workers and Scheduling
const interval = (name, desc, min, max, dflt) => E(name, 'Background Workers and Scheduling', 'Scheduler', desc, { format: 'integer', min, max, defaultValue: String(dflt) });
add(
  E('JPTI_SCHEDULER_ENABLED', 'Background Workers and Scheduling', 'Scheduler', 'Run the background scheduler.', { format: 'boolean', defaultValue: 'true' }),
  E('JPTI_SCHEDULER_LEASE_MS', 'Background Workers and Scheduling', 'Scheduler', 'Leader-lease duration for PostgreSQL deployments (ms).', { format: 'integer', min: 1000, defaultValue: '30000' }),
  E('JPTI_SCHEDULER_HEARTBEAT_MS', 'Background Workers and Scheduling', 'Scheduler', 'Leader heartbeat interval (ms).', { format: 'integer', min: 500, defaultValue: '10000' }),
  E('JPTI_SCHEDULER_INSTANCE_ID', 'Background Workers and Scheduling', 'Scheduler', 'Optional stable instance identifier.'),
  interval('JPTI_MM_INTERVAL_SECONDS', 'Market-maker interval (seconds, 1-3600).', 1, 3600, 5),
  interval('JPTI_MARKET_MONITOR_INTERVAL_SECONDS', 'Market monitor interval (seconds, 1-3600).', 1, 3600, 5),
  interval('JPTI_MARKET_DATA_REFRESH_INTERVAL_SECONDS', 'Market data refresh (seconds, 1-3600).', 1, 3600, 5),
  interval('JPTI_RECONCILE_INTERVAL_SECONDS', 'Reconciliation interval (seconds, 5-86400).', 5, 86400, 30),
  interval('JPTI_INVESTOR_MONITOR_INTERVAL_SECONDS', 'Investor monitor interval (seconds, 5-86400).', 5, 86400, 60),
  interval('JPTI_PROVIDER_HEALTH_INTERVAL_SECONDS', 'Provider health interval (seconds, 30-86400).', 30, 86400, 300),
  interval('JPTI_NEWS_REFRESH_INTERVAL_SECONDS', 'News refresh (seconds, 10-86400).', 10, 86400, 60),
  interval('JPTI_ONCHAIN_REFRESH_INTERVAL_SECONDS', 'On-chain refresh (seconds, 5-86400).', 5, 86400, 30),
  interval('JPTI_MONITOR_PERSIST_INTERVAL_SECONDS', 'Monitor snapshot persistence interval (seconds).', 1, 86400, 60)
);

// ---------------------------------------------------------------- Edge intelligence alerts (scheduler Worker)
add(
  secret('JPTI_ALERT_WEBHOOK_URL', 'Notifications and Messaging', 'Edge alerts', 'HTTPS webhook that receives JSON alerts from the edge intelligence scheduler (Worker secret).'),
  secret('JPTI_ALERT_WEBHOOK_SECRET', 'Notifications and Messaging', 'Edge alerts', 'Optional HMAC-SHA256 key; adds an x-jpti-signature header to webhook deliveries (Worker secret).', { dependencies: ['JPTI_ALERT_WEBHOOK_URL'] }),
  secret('JPTI_TELEGRAM_BOT_TOKEN', 'Notifications and Messaging', 'Edge alerts', 'Telegram bot token used to deliver alert digests (Worker secret).', { dependencies: ['JPTI_TELEGRAM_CHAT_ID'] }),
  E('JPTI_TELEGRAM_CHAT_ID', 'Notifications and Messaging', 'Edge alerts', 'Telegram chat that receives alert digests.', { dependencies: ['JPTI_TELEGRAM_BOT_TOKEN'] }),
  E('JPTI_ALERT_MIN_SEVERITY', 'Notifications and Messaging', 'Edge alerts', 'Lowest severity delivered: info, warning or critical.', { defaultValue: 'warning', restart: false }),
  E('JPTI_ALERT_ON_WATCH', 'Notifications and Messaging', 'Edge alerts', 'Also alert when an edge moves to "watch" status.', { format: 'boolean', defaultValue: 'false', restart: false }),
  E('JPTI_ALERT_MAX_CONSECUTIVE_LOSSES', 'Notifications and Messaging', 'Edge alerts', 'Consecutive losing trades that raise a loss-streak alert.', { format: 'integer', min: 2, defaultValue: '5', restart: false }),
  E('JPTI_ALERT_DAILY_LOSS_R', 'Notifications and Messaging', 'Edge alerts', 'Daily loss (in R) that raises a daily-loss-limit alert.', { format: 'number', min: 0, defaultValue: '6', restart: false }),
  E('JPTI_ALERT_DRAWDOWN_R', 'Notifications and Messaging', 'Edge alerts', 'Rolling drawdown (in R) that raises a drawdown-limit alert.', { format: 'number', min: 0, defaultValue: '10', restart: false })
);

// ---------------------------------------------------------------- WebSocket / Analytics (frontend)
add(
  E('VITE_WS_URL', 'WebSocket Connections', 'Frontend build', 'Optional WebSocket endpoint (WSS required except localhost). Live streams otherwise use server-sent events.', { scope: 'frontend', format: 'ws-url', test: 'websocket' }),
  E('VITE_ENABLE_ANALYTICS', 'Analytics and Monitoring', 'Frontend build', 'Enable analytics flags; Cloudflare Web Analytics is configured at the Pages project level.', { scope: 'frontend', format: 'boolean', defaultValue: 'true' }),
  E('VITE_ENABLE_CRASH_REPORTING', 'Analytics and Monitoring', 'Frontend build', 'Enable crash reporting.', { scope: 'frontend', format: 'boolean', defaultValue: 'true' }),
  E('VITE_ENABLE_PERFORMANCE_MONITORING', 'Analytics and Monitoring', 'Frontend build', 'Enable performance monitoring.', { scope: 'frontend', format: 'boolean', defaultValue: 'true' }),
  E('VITE_ENABLE_CONFIG_DIAGNOSTICS', 'Analytics and Monitoring', 'Frontend build', 'Enable configuration diagnostics.', { scope: 'frontend', format: 'boolean', defaultValue: 'true' })
);

// ---------------------------------------------------------------- CI / Android (GitHub Actions; reference only)
add(
  E('JPTI_API_BASE_URL', 'Cloud Infrastructure', 'GitHub Pages build', 'GitHub Actions repository variable: HTTPS API origin baked into the Pages build.', { scope: 'ci', format: 'url', protocols: ['https:'], restart: false }),
  E('JPTI_DESKTOP_INSTANCE_ID', 'Advanced Configuration', 'Desktop shell', 'Set by the Electron desktop shell; not normally user-edited.')
);

export const CONFIG_REGISTRY = Object.freeze(entries);
const STATIC = new Map(CONFIG_REGISTRY.map((entry) => [entry.name, entry]));

// ------------------------------------------------------------------ dynamic keys
// api/exchanges.js builds JPTI_<EXCHANGE_ID>_{API_KEY,API_SECRET,PASSWORD,UID} for ANY CCXT adapter.
const EXCHANGE_KEY = /^JPTI_([A-Z0-9]+(?:_[A-Z0-9]+)*)_(API_KEY|API_SECRET|PASSWORD|UID)$/;
// api/providers.js reads JPTI_<PROVIDER>_MIN_INTERVAL_MS for quote throttling.
const THROTTLE_KEY = /^JPTI_([A-Z0-9]+)_MIN_INTERVAL_MS$/;

export const exchangeEnvKey = (id, suffix) => 'JPTI_' + String(id).replace(/[^a-z0-9]/gi, '_').toUpperCase() + '_' + suffix;

export function classifyKey(name) {
  const known = STATIC.get(name);
  if (known) return known;
  let match = EXCHANGE_KEY.exec(name);
  if (match) {
    const [, id, suffix] = match;
    return E(name, 'Trading Exchanges', id.toLowerCase() + ' (CCXT adapter)', 'Credential for any CCXT exchange adapter (' + suffix + ').', {
      format: suffix === 'UID' ? 'string' : 'secret', sensitive: true, test: 'exchange', exchangeId: id, dynamic: true
    });
  }
  match = THROTTLE_KEY.exec(name);
  if (match) {
    return E(name, 'Market Data Providers', match[1].toLowerCase() + ' throttle', 'Minimum spacing between quote requests (ms).', { format: 'integer', min: 0, max: 3600000, dynamic: true, restart: false });
  }
  return null;
}

export const isServerEligibleKey = (name) => /^(JPTI_[A-Z0-9_]+|DATABASE_URL|PORT)$/.test(name) && name !== 'JPTI_CONFIG_ENCRYPTION_KEY';

export function restartRequiredFor(names) {
  return [...new Set(names)].filter((name) => {
    const entry = classifyKey(name);
    return !entry || entry.restart !== false;
  });
}

// ------------------------------------------------------------------ validation
const PLACEHOLDER = /^(replace[-_ ]?with|your[-_ ]|change[-_ ]?me|example|<.+>|x{4,}$|todo)/i;
const ok = () => ({ ok: true, severity: 'ok', code: 'valid', message: '' });
const bad = (severity, code, message) => ({ ok: false, severity, code, message });
const isLoopback = (host) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(String(host).toLowerCase());

function parseOriginLike(text) {
  try {
    const url = new URL(text);
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
    return url.protocol + '//' + url.host; // works for capacitor:// too, where URL.origin is "null"
  } catch { return null; }
}

export function validateValue(entry, rawValue) {
  const value = rawValue == null ? '' : String(rawValue);
  const trimmed = value.trim();
  if (!trimmed) return entry.required ? bad('error', 'required', 'A value is required.') : ok();
  switch (entry.format) {
    case 'boolean':
      return /^(true|false)$/.test(trimmed) ? ok() : bad('error', 'format', 'Use exactly true or false (lower-case); the server compares against the literal string "true".');
    case 'integer':
    case 'port': {
      if (!/^-?\d+$/.test(trimmed)) return bad('error', 'format', 'Enter a whole number.');
      const n = Number(trimmed);
      const min = entry.format === 'port' ? 1 : entry.min, max = entry.format === 'port' ? 65535 : entry.max;
      if (min !== undefined && n < min) return bad('error', 'range', 'Must be at least ' + min + '.');
      if (max !== undefined && n > max) return bad('error', 'range', 'Must be at most ' + max + '.');
      return ok();
    }
    case 'number': {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return bad('error', 'format', 'Enter a number.');
      if (entry.min !== undefined && n < entry.min) return bad('error', 'range', 'Must be at least ' + entry.min + '.');
      if (entry.max !== undefined && n > entry.max) return bad('error', 'range', 'Must be at most ' + entry.max + '.');
      return ok();
    }
    case 'url': {
      let url;
      try { url = new URL(trimmed); } catch { return bad('error', 'format', 'Enter a complete URL including the scheme.'); }
      const protocols = entry.protocols || ['https:', 'http:'];
      if (!protocols.includes(url.protocol)) return bad('error', 'protocol', 'Allowed schemes: ' + protocols.join(', ').replace(/:/g, '') + '.');
      if (entry.scope === 'frontend' && (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== ''))) return bad('error', 'format', 'Use only the origin (no credentials, path, query or fragment).');
      if (url.protocol === 'http:' && !isLoopback(url.hostname) && entry.scope !== 'backend') return bad('error', 'insecure', 'Remote URLs must use HTTPS; HTTP is allowed only for localhost.');
      return ok();
    }
    case 'ws-url': {
      if (!/^wss:\/\//i.test(trimmed) && !/^ws:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(trimmed)) return bad('error', 'insecure', 'Use wss:// (ws:// only for localhost).');
      try { new URL(trimmed); return ok(); } catch { return bad('error', 'format', 'Enter a valid WebSocket URL.'); }
    }
    case 'path-prefix':
      return /^\/[A-Za-z0-9._~\-\/]*$/.test(trimmed) && !trimmed.includes('//') && !trimmed.includes('..') ? ok() : bad('error', 'format', 'Start with / and use only path characters, for example /jpti.');
    case 'host':
      return /^[A-Za-z0-9.\-:\[\]]+$/.test(trimmed) ? ok() : bad('error', 'format', 'Enter a host name or IP address.');
    case 'enum':
      return entry.values.includes(trimmed) ? ok() : bad('error', 'enum', 'Allowed values: ' + entry.values.join(', ') + '.');
    case 'origin-list': {
      const items = trimmed.split(',').map((item) => item.trim()).filter(Boolean);
      for (const item of items) {
        if (item === '*') return bad('warning', 'wildcard', 'A wildcard origin is not supported by the JPTI CORS allow-list and would be ignored.');
        const origin = parseOriginLike(item);
        if (!origin || origin !== item.replace(/\/$/, '')) return bad('error', 'format', '"' + item + '" is not a bare origin such as https://app.example.com.');
      }
      return ok();
    }
    case 'json-object':
      try {
        const parsed = JSON.parse(trimmed);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? ok() : bad('error', 'format', 'Must be a JSON object.');
      } catch { return bad('error', 'format', 'Must be valid JSON.'); }
    case 'csv-ids': {
      const items = trimmed.split(',').map((item) => item.trim()).filter(Boolean);
      return items.every((item) => /^[a-z0-9_]+$/.test(item)) ? ok() : bad('error', 'format', 'Use comma-separated lower-case exchange IDs.');
    }
    case 'markets': {
      const items = trimmed.split(',').map((item) => item.trim()).filter(Boolean);
      if (entry.max && items.length > entry.max) return bad('error', 'range', 'At most ' + entry.max + ' entries.');
      const badItem = items.find((item) => !/^[a-z0-9_]+:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/.test(item));
      return badItem ? bad('error', 'format', '"' + badItem + '" must look like exchange:BASE/QUOTE.') : ok();
    }
    case 'dex-list': {
      const items = trimmed.split(',').map((item) => item.trim()).filter(Boolean);
      if (entry.max && items.length > entry.max) return bad('error', 'range', 'At most ' + entry.max + ' entries.');
      const badItem = items.find((item) => !/^[a-z0-9_-]+:[A-Za-z0-9]{16,100}$/.test(item));
      return badItem ? bad('error', 'format', '"' + badItem + '" must look like chain:contract-address.') : ok();
    }
    case 'path':
      return trimmed.includes('\0') ? bad('error', 'format', 'Invalid path.') : ok();
    case 'secret': {
      if (/\s/.test(trimmed)) return bad('warning', 'whitespace', 'Contains whitespace; credentials normally do not.');
      if (PLACEHOLDER.test(trimmed)) return bad('warning', 'placeholder', 'Looks like a placeholder, not a real credential.');
      if (trimmed.length < (entry.minLength || 8)) return bad('warning', 'short', 'Shorter than expected (' + (entry.minLength || 8) + '+ characters).');
      return ok();
    }
    default:
      return ok();
  }
}

// ------------------------------------------------------------------ auditor
const PUBLIC_SECRET = /^VITE_.*(SECRET|TOKEN|PASSWORD|PRIVATE|SERVICE_ACCOUNT|API_?KEY)/i;

export function auditConfiguration(values = {}, { duplicates = {} } = {}) {
  const issues = [];
  const add = (severity, code, key, message, remediation = '') => issues.push({ severity, code, key: key || null, message, remediation });
  const val = (key) => String(values[key] ?? '').trim();
  const has = (key) => val(key) !== '';
  const unclassified = [];

  for (const [key, raw] of Object.entries(values)) {
    if (PUBLIC_SECRET.test(key) && String(raw ?? '').trim()) {
      add('error', 'public-secret', key, 'VITE_ variables are compiled into the public bundle, so this secret-looking value would be exposed.', 'Rename it without the VITE_ prefix and keep it on the server.');
      continue;
    }
    const entry = classifyKey(key);
    if (!entry) {
      unclassified.push(key);
      add('info', 'unclassified', key, 'Not recognised by the JPTI source registry. It is preserved unchanged until its purpose is verified.', 'Confirm which module reads it, or remove it if unused.');
      continue;
    }
    const check = validateValue(entry, raw);
    if (!check.ok) add(check.severity, check.code, key, check.message, 'Correct the value or clear it to use the default' + (entry.defaultValue ? ' (' + entry.defaultValue + ')' : '') + '.');
    if (entry.scope === 'frontend') add('info', 'build-time', key, 'Compiled into the frontend build; it has no effect on a running server.', 'Set it in a frontend env file or CI variable and rebuild.');
    else if (entry.scope === 'ci') add('info', 'ci-only', key, 'Configured in GitHub Actions, not in the app.', 'Manage it under repository Settings > Secrets and variables.');
    else if (!isServerEligibleKey(key)) add('info', 'client-only', key, 'Will not be sent to the server.', '');
  }

  for (const [key, lines] of Object.entries(duplicates)) {
    add('warning', 'duplicate', key, 'Defined ' + lines.length + ' times (lines ' + lines.join(', ') + '); the last value wins.', 'Delete the extra definitions.');
  }

  // Cross-field rules (these mirror checks the server itself enforces).
  const backend = (val('JPTI_STORAGE_BACKEND') || 'file').toLowerCase();
  if (backend === 'postgres' && !has('DATABASE_URL')) add('error', 'missing-required', 'DATABASE_URL', 'JPTI_STORAGE_BACKEND=postgres requires DATABASE_URL.', 'Add the PostgreSQL connection string or switch the backend to file.');
  if (backend !== 'postgres' && has('DATABASE_URL')) add('info', 'unused', 'DATABASE_URL', 'DATABASE_URL is set but the storage backend is not postgres, so it is ignored.', 'Set JPTI_STORAGE_BACKEND=postgres to use it.');

  const live = val('JPTI_ENABLE_LIVE_TRADING') === 'true';
  const mode = (val('JPTI_TRADING_MODE') || 'paper').toLowerCase();
  if (live && mode === 'paper') add('error', 'conflict', 'JPTI_ENABLE_LIVE_TRADING', 'Live trading is enabled while JPTI_TRADING_MODE=paper.', 'Decide deliberately: keep both paper/false, or set both after independent risk review.');
  if (!live && mode !== 'paper') add('warning', 'conflict', 'JPTI_TRADING_MODE', 'Trading mode is not paper but live trading is not enabled.', 'Set JPTI_TRADING_MODE=paper unless you intend to go live.');
  if (live && !has('JPTI_LIVE_TRADING_SIGNOFF')) add('warning', 'missing-recommended', 'JPTI_LIVE_TRADING_SIGNOFF', 'Live trading is enabled without an operator sign-off.', 'Complete a documented risk review before enabling live orders.');
  if (live && !has('JPTI_API_TOKEN')) add('error', 'missing-required', 'JPTI_API_TOKEN', 'Live trading requires a configured API token.', 'Generate a long random token.');

  const host = val('JPTI_API_HOST');
  if (host && !isLoopback(host) && (val('JPTI_ALLOW_REMOTE_API') !== 'true' || !has('JPTI_API_TOKEN'))) {
    add('error', 'missing-required', 'JPTI_ALLOW_REMOTE_API', 'A non-loopback JPTI_API_HOST requires JPTI_ALLOW_REMOTE_API=true and a strong JPTI_API_TOKEN, otherwise the API refuses to start.', 'Set both, or bind to 127.0.0.1.');
  }
  const token = val('JPTI_API_TOKEN');
  if (token && /^replace-with/i.test(token)) add('error', 'placeholder', 'JPTI_API_TOKEN', 'The placeholder token is rejected by the configuration endpoint.', 'Generate a random token of at least 24 characters.');

  for (const [id] of EXCHANGES) {
    const k = values['JPTI_' + id + '_API_KEY'], s = values['JPTI_' + id + '_API_SECRET'];
    if (String(k ?? '').trim() && !String(s ?? '').trim()) add('error', 'incomplete-pair', 'JPTI_' + id + '_API_SECRET', 'API key set without its secret.', 'Add the secret; private calls need both.');
    if (String(s ?? '').trim() && !String(k ?? '').trim()) add('error', 'incomplete-pair', 'JPTI_' + id + '_API_KEY', 'API secret set without its key.', 'Add the key; private calls need both.');
  }
  if (String(values.JPTI_ALPACA_API_KEY ?? '').trim() && !String(values.JPTI_ALPACA_API_SECRET ?? '').trim()) add('error', 'incomplete-pair', 'JPTI_ALPACA_API_SECRET', 'Alpaca key set without its secret.', 'Add the secret.');
  if (String(values.JPTI_ALPACA_API_SECRET ?? '').trim() && !String(values.JPTI_ALPACA_API_KEY ?? '').trim()) add('error', 'incomplete-pair', 'JPTI_ALPACA_API_KEY', 'Alpaca secret set without its key.', 'Add the key.');
  if (val('JPTI_ENABLE_ALPHAVANTAGE_CONSENSUS') === 'true' && !has('JPTI_ALPHAVANTAGE_API_KEY')) add('warning', 'missing-required', 'JPTI_ALPHAVANTAGE_API_KEY', 'Alpha Vantage consensus is enabled without a key.', 'Add the key or disable the flag.');

  const counts = { error: 0, warning: 0, info: 0 };
  issues.forEach((issue) => { counts[issue.severity] = (counts[issue.severity] || 0) + 1; });
  return { ok: counts.error === 0, counts, issues, unclassified };
}

export function groupRegistryByCategory(entriesList = CONFIG_REGISTRY) {
  const grouped = Object.fromEntries(CONFIG_CATEGORIES.map((category) => [category, []]));
  for (const entry of entriesList) (grouped[entry.category] ||= []).push(entry);
  return grouped;
}
