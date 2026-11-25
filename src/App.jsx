import React, { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
const ExchangeConnectivity = lazy(() => import('./ExchangeConnectivity.jsx'));
const MultiChartWorkstation = lazy(() => import('./MultiChartWorkstation.jsx'));
import Dashboard from './Dashboard.jsx';
import AgentDashboardOverview from './AgentDashboardOverview.jsx';
import TerminalDashboard from './TerminalDashboard.jsx';
const FinancialIntelligence = lazy(() => import('./FinancialIntelligence.jsx'));
const ReflectiveJournal = lazy(() => import('./ReflectiveJournal.jsx'));
const PairScanner = lazy(() => import('./PairScanner.jsx'));
const UniversalEngine = lazy(() => import('./UniversalEngine.jsx'));
const ConnectionSettings = lazy(() => import('./ConnectionSettings.jsx'));
const InstitutionalTerminal = lazy(() => import('./InstitutionalTerminal.jsx'));
const InstitutionalGovernance = lazy(() => import('./InstitutionalGovernance.jsx'));
const FuturesIntelligence = lazy(() => import('./FuturesIntelligence.jsx'));
const AssetIntelligence = lazy(() => import('./AssetIntelligence.jsx'));
const ResearchCouncil = lazy(() => import('./ResearchCouncil.jsx'));
const PortfolioAllocation = lazy(() => import('./PortfolioAllocation.jsx'));
const MarketStream = lazy(() => import('./MarketStream.jsx'));
const OpportunityRadar = lazy(() => import('./OpportunityRadar.jsx'));
const Phase15To21Workspaces = lazy(() => import('./Phase15To21Workspaces.jsx'));
const AlphaSignalEngine = lazy(() => import('./AlphaSignalEngine.jsx'));
const SignalIntelligenceDashboard = lazy(() => import('../dashboard/app/DashboardApp.jsx'));
const CalendarSessions = lazy(() => import('./CalendarSessions.jsx'));
const InstitutionalMarketIntelligence = lazy(() => import('./InstitutionalMarketIntelligence.jsx'));
const AgentCommandCenter = lazy(() => import('./AgentCommandCenter.jsx'));
const AutonomousDepartments = lazy(() => import('./AutonomousDepartments.jsx'));
const IntelligenceFoundation = lazy(() => import('./IntelligenceFoundation.jsx'));
const PaperTradingCommandCenter = lazy(() => import('./PaperTradingCommandCenter.jsx'));
import { apiFetch, apiUrl, isApiUnavailable } from './lib/api.js';
import {
  Activity, BarChart3, Bell, Blocks, Bot, BrainCircuit, CandlestickChart, BookOpen,
  ChevronRight, CircleHelp, Command, Cpu, Database, Gauge, Globe2, TrendingUp, FlaskConical,
  LayoutDashboard, Menu, Network, Newspaper, Radio, RefreshCw, Search,
  Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Wallet, X, Zap, Download, PackageCheck, ExternalLink
} from 'lucide-react';

// Workspaces are loaded on demand so first paint stays fast on low-end Android devices,
// and each one is isolated: a failed chunk or render error never takes down the shell.
class WorkspaceBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { console.error('JPTI workspace failed:', error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="glass-panel detail-workspace" role="alert">
        <span className="eyebrow">WORKSPACE UNAVAILABLE</span>
        <h3>This workspace could not load</h3>
        <p>{String(this.state.error?.message || this.state.error).slice(0, 300)}</p>
        <p className="subtle-note">The rest of JPTI is unaffected. This usually means the app was updated while it was open, or the connection dropped.</p>
        <button type="button" className="refresh-button" onClick={() => window.location.reload()}>Reload JPTI</button>
      </section>
    );
  }
}

function WorkspaceFallback() {
  return <section className="glass-panel detail-workspace" role="status" aria-live="polite"><span className="eyebrow">LOADING</span><p className="subtle-note">Loading workspace…</p></section>;
}

const navigation = [
  { label: 'Overview', icon: LayoutDashboard, group: 'COMMAND' },
  { label: 'Institutional Terminal', icon: Command, group: 'COMMAND' },
  { label: 'Chart Terminal', icon: CandlestickChart, group: 'MARKETS' },
  { label: 'Spot & Markets', icon: CandlestickChart, group: 'MARKETS' },
  { label: 'Futures', icon: Activity, group: 'MARKETS' },
  { label: 'Futures Intelligence', icon: Radio, group: 'MARKETS' },
  { label: 'Market Stream', icon: Radio, group: 'MARKETS' },
  { label: 'Asset Intelligence', icon: Network, group: 'MARKETS' },
  { label: 'AI Intelligence', icon: BrainCircuit, group: 'INTELLIGENCE' },
  { label: 'Institutional Market Intelligence', icon: Network, group: 'INTELLIGENCE' },
  { label: 'Opportunity Radar', icon: Activity, group: 'INTELLIGENCE' },
  { label: 'Market Scanner', icon: Search, group: 'INTELLIGENCE' },
  { label: 'SOPH Pair Scanner', icon: Activity, group: 'INTELLIGENCE' },
  { label: 'Financial & On-chain', icon: Blocks, group: 'INTELLIGENCE' },
  { label: 'News & Events', icon: Newspaper, group: 'INTELLIGENCE' },
  { label: 'Portfolio & Ledger', icon: Wallet, group: 'OPERATIONS' },
  { label: 'Reflective Trade Journal', icon: BookOpen, group: 'OPERATIONS' },
  { label: 'Risk Management', icon: ShieldCheck, group: 'OPERATIONS' },
  { label: 'Portfolio Allocation', icon: Gauge, group: 'OPERATIONS' },
  { label: 'Portfolio Stress', icon: Gauge, group: 'OPERATIONS' },
  { label: 'Pre-trade Gate', icon: ShieldCheck, group: 'OPERATIONS' },
  { label: 'Strategy Registry', icon: Blocks, group: 'RESEARCH' },
  { label: 'Market Replay', icon: Activity, group: 'RESEARCH' },
  { label: 'Signal Intelligence', icon: Activity, group: 'RESEARCH' },
  { label: 'Alpha Signal Engine', icon: TrendingUp, group: 'RESEARCH' },
  { label: 'System Diagnostics', icon: Cpu, group: 'SYSTEM' },
  { label: 'Production Readiness', icon: ShieldCheck, group: 'SYSTEM' },
  { label: 'Institutional Governance', icon: ShieldCheck, group: 'OPERATIONS' },
  { label: 'Trading Bots', icon: Bot, group: 'OPERATIONS' },
  { label: 'AI Agent Command Center', icon: BrainCircuit, group: 'INTELLIGENCE' },
  { label: 'Autonomous Departments', icon: Network, group: 'INTELLIGENCE' },
  { label: 'Shared Intelligence Memory', icon: Database, group: 'INTELLIGENCE' },
  { label: 'Agent Organisation', icon: Network, group: 'INTELLIGENCE' },
  { label: 'Strategy Research Laboratory', icon: FlaskConical, group: 'RESEARCH' },
  { label: 'Independent Risk Command Centre', icon: ShieldCheck, group: 'OPERATIONS' },
  { label: 'Trade Intelligence Records', icon: BookOpen, group: 'OPERATIONS' },
  { label: 'Universal Engine', icon: Network, group: 'RESEARCH' },
  { label: 'Backtesting Lab', icon: BarChart3, group: 'RESEARCH' },
  { label: 'Forecast & Strategy', icon: Gauge, group: 'RESEARCH' },
  { label: 'Walk-Forward Lab', icon: SlidersHorizontal, group: 'RESEARCH' },
  { label: 'Calendar & Sessions', icon: Globe2, group: 'RESEARCH' },
  { label: 'Downloads & Updates', icon: Download, group: 'SYSTEM' },
  { label: 'Connection Settings', icon: Settings2, group: 'SYSTEM' }
];

const fmt = (value) => value == null ? '—' : Number(value).toLocaleString();
const time = (value) => value ? new Date(value).toLocaleTimeString() : 'Awaiting first run';

function StatusPill({ status }) {
  const good = ['live', 'registry-checked', 'ready', 'ok'].includes(status);
  const warn = ['partial', 'waiting-for-watchlist', 'waiting-for-prerequisites', 'starting', 'not-started'].includes(status);
  return <span className={'status-pill ' + (good ? 'good' : warn ? 'warn' : 'bad')}><i />{String(status || 'unknown').replaceAll('-', ' ')}</span>;
}

function DownloadsWorkspace() {
  const [releases, setReleases] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState(null);
  const [expanded, setExpanded] = useState(false);

  const checkForUpdates = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('https://api.github.com/repos/kyleel2249/JPTI/releases?per_page=10', {
        headers: { Accept: 'application/vnd.github+json' },
        cache: 'no-store'
      });
      if (!response.ok) throw new Error(response.status === 403 ? 'GitHub API rate limit reached. Open Releases to check manually.' : 'Could not retrieve release information from GitHub.');
      const data = await response.json();
      setReleases(Array.isArray(data) ? data.filter(release => !release.draft && /^v?\d+\.\d+\.\d+$/.test(String(release.tag_name || '')) && release.assets?.length) : []);
      setCheckedAt(new Date().toISOString());
    } catch (cause) {
      setError(cause.message || 'Release check failed.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkForUpdates();
    const timer = setInterval(checkForUpdates, 10 * 60 * 1000);
    return () => clearInterval(timer);
  }, [checkForUpdates]);

  const latest = releases[0];
  const assetGroups = [
    { label: 'Android', match: /android.*\.apk|\.apk$/i, hint: 'Installable Android package' },
    { label: 'Windows', match: /\.exe$|\.msi$/i, hint: 'Windows installer or portable build' },
    { label: 'macOS', match: /\.dmg$|\.zip$/i, hint: 'macOS disk image or archive' },
    { label: 'Linux', match: /\.appimage$|\.deb$|\.rpm$/i, hint: 'Linux application package' },
    { label: 'Checksums', match: /sha256sums\.txt$/i, hint: 'Verify downloaded package integrity' }
  ];

  return <section className="glass-panel detail-workspace">
    <div className="section-heading ops-title">
      <div><span className="eyebrow">CROSS-PLATFORM RELEASE CENTER</span><h3>JPTI downloads & updates</h3><p>Packages published from successful builds of the main branch.</p></div>
      <button className="small-refresh" onClick={checkForUpdates} disabled={loading}>{loading ? 'Checking…' : 'Check for updates'}</button>
    </div>
    <div className="quote-consensus-stats">
      <div><span>RELEASES FOUND</span><b>{releases.length}</b></div>
      <div><span>LATEST VERSION</span><b>{latest?.tag_name || 'Not published'}</b></div>
      <div><span>BUILD STATUS</span><b>{latest ? (latest.prerelease ? 'Preview' : 'Stable') : 'Awaiting build'}</b></div>
      <div><span>LAST CHECK</span><b>{checkedAt ? new Date(checkedAt).toLocaleTimeString() : 'Not checked'}</b></div>
    </div>
    {error && <p className="quote-error">{error}</p>}
    {!latest && !loading && <div className="risk-list"><p><PackageCheck/><span><b>No downloadable release found yet.</b><br/>A release appears here after validation and all platform packaging jobs complete successfully.</span></p></div>}
    {latest && <div className="glass-panel detail-workspace">
      <span className="eyebrow">LATEST PUBLISHED BUILD · {latest.tag_name}</span>
      <h4>{latest.name || latest.tag_name}</h4>
      <p className="subtle-note">Published {latest.published_at ? new Date(latest.published_at).toLocaleString() : 'date unavailable'} · {latest.prerelease ? 'Automated preview release' : 'Stable release'}</p>
      <div className="news-results">
        {assetGroups.map(group => {
          const assets = latest.assets.filter(asset => group.match.test(asset.name));
          return assets.map(asset => <a key={asset.id} href={asset.browser_download_url} target="_blank" rel="noreferrer">
            <span>{group.label.toUpperCase()} · {(asset.size / 1048576).toFixed(1)} MB</span>
            <b>{asset.name}</b>
            <small>{group.hint} · Download ↗</small>
          </a>);
        })}
      </div>
      <div className="news-search"><a className="gold" href={latest.html_url} target="_blank" rel="noreferrer">View release notes <ExternalLink size={13}/></a></div>
    </div>}
    {releases.length > 1 && <div className="glass-panel detail-workspace">
      <button className="small-refresh" onClick={() => setExpanded(value => !value)}>{expanded ? 'Hide' : 'Show'} previous releases</button>
      {expanded && releases.slice(1).map(release => <div className="news-results" key={release.id}><a href={release.html_url} target="_blank" rel="noreferrer"><span>{release.tag_name} · {release.prerelease ? 'PREVIEW' : 'STABLE'}</span><b>{release.name || release.tag_name}</b><small>{release.assets.length} downloadable assets · View release ↗</small></a></div>)}
    </div>}
    <div className="risk-list">
      <p><PackageCheck/><span><b>Automatic build pipeline</b><br/>Each main-branch update runs tests and creates Android, Windows, macOS and Linux packages. Failed builds are not published.</span></p>
      <p><ShieldCheck/><span><b>Installation and update safety</b><br/>Android updates require the same production signing key as the installed app. Debug APKs are for testing and cannot upgrade a production-signed installation.</span></p>
      <p><RefreshCw/><span><b>Update behaviour</b><br/>This page checks GitHub releases on entry and every ten minutes while open. It provides the latest packages; installation approval remains with you.</span></p>
    </div>
    <div className="news-search">
      <a className="gold" href="https://github.com/kyleel2249/JPTI/releases" target="_blank" rel="noreferrer">All downloads <ExternalLink size={13}/></a>
      <a className="mode" href="https://github.com/kyleel2249/JPTI/actions/workflows/build-apps.yml" target="_blank" rel="noreferrer">Build history <ExternalLink size={13}/></a>
    </div>
  </section>;
}

function App() {
  const [page, setPage] = useState('Overview');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [symbol, setSymbol] = useState('BTC/USDT');
  const [health, setHealth] = useState(null);
  const [operations, setOperations] = useState(null);
  const [providers, setProviders] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [events, setEvents] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [apiMissing, setApiMissing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [query, setQuery] = useState('');
  const [newsQuery, setNewsQuery] = useState('financial markets OR central bank OR cryptocurrency');
  const [newsData, setNewsData] = useState([]);
  const [newsError, setNewsError] = useState('');
  const [newsLoading, setNewsLoading] = useState(false);
  const [quoteSymbol, setQuoteSymbol] = useState('AAPL');
  const [quoteConsensus, setQuoteConsensus] = useState(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState('');
  const [crossVenueSymbol, setCrossVenueSymbol] = useState('BTC/USDT');
  const [crossVenueData, setCrossVenueData] = useState(null);
  const [crossVenueLoading, setCrossVenueLoading] = useState(false);
  const [crossVenueError, setCrossVenueError] = useState('');
  const [forecastData, setForecastData] = useState(null);
  const [forecastError, setForecastError] = useState('');
  const [forecastLoading, setForecastLoading] = useState(false);
  const [forecastExchange, setForecastExchange] = useState('bitget');
  const [forecastTimeframe, setForecastTimeframe] = useState('1h');
  const [labData, setLabData] = useState(null);
  const [labStrategy, setLabStrategy] = useState('ema');
  const [labError, setLabError] = useState('');
  const [labLoading, setLabLoading] = useState(false);
  const [labTrainBars, setLabTrainBars] = useState(300);
  const [labTestBars, setLabTestBars] = useState(100);
  const [streamData, setStreamData] = useState(null);
  const [portfolioToken, setPortfolioToken] = useState('');
  const [portfolioData, setPortfolioData] = useState(null);
  const [performanceData, setPerformanceData] = useState(null);
  const [performanceError, setPerformanceError] = useState('');
  const [performanceLoading, setPerformanceLoading] = useState(false);
  const [portfolioError, setPortfolioError] = useState('');
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [reconciliationRun, setReconciliationRun] = useState(null);
  const [reconciliationBusy, setReconciliationBusy] = useState(false);
  const [backfillSince, setBackfillSince] = useState(new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  const [backfillResult, setBackfillResult] = useState(null);
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [riskData, setRiskData] = useState(null);
  const [riskError, setRiskError] = useState('');
  const [riskLoading, setRiskLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      // Health is answered locally by the browser-direct fallback when the API is unreachable; in that mode the
      // API-only panels (ledger, operations, providers) stay empty instead of failing the whole dashboard.
      const healthResponse = await apiFetch('/api/health', { cache: 'no-store' });
      const healthPayload = await healthResponse.json();
      if (healthPayload?.directMode) {
        setHealth(healthPayload);
        setLoadError('');
        setApiMissing(false);
        setLastRefresh(new Date().toISOString());
        return;
      }
      const paths = ['/api/health', '/api/operations/overview', '/api/providers', '/api/operations/ledger/summary', '/api/operations/events?limit=12'];
      const responses = await Promise.all(paths.map((path) => apiFetch(path, { cache: 'no-store' })));
      const payloads = await Promise.all(responses.map((response) => response.json()));
      const failed = responses.findIndex((response) => !response.ok);
      if (failed >= 0) throw new Error(payloads[failed]?.error || 'JPTI service endpoint unavailable');
      setHealth(payloads[0]);
      setOperations(payloads[1]);
      setProviders(payloads[2]);
      setLedger(payloads[3]);
      setEvents(payloads[4].events || []);
      setLoadError('');
      setApiMissing(false);
      setLastRefresh(new Date().toISOString());
    } catch (error) {
      setApiMissing(isApiUnavailable(error));
      setLoadError(error.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [refresh]);

  const loadNews = useCallback(async (event) => {
    if (event) event.preventDefault();
    setNewsLoading(true); setNewsError('');
    try {
      const response = await apiFetch('/api/providers/news/search?q=' + encodeURIComponent(newsQuery), { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'News search unavailable');
      setNewsData(data.articles || []);
    } catch (error) { setNewsError(error.message); }
    finally { setNewsLoading(false); }
  }, [newsQuery]);

  useEffect(() => {
    if (page === 'News & Events' && newsData.length === 0) loadNews();
  }, [page, newsData.length, loadNews]);

  const loadQuoteConsensus = useCallback(async (event) => {
    if (event) event.preventDefault();
    setQuoteLoading(true); setQuoteError('');
    try {
      const normalizedSymbol = quoteSymbol.trim().toUpperCase();
      const response = await apiFetch('/api/providers/consensus/quote/' + encodeURIComponent(normalizedSymbol), { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Cross-provider quote check failed');
      setQuoteConsensus(data);
    } catch (error) { setQuoteError(error.message); }
    finally { setQuoteLoading(false); }
  }, [quoteSymbol]);

  const loadCrossVenue = useCallback(async (event) => {
    if (event) event.preventDefault();
    setCrossVenueLoading(true); setCrossVenueError('');
    try {
      const params = new URLSearchParams({ symbol: crossVenueSymbol.trim().toUpperCase() });
      const response = await apiFetch('/api/exchanges/compare/ticker?' + params.toString(), { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Cross-exchange comparison failed');
      setCrossVenueData(data);
    } catch (error) { setCrossVenueError(error.message); }
    finally { setCrossVenueLoading(false); }
  }, [crossVenueSymbol]);

  const loadForecast = useCallback(async (event) => {
    if (event) event.preventDefault();
    setForecastLoading(true); setForecastError('');
    try {
      const url = '/api/advanced/forecast/' + encodeURIComponent(forecastExchange) + '/' + encodeURIComponent(symbol) + '?timeframe=' + encodeURIComponent(forecastTimeframe);
      const response = await apiFetch(url, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Forecast unavailable');
      setForecastData(data);
    } catch (error) { setForecastError(error.message); }
    finally { setForecastLoading(false); }
  }, [forecastExchange, symbol, forecastTimeframe]);

  const runWalkForward = useCallback(async (event) => {
    if (event) event.preventDefault();
    setLabLoading(true); setLabError('');
    try {
      const params = new URLSearchParams({ strategy: labStrategy, timeframe: forecastTimeframe, limit: '1000', trainBars: String(labTrainBars), testBars: String(labTestBars), stepBars: String(labTestBars), feeBps: '10' });
      const url = '/api/advanced/lab/walk-forward/' + encodeURIComponent(forecastExchange) + '/' + encodeURIComponent(symbol) + '?' + params.toString();
      const response = await apiFetch(url, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Walk-forward research failed');
      setLabData(data);
    } catch (error) { setLabError(error.message); }
    finally { setLabLoading(false); }
  }, [forecastExchange, forecastTimeframe, symbol, labTrainBars, labTestBars, labStrategy]);

  const loadPortfolioRisk = useCallback(async (event) => {
    if (event) event.preventDefault();
    setRiskLoading(true); setRiskError('');
    try {
      const response = await apiFetch('/api/advanced/portfolio/risk', { headers: { 'x-jpti-api-token': portfolioToken }, cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Portfolio risk analytics unavailable');
      setRiskData(data);
    } catch (error) { setRiskError(error.message); }
    finally { setRiskLoading(false); }
  }, [portfolioToken]);

  const runHistoricalBackfill = useCallback(async () => {
    if (!backfillSince) { setPortfolioError('Choose a historical start date first.'); return; }
    setBackfillBusy(true); setBackfillResult(null); setPortfolioError('');
    try {
      const response = await apiFetch('/api/operations/fills/backfill', {
        method: 'POST',
        headers: { 'x-jpti-api-token': portfolioToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ since: new Date(backfillSince + 'T00:00:00.000Z').toISOString() })
      });
      const data = await response.json();
      if (!response.ok && response.status !== 207) throw new Error(data.error || 'Historical backfill failed.');
      setBackfillResult(data);
      await refresh();
    } catch (error) { setPortfolioError(error.message); }
    finally { setBackfillBusy(false); }
  }, [backfillSince, portfolioToken, refresh]);

  const loadPortfolioAccounting = useCallback(async (event) => {
    if (event) event.preventDefault();
    setPortfolioLoading(true); setPortfolioError('');
    try {
      const response = await apiFetch('/api/advanced/portfolio/accounting', { headers: { 'x-jpti-api-token': portfolioToken }, cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Portfolio accounting unavailable');
      setPortfolioData(data);
    } catch (error) { setPortfolioError(error.message); }
    finally { setPortfolioLoading(false); }
  }, [portfolioToken]);

  const loadTradePerformance = useCallback(async () => {
    setPerformanceLoading(true); setPerformanceError('');
    try {
      const response = await apiFetch('/api/advanced/portfolio/performance', {
        headers: { 'x-jpti-api-token': portfolioToken }, cache: 'no-store'
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Trade performance analytics unavailable');
      setPerformanceData(data);
    } catch (error) { setPerformanceError(error.message); }
    finally { setPerformanceLoading(false); }
  }, [portfolioToken]);

  const runPortfolioReconciliation = useCallback(async () => {
    setReconciliationBusy(true);
    setReconciliationRun(null);
    setPortfolioError('');
    try {
      const response = await apiFetch('/api/operations/reconciliation/run', {
        method: 'POST',
        headers: { 'x-jpti-api-token': portfolioToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.errors?.join('; ') || data.error || 'Reconciliation could not run. Check exchange credentials and opening balances.');
      setReconciliationRun(data);
    } catch (error) { setPortfolioError(error.message); }
    finally { setReconciliationBusy(false); }
  }, [portfolioToken]);

  useEffect(() => {
    if (page !== 'Forecast & Strategy') { setStreamData(null); return undefined; }
    const source = new EventSource(apiUrl('/api/advanced/stream/' + encodeURIComponent(forecastExchange) + '/' + encodeURIComponent(symbol) + '?intervalMs=2000'));
    source.addEventListener('intelligence', event => { try { setStreamData(JSON.parse(event.data)); } catch {} });
    return () => source.close();
  }, [page, forecastExchange, symbol]);

  const filteredNav = useMemo(() => navigation.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())), [query]);
  const jobById = useMemo(() => Object.fromEntries((operations?.jobs || []).map((job) => [job.id, job])), [operations]);
  const configuredProviders = (providers?.providers || []).filter((provider) => provider.configured).length;
  const marketJob = jobById['market-monitor'];
  const gatewayOnline = health?.status === 'ok';
  const activeNav = (label) => { setPage(label); setMobileOpen(false); };

  const pageDescription = {
    'Overview': 'A live operational view across markets, intelligence sources and risk controls.',
    'Institutional Terminal': 'A precision command surface for live market intelligence, watchlists and disciplined operator workflows.',
    'Chart Terminal': 'A dedicated full-screen single-chart workstation with live market data, chart-linked indicators, signals and strategy intelligence.',
    'Spot & Markets': 'Live multi-exchange market data and technical analysis.',
    'Futures': 'Derivatives market discovery. Contract availability depends on exchange support.',
    'Futures Intelligence': 'Cross-exchange futures pricing, order-book depth, funding and paper arbitrage research.',
    'Asset Intelligence': 'Normalized spot, perpetual, dated-futures, options and margin instrument discovery across supported venues.',
    'AI Intelligence': 'Signal evidence, market context and explainable analysis.',
    'AI Agent Command Center': 'Ten explainable specialist agents, multi-agent debate, risk vetoes and persistent research memory.',
    'Autonomous Departments': 'Research, trading social and general marketing workforces with shared memory, autonomous missions, interdepartmental exchange and daily KPI reviews.',
    'Shared Intelligence Memory': 'Persistent institutional memory with evidence provenance, confidence, freshness and linked knowledge.',
    'Agent Organisation': 'Autonomous agent tasking, department handoffs, shared knowledge and accountability.',
    'Strategy Research Laboratory': 'Reproducible backtesting, walk-forward validation, Monte Carlo analysis and strategy lifecycle research.',
    'Independent Risk Command Centre': 'Server-enforced risk policy, independent pre-trade vetoes, circuit breakers and audit history.',
    'Trade Intelligence Records': 'Setup fingerprints, agent assessments, execution context, post-trade reviews and reusable lessons.',
    'Institutional Market Intelligence': 'Shared chart-linked market evidence, regime, structure, liquidity, flow and scenarios.',
    'Opportunity Radar': 'Rank a liquid multi-asset watchlist using explainable evidence and synchronized cross-market return correlations.',
    'Market Scanner': 'Configure market watchlists for scheduled live ticker monitoring.',
    'Financial & On-chain': 'Macro, digital-asset, provider and wallet intelligence.',
    'News & Events': 'News discovery and event context from connected sources.',
    'Portfolio & Ledger': 'Append-only transaction events and reconciliation readiness.',
    'Risk Management': 'Execution safeguards, service readiness and risk policy.',
    'Portfolio Allocation': 'Covariance-aware long-only risk budgeting and constrained portfolio weights.',
    'Institutional Governance': 'Strategy scorecards, T-Bots paper-entry authorization, execution feedback and fail-closed safety controls.',
    'Trading Bots': 'Agent orchestration status. Live execution remains protected.',
    'Downloads & Updates': 'Latest verified Android and desktop installers, release notes and build history.',
    'Universal Engine': 'Cross-asset strategy profiles, external market evidence, blockchain discovery and unified risk.',
    'Backtesting Lab': 'Strategy research and historical validation workspace.',
    'Signal Intelligence': 'Live opportunity detection, multi-factor evidence, signal ranking, trade planning and performance history.',
    'Alpha Signal Engine': 'Explainable multi-model signals, deterministic fingerprints, confidence gates and risk-approved paper trading.',
    'Forecast & Strategy': 'Statistical range forecasts, market microstructure, derivatives and research validation.',
    'Walk-Forward Lab': 'Rolling parameter selection, out-of-sample validation and strategy robustness research.',
    'Calendar & Sessions': 'Economic releases, market sessions and scheduled events.',
    'Connection Settings': 'Choose local desktop mode or connect this device to your secured cloud JPTI service.'
  };

  const renderOperations = () => (
    <div className="ops-grid">
      {(operations?.jobs || []).map((job) => {
        const Icon = job.id === 'market-monitor' ? Radio : job.id === 'provider-health' ? Network : job.id === 'reconciliation' ? Database : job.id === 'investor-monitor' ? Wallet : job.id === 'market-maker' ? Activity : job.id === 'news-monitor' ? Newspaper : Blocks;
        return <article className="ops-card" key={job.id}>
          <div className="ops-card-top"><span className="ops-icon"><Icon size={15}/></span><StatusPill status={job.status}/></div>
          <b>{job.label}</b>
          <p>{job.detail}</p>
          <div className="ops-meta"><span>Interval <strong>{job.intervalSeconds}s</strong></span><span>Last run <strong>{time(job.lastRunAt)}</strong></span></div>
        </article>;
      })}
    </div>
  );

  const renderOverview = () => <>
    <AgentDashboardOverview activeNav={activeNav}/>
    <TerminalDashboard
      page={page}
      onNavigate={activeNav}
      onOpenMenu={() => setMobileOpen(true)}
      onSymbolChange={setSymbol}
      health={health}
      operations={operations}
      loadError={loadError}
      lastRefresh={lastRefresh}
    >{renderClassicOverview()}</TerminalDashboard>
  </>;

  const renderClassicOverview = () => <Dashboard
    symbol={symbol}
    onSymbolChange={setSymbol}
    refresh={refresh}
    health={health}
    operations={operations}
    providers={providers}
    ledger={ledger}
    events={events}
    lastRefresh={lastRefresh}
    activeNav={activeNav}
    quoteSymbol={quoteSymbol}
    setQuoteSymbol={setQuoteSymbol}
    quoteConsensus={quoteConsensus}
    quoteLoading={quoteLoading}
    quoteError={quoteError}
    loadQuoteConsensus={loadQuoteConsensus}
    crossVenueSymbol={crossVenueSymbol}
    setCrossVenueSymbol={setCrossVenueSymbol}
    crossVenueData={crossVenueData}
    crossVenueLoading={crossVenueLoading}
    crossVenueError={crossVenueError}
    loadCrossVenue={loadCrossVenue}
    navigation={navigation}
    performanceData={performanceData}
    performanceError={performanceError}
    loadTradePerformance={loadTradePerformance}
  />;

  const renderWorkspace = () => {
    if (page === 'Downloads & Updates') return <DownloadsWorkspace/>;
    if (page === 'Calendar & Sessions') return <CalendarSessions symbol={symbol} onSymbolChange={setSymbol}/>;
    if (page === 'Connection Settings') return <ConnectionSettings/>;
    if (page === 'Reflective Trade Journal') return <ReflectiveJournal/>;
    if (page === 'SOPH Pair Scanner') return <PairScanner/>;
    if (page === 'Institutional Terminal') return <InstitutionalTerminal currentSymbol={symbol} onSymbolChange={setSymbol} onNavigate={activeNav}/>;
    if (page === 'Institutional Governance') return <InstitutionalGovernance/>;
    if (page === 'Futures Intelligence') return <FuturesIntelligence/>;
    if (page === 'Market Stream') return <MarketStream/>;
    if (page === 'Signal Intelligence') return <SignalIntelligenceDashboard initialSymbol={symbol}/>;
    if (page === 'Alpha Signal Engine') return <AlphaSignalEngine/>;
    if (page === 'Institutional Market Intelligence') return <InstitutionalMarketIntelligence exchange={forecastExchange} onExchangeChange={setForecastExchange} symbol={symbol} onSymbolChange={setSymbol} timeframe={forecastTimeframe} onTimeframeChange={setForecastTimeframe}/>;
    if (page === 'Opportunity Radar') return <OpportunityRadar exchange={forecastExchange} timeframe={forecastTimeframe}/>;
    if (['Portfolio Stress','Pre-trade Gate','Strategy Registry','Market Replay','System Diagnostics','Production Readiness'].includes(page)) return <Phase15To21Workspaces key={page} page={page}/>;
    if (page === 'Asset Intelligence') return <AssetIntelligence/>;
    if (page === 'AI Intelligence') return <ResearchCouncil/>;
    if (page === 'AI Agent Command Center') return <AgentCommandCenter/>;
    if (page === 'Autonomous Departments') return <AutonomousDepartments/>;
    if (['Shared Intelligence Memory','Agent Organisation','Strategy Research Laboratory','Independent Risk Command Centre','Trade Intelligence Records'].includes(page)) return <IntelligenceFoundation page={page} symbol={symbol}/>;
    if (page === 'Trading Bots') return <PaperTradingCommandCenter/>;
    if (page === 'Portfolio Allocation') return <PortfolioAllocation/>;
    if (page === 'Universal Engine') return <UniversalEngine localPrivateAccess={health?.localPrivateAccess === true}/>;
    if (page === 'Overview') return renderOverview();
    if (page === 'Financial & On-chain') return <FinancialIntelligence/>;
    if (page === 'Forecast & Strategy') return <section className="glass-panel detail-workspace">
      <span className="eyebrow">24-HOUR HIGH / LOW FORECAST ENGINE</span><h3>Statistical range intelligence</h3>
      <p>Forecasts are calculated from live exchange OHLCV using historical log-return volatility, ATR and bounded drift. They are estimates, not exchange-published values or calibrated probabilities.</p>
      <form className="news-search" onSubmit={loadForecast}>
        <select value={forecastExchange} onChange={(e) => setForecastExchange(e.target.value)}><option value="binance">Binance</option><option value="bitget">Bitget</option><option value="bybit">Bybit</option><option value="okx">OKX</option></select>
        <select value={forecastTimeframe} onChange={(e) => setForecastTimeframe(e.target.value)}><option value="15m">15m</option><option value="1h">1h</option><option value="4h">4h</option><option value="1d">1d</option></select>
        <button disabled={forecastLoading}>{forecastLoading ? 'Calculating…' : 'Calculate forecast for ' + symbol}</button>
      </form>
      {forecastError && <p className="quote-error">{forecastError}</p>}
      {forecastData && <><div className="quote-consensus-stats"><div><span>REFERENCE PRICE</span><b>{fmt(forecastData.referencePrice)}</b></div><div><span>ATR</span><b>{fmt(forecastData.atr)}</b></div><div><span>VOLATILITY / BAR</span><b>{Number(forecastData.volatilityPerCandlePercent).toFixed(3)}%</b></div><div><span>20-BAR MOMENTUM</span><b>{Number(forecastData.momentum20Percent).toFixed(2)}%</b></div></div>
      <div className="scanner-table"><div><span>HORIZON</span><span>FORECAST HIGH</span><span>EXPECTED MID</span><span>FORECAST LOW</span><span>RANGE METHOD</span></div>{forecastData.forecasts.map((f) => <div key={f.horizonHours}><b>{f.horizonHours}h</b><strong className="up">{fmt(f.forecastHigh)}</strong><strong>{fmt(f.expectedMid)}</strong><strong className="down">{fmt(f.forecastLow)}</strong><span>Volatility + ATR</span></div>)}</div>
      <p className="subtle-note">{forecastData.method}. {forecastData.limitations.join(' ')}</p></>}
      <div className="section-heading ops-title"><div><span className="eyebrow">LIVE MICROSTRUCTURE STREAM</span><h3>Order-book & derivatives telemetry</h3></div><span className="live-tag">{streamData ? 'STREAM CONNECTED' : 'CONNECTING'}</span></div>
       {streamData && <div className="quote-consensus-stats"><div><span>BOOK IMBALANCE</span><b>{streamData.orderBookAnalysis?.depthImbalance == null ? '—' : (streamData.orderBookAnalysis.depthImbalance * 100).toFixed(1) + '%'}</b></div><div><span>BID / ASK LEVELS</span><b>{(streamData.orderBook?.bids?.length ?? 0) + ' / ' + (streamData.orderBook?.asks?.length ?? 0)}</b></div><div><span>FUNDING RATE</span><b>{streamData.funding?.fundingRate == null ? '—' : Number(streamData.funding.fundingRate).toFixed(6)}</b></div><div><span>OPEN INTEREST</span><b>{fmt(streamData.openInterest?.openInterestAmount ?? streamData.openInterest?.openInterestValue)}</b></div></div>}
       <p className="subtle-note">{streamData ? 'Last sample: ' + new Date(streamData.sampledAt).toLocaleTimeString() + '. ' + streamData.transport : 'Waiting for exchange snapshots. Derivatives fields depend on venue and market support.'}</p>
       <div className="risk-list"><p><ShieldCheck/> Derivatives and order-book routes are separately available under /api/advanced.</p><p><ShieldCheck/> Confidence calibration and walk-forward validation remain required before deployment.</p><p><ShieldCheck/> No forecast submits or authorizes an order.</p></div>
    </section>;
    if (page === 'Walk-Forward Lab') return <section className="glass-panel detail-workspace">
       <span className="eyebrow">OUT-OF-SAMPLE STRATEGY RESEARCH</span><h3>Rolling walk-forward laboratory</h3>
       <p>Live exchange OHLCV is used to optimize EMA crossover, RSI mean-reversion or Donchian breakout parameters on prior training windows, then evaluate them on subsequent unseen test windows. This is a research baseline, not a profitability guarantee.</p>
       <form className="news-search" onSubmit={runWalkForward}>
         <select value={forecastExchange} onChange={e => setForecastExchange(e.target.value)}><option value="binance">Binance</option><option value="bitget">Bitget</option><option value="bybit">Bybit</option><option value="okx">OKX</option></select>
         <select value={forecastTimeframe} onChange={e => setForecastTimeframe(e.target.value)}><option value="15m">15m</option><option value="1h">1h</option><option value="4h">4h</option><option value="1d">1d</option></select>
         <select value={labStrategy} onChange={e => setLabStrategy(e.target.value)}><option value="ema">EMA crossover</option><option value="rsi">RSI mean reversion</option><option value="donchian">Donchian breakout</option></select>
         <input type="number" min="100" max="900" value={labTrainBars} onChange={e => setLabTrainBars(e.target.value)} aria-label="Training candles"/>
         <input type="number" min="20" max="300" value={labTestBars} onChange={e => setLabTestBars(e.target.value)} aria-label="Test candles"/>
         <button disabled={labLoading}>{labLoading ? 'Validating…' : 'Run walk-forward on ' + symbol}</button>
       </form>
       <p className="subtle-note">Training candles · test candles · 10 bps fee assumption · strategy-specific parameter grid for EMA, RSI or Donchian. Requires enough history for at least one complete fold.</p>
       {labError && <p className="quote-error">{labError}</p>}
       {labData && <>
         <div className="quote-consensus-stats"><div><span>AGGREGATE OOS RETURN</span><b>{Number(labData.aggregateOutOfSample.totalReturnPercent).toFixed(2)}%</b></div><div><span>OOS MAX DRAWDOWN</span><b>{Number(labData.aggregateOutOfSample.maxDrawdownPercent).toFixed(2)}%</b></div><div><span>OOS OBSERVATIONS</span><b>{labData.aggregateOutOfSample.observations}</b></div><div><span>WALK-FORWARD FOLDS</span><b>{labData.folds.length}</b></div></div>
         <div className="scanner-table"><div><span>FOLD</span><span>SELECTED PARAMETERS</span><span>OOS RETURN</span><span>OOS DRAWDOWN</span><span>OOS BARS</span></div>{labData.folds.map(f => <div key={f.fold}><b>{f.fold}</b><strong className="up">{Object.entries(f.selectedParameters).map(([key, value]) => key + ':' + value).join(' · ')}</strong><strong className={f.outOfSample.totalReturnPercent >= 0 ? 'up' : 'down'}>{Number(f.outOfSample.totalReturnPercent).toFixed(2)}%</strong><span>{Number(f.outOfSample.maxDrawdownPercent).toFixed(2)}%</span><span>{f.outOfSample.observations}</span></div>)}</div>
         <p className="subtle-note">{labData.caveats.join(' ')}</p>
       </>}
     </section>;
     if (page === 'Chart Terminal') return <MultiChartWorkstation mode="spot" symbol={symbol} onSymbolChange={setSymbol} terminalFocus dedicatedTerminal/>;
    if (page === 'Spot & Markets' || page === 'Futures') return <MultiChartWorkstation mode={page === 'Futures' ? 'futures' : 'spot'} symbol={symbol} onSymbolChange={setSymbol} terminalFocus/>;
    if (page === 'Market Scanner') return <section className="glass-panel detail-workspace"><span className="eyebrow">LIVE MARKET MONITOR</span><h3>Monitored market universe</h3><p>JPTI samples real exchange tickers on the configured market-monitor interval. Add symbols to the server-side watchlist in your .env file.</p><pre>JPTI_MONITOR_MARKETS=binance:BTC/USDT,bitget:ETH/USDT</pre><div className="scanner-table"><div><span>EXCHANGE</span><span>SYMBOL</span><span>LAST</span><span>24H CHANGE</span><span>QUOTE VOLUME</span></div>{(marketJob?.lastSnapshot || []).map((item) => <div key={item.exchange + item.symbol}><b>{item.exchange}</b><b>{item.symbol}</b><strong>{fmt(item.last)}</strong><strong className={Number(item.percentage) >= 0 ? 'up' : 'down'}>{item.percentage == null ? '—' : fmt(item.percentage) + '%'}</strong><span>{fmt(item.quoteVolume)}</span></div>)}{!marketJob?.lastSnapshot?.length && <p className="empty-state">No live watchlist snapshot yet. Configure JPTI_MONITOR_MARKETS and wait for the next scheduler cycle.</p>}</div>{renderOperations()}</section>;
    if (page === 'Portfolio & Ledger') return <section className="glass-panel detail-workspace">
       <span className="eyebrow">PERSISTENT TRANSACTION JOURNAL</span><h3>Portfolio accounting & reconciliation</h3>
       <p>{ledger?.eventCount ?? 0} transaction events recorded. Configure read-only trade-history keys and the fill watchlist to keep the ledger current.</p>
       <div className="ledger-summary">{Object.entries(ledger?.byType || {}).map(([key, value]) => <div key={key}><span>{key}</span><b>{value}</b></div>)}</div>
       <form className="news-search" onSubmit={loadPortfolioAccounting}><input type="password" value={portfolioToken} onChange={e => setPortfolioToken(e.target.value)} placeholder="JPTI API token (required for cloud; optional in local desktop)"/><button disabled={portfolioLoading || (!portfolioToken && !health?.localPrivateAccess)}>{portfolioLoading ? 'Loading accounts…' : 'Load private portfolio'}</button></form>
       <div className="news-search"><button type="button" onClick={runPortfolioReconciliation} disabled={reconciliationBusy || (!portfolioToken && !health?.localPrivateAccess)}>{reconciliationBusy ? 'Reconciling exchange balances…' : 'Run balance reconciliation now'}</button></div>
       <div className="glass-panel detail-workspace">
         <span className="eyebrow">HISTORICAL TRADE RECOVERY</span>
         <h4>Backfill exchange trade history</h4>
         <p className="subtle-note">Import earlier fills for the exchanges and markets in JPTI_FILL_SYNC_MARKETS. Existing fills are deduplicated. Backfill uses a separate cursor and does not move the scheduled live-sync cursor.</p>
         <div className="news-search"><label>Import starting date <input type="date" value={backfillSince} onChange={event => setBackfillSince(event.target.value)} /></label><button type="button" onClick={runHistoricalBackfill} disabled={backfillBusy || (!portfolioToken && !health?.localPrivateAccess) || !backfillSince}>{backfillBusy ? 'Importing historical trades…' : 'Start historical backfill'}</button></div>
         {backfillResult && <div className="quote-consensus-stats">
           <div><span>FETCHED</span><b>{backfillResult.fetched}</b></div><div><span>NEWLY IMPORTED</span><b>{backfillResult.ingested}</b></div><div><span>DUPLICATES</span><b>{backfillResult.duplicates}</b></div><div><span>PAGE-CAPPED MARKETS</span><b>{backfillResult.cappedMarkets}</b></div>
           {backfillResult.markets.map(market => <p className="subtle-note" key={market.exchange+market.symbol}>{market.exchange} · {market.symbol}: {market.pages} page(s), {market.fetched} fetched, {market.ingested} new, {market.invalidOrUnsupported} unsupported. {market.pageLimitReached ? 'More pages remain; run again to continue.' : 'History window completed.'}</p>)}
           {backfillResult.errors.map((error,index) => <p className="quote-error" key={index}>{error}</p>)}
         </div>}
       </div>
       <div className="section-heading ops-title"><div><span className="eyebrow">PERFORMANCE & STRATEGY ATTRIBUTION</span><h3>Trade performance intelligence</h3><p>Closed exit executions only; results are separated by quote currency.</p></div><button className="small-refresh" onClick={loadTradePerformance} disabled={performanceLoading || (!portfolioToken && !health?.localPrivateAccess)}>{performanceLoading ? 'Analyzing…' : 'Analyze ledger performance'}</button></div>
       {performanceError && <p className="quote-error">{performanceError}</p>}
       {performanceData && <>
         <div className="quote-consensus-stats">
           <div><span>RECORDED FILLS</span><b>{performanceData.fillCount}</b></div>
           <div><span>MATCHED EXIT EXECUTIONS</span><b>{performanceData.matchedExitCount}</b></div>
           <div><span>UNMATCHED SELL EXECUTIONS</span><b>{performanceData.unmatchedSellExecutions}</b></div>
           <div><span>STRATEGY LABEL COVERAGE</span><b>{performanceData.matchedExitCount ? Math.round((1-performanceData.dataQuality.unattributedExits/performanceData.matchedExitCount)*100) + '%' : '—'}</b></div>
         </div>
         <h4>Realized performance by quote currency</h4>
         <div className="scanner-table"><div><span>QUOTE</span><span>NET REALIZED PNL</span><span>WIN RATE</span><span>PROFIT FACTOR</span><span>EXPECTANCY / EXIT</span><span>MAX DD (QUOTE)</span></div>
           {performanceData.byCurrency.map(row => <div key={row.quoteCurrency}><b>{row.quoteCurrency}</b><strong className={row.netRealizedPnl>=0?'up':'down'}>{fmt(row.netRealizedPnl)}</strong><span>{row.winRatePercent==null?'—':row.winRatePercent.toFixed(1)+'%'}</span><span>{row.profitFactor==null?'—':row.profitFactor.toFixed(2)}</span><span>{fmt(row.expectancyPerExit)}</span><span>{fmt(row.maxDrawdownCurrency)}</span></div>)}
           {!performanceData.byCurrency.length && <p className="empty-state">No matched sell executions yet. Import fills and ensure opening inventory is present.</p>}
         </div>
         <h4>Strategy attribution · separated by quote currency</h4>
         <div className="scanner-table"><div><span>STRATEGY</span><span>QUOTE</span><span>EXITS</span><span>WINS / LOSSES</span><span>NET PNL</span></div>
           {performanceData.byStrategy.map((row,index)=><div key={row.strategy+row.quoteCurrency+index}><b>{row.strategy}</b><span>{row.quoteCurrency}</span><span>{row.exits}</span><span>{row.wins} / {row.losses}</span><strong className={row.netRealizedPnl>=0?'up':'down'}>{fmt(row.netRealizedPnl)}</strong></div>)}
         </div>
         <h4>Market attribution</h4>
         <div className="scanner-table"><div><span>MARKET</span><span>QUOTE</span><span>EXITS</span><span>AVERAGE PNL</span><span>NET PNL</span></div>
           {performanceData.byMarket.map((row,index)=><div key={row.symbol+row.quoteCurrency+index}><b>{row.symbol}</b><span>{row.quoteCurrency}</span><span>{row.exits}</span><span>{fmt(row.averagePnl)}</span><strong className={row.netRealizedPnl>=0?'up':'down'}>{fmt(row.netRealizedPnl)}</strong></div>)}
         </div>
         <h4>UTC session attribution</h4>
         <div className="scanner-table"><div><span>SESSION</span><span>QUOTE</span><span>EXITS</span><span>WINS / LOSSES</span><span>NET PNL</span></div>
           {performanceData.bySession.map((row,index)=><div key={row.session+row.quoteCurrency+index}><b>{row.session}</b><span>{row.quoteCurrency}</span><span>{row.exits}</span><span>{row.wins} / {row.losses}</span><strong className={row.netRealizedPnl>=0?'up':'down'}>{fmt(row.netRealizedPnl)}</strong></div>)}
         </div>
         <h4>Daily realized PnL calendar data</h4>
         <div className="scanner-table"><div><span>DATE</span><span>QUOTE</span><span>REALIZED PNL</span></div>
           {performanceData.byCurrency.flatMap(currency=>currency.daily.map(day=><div key={currency.quoteCurrency+day.date}><b>{day.date}</b><span>{currency.quoteCurrency}</span><strong className={day.pnl>=0?'up':'down'}>{fmt(day.pnl)}</strong></div>))}
         </div>
         <h4>Performance analyst · rule-based evidence checks</h4>
         <div className="risk-list">{performanceData.analystInsights.map((insight,index)=><p key={index}><ShieldCheck/><span><b>{insight.title}</b>{insight.quoteCurrency ? ' · '+insight.quoteCurrency : ''}<br/>{insight.evidence}<br/><small>{insight.review}</small></span></p>)}</div>
         <h4>Trade quality and loss streaks</h4>
         <div className="scanner-table"><div><span>QUOTE</span><span>CURRENT LOSS STREAK</span><span>LONGEST LOSS STREAK</span><span>LAST 20 EXITS PNL</span></div>
           {performanceData.byCurrency.map(row=><div key={row.quoteCurrency}><b>{row.quoteCurrency}</b><span>{row.currentLossStreak}</span><span>{row.longestLossStreak}</span><strong className={row.recent20NetPnl>=0?'up':'down'}>{fmt(row.recent20NetPnl)}</strong></div>)}
         </div>
         <div className="risk-list">{performanceData.dataQuality.warnings.map((warning,index)=><p key={index}><ShieldCheck/>{warning}</p>)}</div>
         <p className="subtle-note">{performanceData.methodology} {performanceData.limitations.join(' ')}</p>
       </>}
       {portfolioError && <p className="quote-error">{portfolioError}</p>}
       {portfolioData && <>
         <div className="quote-consensus-stats"><div><span>OPEN POSITIONS</span><b>{portfolioData.positions.length}</b></div><div><span>ASSET MOVEMENT LINES</span><b>{portfolioData.assetMovements.length}</b></div><div><span>EXCHANGE ACCOUNTS</span><b>{portfolioData.exchangeBalances.length}</b></div><div><span>REALIZED PNL CURRENCIES</span><b>{Object.keys(portfolioData.realizedPnlByQuoteCurrency).length}</b></div></div>
         <h4>Open positions · weighted-average cost</h4>
         <div className="scanner-table"><div><span>EXCHANGE / MARKET</span><span>QUANTITY</span><span>AVG COST</span><span>MARK</span><span>UNREALIZED PNL</span></div>{portfolioData.positions.map(p => <div key={p.exchange + p.accountId + p.symbol}><b>{p.exchange} · {p.symbol}</b><span>{fmt(p.quantity)}</span><span>{fmt(p.averageCost)}</span><span>{fmt(p.marketPrice)}</span><strong className={Number(p.unrealizedPnl) >= 0 ? 'up' : 'down'}>{fmt(p.unrealizedPnl)}</strong></div>)}{!portfolioData.positions.length && <p className="empty-state">No fill-based positions have been ingested yet.</p>}</div>
         <h4>Current exchange balances</h4><div className="scanner-table"><div><span>EXCHANGE</span><span>CURRENCY</span><span>FREE</span><span>USED</span><span>TOTAL</span></div>{portfolioData.exchangeBalances.flatMap(b => b.status === 'ok' ? Object.entries(b.total || {}).filter(([, amount]) => Number(amount) > 0).map(([currency, amount]) => <div key={b.exchange + currency}><b>{b.exchange}</b><span>{currency}</span><span>{fmt(b.free?.[currency])}</span><span>{fmt(b.used?.[currency])}</span><strong>{fmt(amount)}</strong></div>) : [<div key={b.exchange}><b>{b.exchange}</b><span>{b.status}</span><span>{b.error || 'Balance capability unavailable'}</span></div>])}</div>
         <h4>Realized PnL by quote currency</h4><div className="ledger-summary">{Object.entries(portfolioData.realizedPnlByQuoteCurrency).map(([currency, amount]) => <div key={currency}><span>{currency}</span><b>{fmt(amount)}</b></div>)}</div>
         <p className="subtle-note">{portfolioData.reconciliationNote} {portfolioData.limitations.join(' ')}</p>
         {reconciliationRun && <section className="detail-workspace">
           <h4>Latest reconciliation · {reconciliationRun.status.replaceAll('-', ' ')}</h4>
           <p className="subtle-note">{reconciliationRun.accountsChecked} account(s) checked · {reconciliationRun.errors.length} account error(s) · {new Date(reconciliationRun.generatedAt).toLocaleString()}</p>
           {reconciliationRun.snapshots.map(snapshot => <div key={snapshot.exchange}>
             <h4>{snapshot.exchange} · {snapshot.status.replaceAll('_', ' ')}</h4>
             <div className="scanner-table"><div><span>ASSET</span><span>EXCHANGE TOTAL</span><span>EXPECTED TOTAL</span><span>DIFFERENCE</span><span>STATUS</span></div>
               {snapshot.rows.map(row => <div key={snapshot.exchange + row.currency}><b>{row.currency}</b><span>{fmt(row.actualTotal)}</span><span>{row.expectedTotal == null ? 'Baseline required' : fmt(row.expectedTotal)}</span><strong>{row.difference == null ? '—' : fmt(row.difference)}</strong><span>{row.status.replaceAll('_', ' ')}</span></div>)}
             </div>
             <p className="subtle-note">{snapshot.unresolvedEventCount} unresolved ledger event(s). {snapshot.caveat}</p>
           </div>)}
           {reconciliationRun.errors.map((error, index) => <p className="quote-error" key={index}>{error}</p>)}
         </section>}
       </>}
       <p className="subtle-note">Private API token is held only in component memory and is not saved to local storage. Scheduled fill ingestion: JPTI_FILL_SYNC_MARKETS=binance:BTC/USDT,bitget:ETH/USDT. Read-only keys only; withdrawals remain disabled.</p>
       {renderOperations()}
     </section>;
    if (page === 'News & Events') return <section className="glass-panel detail-workspace"><span className="eyebrow">GLOBAL NEWS DISCOVERY</span><h3>Market news radar</h3><p>Searches the GDELT global news index. Verify publication time, original reporting and source credibility before using any article as trading evidence.</p><form className="news-search" onSubmit={loadNews}><input value={newsQuery} onChange={(event) => setNewsQuery(event.target.value)} placeholder="Search market, ticker, central bank, event..."/><button disabled={newsLoading}>{newsLoading ? 'Searching...' : 'Search news'}</button></form>{newsError && <p className="subtle-note">{newsError}</p>}<div className="news-results">{newsData.map((article, index) => <a href={article.url} target="_blank" rel="noreferrer" key={article.url || index}><span>{article.domain || article.sourcecountry || 'NEWS SOURCE'} · {article.seendate || 'Timestamp unavailable'}</span><b>{article.title || 'Untitled article'}</b><small>{article.sourcecountry || 'Global'} · Open original source ↗</small></a>)}{!newsData.length && !newsLoading && <p className="empty-state">Search to load current news results.</p>}</div></section>;
    if (page === 'Risk Management') return <section className="glass-panel detail-workspace">
      <span className="eyebrow">CAPITAL PROTECTION · QUANTITATIVE RISK</span><h3>Portfolio VaR, concentration & stress testing</h3>
      <div className="risk-list"><p><ShieldCheck/> Live trading disabled by default.</p><p><ShieldCheck/> API-token and explicit live confirmation required.</p><p><ShieldCheck/> Server-side per-order notional and market restrictions.</p><p><ShieldCheck/> No withdrawal capability exposed.</p></div>
      <form className="news-search" onSubmit={loadPortfolioRisk}><input type="password" value={portfolioToken} onChange={e => setPortfolioToken(e.target.value)} placeholder="JPTI API token"/><button disabled={riskLoading || (!portfolioToken && !health?.localPrivateAccess)}>{riskLoading ? 'Calculating risk…' : 'Run portfolio risk analysis'}</button></form>
      {riskError && <p className="quote-error">{riskError}</p>}
      {riskData && <>
        <p className="subtle-note">Generated {new Date(riskData.generatedAt).toLocaleString()}. Quote-currency exposures are reported separately; no cross-currency aggregation is performed.</p>
        {riskData.warnings?.map((warning,index)=><p className={warning.severity==='warning'?'quote-error':'subtle-note'} key={index}>{warning.quoteCurrency ? warning.quoteCurrency+' · ' : ''}{warning.message}</p>)}
        {riskData.dataQuality?.marketDataErrors?.map((error,index)=><p className="subtle-note" key={'market-'+index}>Market data: {error}</p>)}
        {riskData.portfolios.length===0 && <p className="empty-state">No marked ledger positions are available. Import fills and wait for supported public market prices before running portfolio risk analysis.</p>}
        {riskData.portfolios.map(p => <div className="glass-panel detail-workspace" key={p.quoteCurrency}>
          <div className="section-heading"><div><span className="eyebrow">RISK BOOK · {p.quoteCurrency}</span><h4>{fmt(p.grossExposure)} {p.quoteCurrency} gross exposure</h4></div></div>
          <div className="quote-consensus-stats"><div><span>1D VaR · 95%</span><b>{p.historical.var95Percent == null ? '—' : p.historical.var95Percent.toFixed(2) + '%'}</b></div><div><span>EXPECTED SHORTFALL · 95%</span><b>{p.historical.expectedShortfall95Percent == null ? '—' : p.historical.expectedShortfall95Percent.toFixed(2) + '%'}</b></div><div><span>1D VaR · 99%</span><b>{p.historical.var99Percent == null ? '—' : p.historical.var99Percent.toFixed(2) + '%'}</b></div><div><span>STRESS LOSS</span><b>{fmt(p.stress.estimatedLoss)} {p.quoteCurrency}</b></div></div>
          <p className="subtle-note">Historical observations: {p.historical.observations}. Largest position: {p.concentration.largestPositionWeightPercent.toFixed(1)}%. Effective independent positions: {p.concentration.effectivePositions.toFixed(2)}. Stress assumption: {p.stress.shockPercent}% parallel shock.</p>
          <div className="scanner-table"><div><span>EXCHANGE / SYMBOL</span><span>MARKET VALUE</span><span>WEIGHT</span></div>{p.positions.map(x => <div key={x.exchange+x.symbol}><b>{x.exchange} · {x.symbol}</b><span>{fmt(x.marketValue)} {p.quoteCurrency}</span><strong>{x.weightPercent.toFixed(2)}%</strong></div>)}</div>
        </div>)}
        <p className="subtle-note">{riskData.methodology} {riskData.limitations.join(' ')}</p>
      </>}
      <p className="subtle-note">VaR is a historical estimate, not a maximum-loss guarantee. Derivatives leverage, liquidation mechanics, funding and cross-currency FX risk are not included.</p>{renderOperations()}</section>;
    if (page === 'Trading Bots' || page === 'AI Intelligence') return <section className="glass-panel detail-workspace"><span className="eyebrow">AGENT ORCHESTRATION</span><h3>{page === 'AI Intelligence' ? 'Explainable intelligence services' : 'Trading automation control'}</h3><p>Agent execution is not represented as active until its worker, strategy, data sources and risk policy are implemented and verified. Current service readiness is shown below.</p>{renderOperations()}</section>;
    return <section className="glass-panel detail-workspace"><span className="eyebrow">RESEARCH WORKSPACE</span><h3>{page}</h3><p>This workspace is reserved for verified data and tested functionality. It will not display fabricated performance, positions or economic events.</p>{renderOperations()}</section>;
  };

  const groups = [...new Set(navigation.map((item) => item.group))];
  const marketTerminalMode = page === 'Chart Terminal' || page === 'Spot & Markets' || page === 'Futures';
  useEffect(() => {
    if (!marketTerminalMode) return undefined;
    const onKeyDown = (event) => { if (event.key === 'Escape') setPage('Overview'); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [marketTerminalMode]);
  return <div className={'jpti-shell' + (page === 'Overview' ? ' terminal-mode' : '') + (marketTerminalMode ? ' jpti-market-fullscreen' : '')}>
    {page === 'Overview' && mobileOpen && <button type="button" className="td-drawer-scrim" aria-label="Close workspace menu" onClick={() => setMobileOpen(false)}/>}
    <div className="ambient ambient-a"/><div className="ambient ambient-b"/>
    {marketTerminalMode && <div className="jpti-market-terminal-bar">
      <div className="jpti-market-terminal-brand"><img src={`${import.meta.env.BASE_URL}jpti-icon.svg`} alt="JPTI"/><span><b>JPTI MARKET TERMINAL</b><small>FULL-SCREEN CHART WORKSTATION</small></span></div>
      {page !== 'Chart Terminal' && <div className="jpti-market-terminal-switch" aria-label="Market terminal mode">
        <button type="button" className={page === 'Spot & Markets' ? 'active' : ''} onClick={() => activeNav('Spot & Markets')}>SPOT MARKETS</button>
        <button type="button" className={page === 'Futures' ? 'active' : ''} onClick={() => activeNav('Futures')}>DERIVATIVES</button>
      </div>}
      {page === 'Chart Terminal' && <div className="jpti-chart-terminal-center-label">SINGLE MARKET · LIVE CANDLES · CHART-LINKED INTELLIGENCE</div>}
      <div className="jpti-market-terminal-actions"><span><i/> CHART WORKSPACE</span><button type="button" onClick={() => activeNav('Overview')}>EXIT TERMINAL <b>ESC</b></button></div>
    </div>}
    <aside className={'command-sidebar ' + (mobileOpen ? 'mobile-open' : '')}>
      <div className="brand-lockup"><div className="brand-mark"><img src={`${import.meta.env.BASE_URL}jpti-icon.svg`} alt="JPTI" /></div><div><b>JOPEARL</b><small>TRADING INTELLIGENCE</small></div><button className="mobile-close" onClick={() => setMobileOpen(false)}><X size={17}/></button></div>
      <div className="workspace-pill"><span className="workspace-avatar">JP</span><span><b>JPTI COMMAND</b><small>Personal workspace</small></span><ChevronRight size={14}/></div>
      <label className="side-label">NAVIGATION</label>
      <div className="side-search"><Search size={14}/><input placeholder="Find a workspace" value={query} onChange={(e) => setQuery(e.target.value)}/><Command size={12}/></div>
      <nav>{groups.map((group) => <div className="nav-group" key={group}><small>{group}</small>{filteredNav.filter((item) => item.group === group).map((item) => { const Icon = item.icon; return <button key={item.label} className={page === item.label ? 'active' : ''} onClick={() => activeNav(item.label)}><Icon size={16}/><span>{item.label}</span>{item.label === 'Financial & On-chain' && <i>DATA</i>}</button>; })}</div>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-status"><span className="pulse-dot"/><span><b>{gatewayOnline ? 'SYSTEM OPERATIONAL' : 'CONNECTING TO API'}</b><small>{health?.mode || 'Awaiting gateway'}</small></span></div><div className="sidebar-footer"><button type="button" onClick={() => activeNav('Connection Settings')}><Settings2 size={14}/> Settings</button><span><CircleHelp size={14}/> Help</span></div><small className="build-label">JPTI · SECURE TRADING INFRASTRUCTURE</small></div>
    </aside>

    <main className="command-main">
      <header className="command-topbar"><div className="top-left"><button className="mobile-menu" onClick={() => setMobileOpen(true)}><Menu size={18}/></button><div className="breadcrumb">JOPEARL <ChevronRight size={12}/> <b>{page.toUpperCase()}</b></div></div><div className="top-right"><span className="market-state"><i/> {gatewayOnline ? 'API CONNECTED' : 'API DISCONNECTED'}</span><span className="top-divider"/><button className="icon-action" onClick={refresh} title="Refresh system"><RefreshCw size={15}/></button><button className="icon-action" title="Notifications"><Bell size={15}/></button><div className="user-chip"><span>JP</span><b>Operator</b></div></div></header>
      <div className="page-content">
        <div className="page-heading"><div><div className="heading-eyebrow"><Sparkles size={13}/> INTELLIGENCE, PRECISION, CONTROL</div><h1>{page === 'Overview' ? 'Trading command center' : page}</h1><p>{pageDescription[page] || 'JPTI intelligence workspace.'}</p></div><div className="heading-tools"><span className="paper-chip"><ShieldCheck size={13}/> PAPER-FIRST</span><button className="refresh-button" onClick={refresh}><RefreshCw size={14}/> Sync</button></div></div>
        {loadError && (apiMissing
          ? <div className="connection-warning" role="alert"><Zap size={15}/><span>{loadError} Live data needs a running JPTI API. Set its address in Connection Settings, or start it locally with <code>npm run start:api</code>.</span><button type="button" className="refresh-button" onClick={() => activeNav('Connection Settings')}>Open Connection Settings</button></div>
          : <div className="connection-warning" role="alert"><Zap size={15}/>{loadError} — start the JPTI API service to load live system data.</div>)}
        <WorkspaceBoundary key={page}><Suspense fallback={<WorkspaceFallback/>}>{renderWorkspace()}</Suspense></WorkspaceBoundary>
        <footer className="command-footer"><span>© 2026 JOPEARL TRADING INTELLIGENCE</span><span>MARKET DATA IS NOT A TRADE RECOMMENDATION</span><span>LIVE EXECUTION LOCKED BY DEFAULT</span></footer>
      </div>
    </main>
  </div>;
}

export default App;
