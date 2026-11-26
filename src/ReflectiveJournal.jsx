import React, { useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, BookOpen, Brain, CalendarDays, CheckCircle2, ClipboardList, Download, FileText, Lightbulb, MessageSquareText, Plus, RefreshCw, ShieldAlert, TrendingUp, XCircle } from 'lucide-react';
import { apiFetch, setApiToken } from './lib/api.js';
import { analyzeTimeframe, buildTradingDevelopmentAssessment, buildReflectiveReport } from './trading-development-engine.js';
import './ReflectiveJournal.css';
import AgentReport from './AgentReport.jsx';
import SavedReportsPanel from './SavedReportsPanel.jsx';
import { isReportEntry, mergeReports, readSavedReports, writeSavedReports } from './lib/saved-reports.js';

const STORAGE_KEY = 'jpti.reflective-journal.v1';
const INITIAL_ENTRY = {
  id: 'jpti-2026-11-24-sophusdt-001',
  date: '2026-11-24',
  createdAt: '2026-11-24T00:00:00.000Z',
  symbol: 'SOPH/USDT',
  exchange: 'Not specified by user',
  marketType: 'Futures (contract type not confirmed)',
  direction: 'long',
  timeframe: '15m',
  orderType: 'Limit',
  orderStatus: 'pending-user-reported',
  entryPrice: 0.000815,
  quantity: 689973,
  margin: 28.7,
  leverage: 20,
  liquidationPrice: 0.000226,
  institutionalLiquidityLevel: 0.000815,
  institutionalLiquidityHypothesis: 'User-supplied hypothesis: the limit entry at $0.000815 aligns with an estimated institutional liquidation/liquidity level. Source, methodology and actual order-flow evidence have not yet been supplied; this is not verified institutional positioning.',
  stopLoss: null,
  takeProfit: null,
  allocationPercent: 7,
  accountEquity: null,
  notional: 562.327995,
  expiryHours: 12,
  marketBias: 'bearish',
  thesis: 'User reports a bearish market but chose a 15-minute long limit entry. The intended thesis and reversal confirmation have not yet been documented.',
  rules: ['No trading on weekends', 'Adequate setup for meaningful trades', 'Confidence in the setup', 'Take profit whenever possible', 'No stop-loss for now (high-risk experiment)', 'No preparation, no trade'],
  profitPolicy: 'Withdraw 50% of realized profit and retain 50% in the trading account.',
  openingNarrative: 'Today I have decided to start anew in my trading journey. Today is to mark the solid day of trade transformation based on how often I could have started long ago but didn\\u2019t. I have heard of a lot of stories that are so fearful but I have decided to risk it starting from today with experience, strategy, curious and continuous learning, implementing other techniques, rewinding, adapting and becoming better. My objective is to be a pro trader and that journey starts today.',
  reflection: [],
  tags: ['first-trade', 'limit-order', 'high-leverage', 'no-stop-loss', 'learning'],
  assessment: { process: 'incomplete', risk: 'high', confidence: 'unverified' },
  researchSnapshot: {
    asOf: '2026-11-24',
    projectFundamentals: {
      finding: 'Sophon announced a wind-down of its own Layer 2 chain and a strategic shift toward consumer applications built on Base. SOPH remains an Ethereum-native token; its former chain gas, staking and node-reward utility is changing. The project states a product-revenue-funded buyback-and-burn thesis.',
      source: 'Official Sophon token update',
      url: 'https://sophon.com/content/soph-token/',
      confidence: 'official-project-statement'
    },
    chainMigration: {
      finding: 'The chain migration guide describes the wind-down and instructs users holding assets on Sophon Chain to bridge them out. This is a chain-infrastructure change, not proof that the SOPH token itself is discontinued.',
      source: 'Official Sophon migration guide',
      url: 'https://sophon.com/content/sophon-migration/',
      confidence: 'official-project-statement'
    },
    unlockWatch: {
      finding: 'One tokenomics tracker reports 169.45 million SOPH scheduled for 28 November 2026, about 1.7% of maximum supply. Other trackers report different vesting states and cliff data; treat the event amount and circulating-supply impact as unconfirmed until reconciled with official vesting data.',
      source: 'Tokenomics.com unlock tracker',
      url: 'https://app.tokenomics.com/tokenomics/sophon/unlocks',
      confidence: 'third-party-data-conflict'
    },
    derivativesSnapshot: {
      venue: 'Binance USDT perpetual — not the user-confirmed execution venue',
      observedAt: '2026-11-24T13:45:00Z',
      price: 0.000886,
      priceChange24hPct: 1.4,
      openInterestUsd: 3900000,
      openInterestChange24hPct: -5.7,
      fundingRate: 0.00005,
      longAccountsPct: 51,
      topTradersLongBySizePct: 64,
      source: 'Seandra public derivatives snapshot',
      url: 'https://seandra.ai/perp/soph',
      confidence: 'timestamped-third-party-market-snapshot'
    },
    caveats: [
      'Cross-venue market prices, funding rates and open interest are not interchangeable.',
      'The Binance derivatives snapshot is not a Bitget quote and does not prove the order venue.',
      'Token unlock trackers disagree on vesting and supply figures; preserve source and timestamp.',
      'Fundamental transition risk can affect liquidity, sentiment and volatility, but does not determine the next candle direction.'
    ]
  }
};

const money = (n, digits = 2) => Number.isFinite(Number(n)) ? '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
const price = (n) => Number.isFinite(Number(n)) ? Number(n).toLocaleString(undefined, { maximumFractionDigits: 10 }) : '—';
const pct = (n) => (Number(n) > 0 ? '+' : '') + Number(n).toFixed(2) + '%';
const safeLoad = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!Array.isArray(parsed) || !parsed.length) return [INITIAL_ENTRY];
    return parsed.map(entry => entry?.id === INITIAL_ENTRY.id ? {
      ...INITIAL_ENTRY, ...entry,
      liquidationPrice: entry.liquidationPrice ?? INITIAL_ENTRY.liquidationPrice,
      institutionalLiquidityLevel: entry.institutionalLiquidityLevel ?? INITIAL_ENTRY.institutionalLiquidityLevel,
      institutionalLiquidityHypothesis: entry.institutionalLiquidityHypothesis || INITIAL_ENTRY.institutionalLiquidityHypothesis,
      researchSnapshot: entry.researchSnapshot || INITIAL_ENTRY.researchSnapshot,
      rules: Array.isArray(entry.rules) ? entry.rules : INITIAL_ENTRY.rules,
      reflection: Array.isArray(entry.reflection) ? entry.reflection : []
    } : entry);
  } catch { return [INITIAL_ENTRY]; }
};
const riskScenarios = (notional) => [-1, -2, -3, -4, -5].map(move => ({ move, pnl: notional * move / 100 }));

function Metric({ label, value, detail, tone }) {
  return <div className={'rj-metric ' + (tone || '')}><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;
}

export default function ReflectiveJournal() {
  const [entries, setEntries] = useState(safeLoad);
  const [selectedId, setSelectedId] = useState(INITIAL_ENTRY.id);
  const [note, setNote] = useState('');
  const [mood, setMood] = useState('calm');
  const [lesson, setLesson] = useState('');
  const [nextAction, setNextAction] = useState('');
  const [market, setMarket] = useState(null);
  const [selectedExchange, setSelectedExchange] = useState('');
  const [assessment, setAssessment] = useState(null);
  const [journalToken, setJournalToken] = useState('');
  const [journalConnected, setJournalConnected] = useState(false);
  const [syncStatus, setSyncStatus] = useState('Not connected to Cloudflare D1');
  const [mentorState, setMentorState] = useState('idle');
  const [mentorReview, setMentorReview] = useState('');
  const [mentorError, setMentorError] = useState('');
  const [marketState, setMarketState] = useState('not-checked');
  const [marketError, setMarketError] = useState('');
  const [tab, setTab] = useState('journal');
  const [toast, setToast] = useState('');
  const active = entries.find(e => e.id === selectedId) || entries[0] || INITIAL_ENTRY;
  const scenarios = useMemo(() => riskScenarios(Number(active.notional || active.entryPrice * active.quantity)), [active]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); setToast('Saved on this device'); }
    catch { setToast('Local storage unavailable — export a backup'); }
  }, [entries]);

  const updateActive = (patch) => setEntries(current => current.map(e => e.id === active.id ? { ...e, ...patch, updatedAt: new Date().toISOString() } : e));
  const connectJournal = async () => {
    try {
      if (!journalToken.trim()) throw new Error('Enter the private JPTI journal token first.');
      setApiToken(journalToken.trim());
      setSyncStatus('Connecting…');
      const response = await apiFetch('/api/journal/entries', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Cloudflare journal connection failed.');
      const remoteAll = Array.isArray(data.entries) ? data.entries : [];
      const remote = remoteAll.filter(entry => !isReportEntry(entry));
      try { writeSavedReports(localStorage, mergeReports(readSavedReports(localStorage), remoteAll)); window.dispatchEvent(new CustomEvent('jpti:reports-changed')); } catch { /* saved reports are best effort */ }
      if (remote.length) {
        const merged = new Map(remote.map(entry => [entry.id, entry]));
        for (const local of entries) {
          const existing = merged.get(local.id);
          if (!existing || String(local.updatedAt || local.createdAt || '') > String(existing.updatedAt || existing.createdAt || '')) merged.set(local.id, local);
        }
        setEntries([...merged.values()]);
      } else {
        for (const entry of entries) {
          const saved = await apiFetch('/api/journal/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry }) });
          if (!saved.ok) throw new Error((await saved.json()).error || 'Initial journal backup failed.');
        }
      }
      setJournalConnected(true);
      setSyncStatus('Connected · Cloudflare D1');
    } catch (error) {
      setApiToken('');
      setJournalConnected(false);
      setSyncStatus(error.message || 'Cloudflare D1 connection failed');
    }
  };

  useEffect(() => {
    if (!journalConnected) return;
    let cancelled = false;
    (async () => {
      try {
        for (const entry of entries) {
          const response = await apiFetch('/api/journal/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry }) });
          if (!response.ok) throw new Error((await response.json()).error || 'Journal sync failed.');
        }
        if (!cancelled) setSyncStatus('Synced · Cloudflare D1');
      } catch (error) {
        if (!cancelled) setSyncStatus(error.message || 'Sync failed');
      }
    })();
    return () => { cancelled = true; };
  }, [entries, journalConnected]);
  const addReflection = (event) => {
    event.preventDefault();
    if (!note.trim() && !lesson.trim() && !nextAction.trim()) return;
    const item = { id: crypto.randomUUID?.() || String(Date.now()), at: new Date().toISOString(), note: note.trim(), mood, lesson: lesson.trim(), nextAction: nextAction.trim() };
    updateActive({ reflection: [...(active.reflection || []), item] });
    setNote(''); setLesson(''); setNextAction('');
  };
  const checkMarket = async () => {
    if (selectedExchange !== 'bitget') { setMarketState('unavailable'); setMarketError('Select Bitget USDT-M futures for this Cloudflare market-data adapter. Other execution venues must be verified separately.'); return; }
    setMarketState('loading'); setMarketError('');
    try {
      const timeframes = ['15m','1h','4h','1d'];
      const responses = await Promise.all(timeframes.map(timeframe =>
        apiFetch('/api/exchanges/' + selectedExchange + '/ohlcv/' + encodeURIComponent(active.symbol) + '?type=futures&timeframe=' + timeframe + '&limit=120', { cache: 'no-store' })
      ));
      const payloads = await Promise.all(responses.map(response => response.json()));
      const failed = responses.findIndex(response => !response.ok);
      if (failed >= 0) throw new Error(payloads[failed]?.error || 'Market data request failed for ' + timeframes[failed]);
      const analyzed = Object.fromEntries(timeframes.map((timeframe, index) => {
        const payload = payloads[index];
        const candles = Array.isArray(payload) ? payload : payload.data || payload.candles || payload.ohlcv || payload.result?.list || [];
        return [timeframe, analyzeTimeframe(candles, timeframe)];
      }));
      const result = buildTradingDevelopmentAssessment({ direction: active.direction, timeframes: analyzed, trade: active });
      setMarket({ timeframes: analyzed, checkedAt: new Date().toISOString(), exchange: selectedExchange, symbol: active.symbol });
      setAssessment(result);
      updateActive({ technicalAssessment: result, researchCheckedAt: result.generatedAt, exchange: selectedExchange });
      setMarketState('live');
    } catch (error) { setMarketState('unavailable'); setMarketError(error.message || 'Live market context unavailable'); }
  };
  const exportJournal = () => {
    const blob = new Blob([JSON.stringify({ product: 'JPTI Reflective Trading Journal', exportedAt: new Date().toISOString(), entries }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'jpti-reflective-trading-journal.json'; a.click(); URL.revokeObjectURL(url);
  };
  const exportReport = () => {
    const report = buildReflectiveReport(active, assessment || active.technicalAssessment || null);
    const blob = new Blob([report], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'jpti-' + String(active.symbol || 'trade').replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-reflective-report.md'; a.click(); URL.revokeObjectURL(url);
  };
  const copyReport = async () => {
    try { await navigator.clipboard.writeText(buildReflectiveReport(active, assessment || active.technicalAssessment || null)); setToast('Reflective report copied'); }
    catch { setToast('Clipboard unavailable — export the Markdown report instead'); }
  };
  const runMentorReview = async () => {
    if (!journalConnected) { setMentorError('Connect your private Cloudflare D1 journal first.'); return; }
    setMentorState('loading'); setMentorError('');
    try {
      const response = await apiFetch('/api/mentor/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry: active, technicalAssessment: assessment || active.technicalAssessment || null, research: active.researchSnapshot || null, history: entries.slice(-30) })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'AI mentor review failed.');
      setMentorReview(data.review || '');
      updateActive({ mentorReview: data.review || '', aiResearch: data.research || null, aiReviewAt: data.generatedAt, aiModel: data.model });
      setMentorState('complete');
    } catch (error) { setMentorError(error.message || 'AI mentor review unavailable.'); setMentorState('error'); }
  };
  const markStatus = (status) => updateActive({ orderStatus: status });
  const accountEstimate = active.margin && active.allocationPercent ? Number(active.margin) / (Number(active.allocationPercent) / 100) : null;
  const entryNotional = Number(active.notional || active.entryPrice * active.quantity);
  const marginLossAtFive = entryNotional * 0.05;
  const marginCoverage = active.margin ? (Number(active.margin) / entryNotional) * 100 : 0;
  const statusLabel = active.orderStatus === 'pending-user-reported' ? 'Pending · user reported' : active.orderStatus.replaceAll('-', ' ');

  return <main className="reflective-journal">
    <header className="rj-hero">
      <div className="rj-hero-copy">
        <span className="rj-eyebrow"><BookOpen size={14}/> PERSONAL TRADING DEVELOPMENT RECORD</span>
        <h1>Reflective Trade Journal</h1>
        <p>A private record of your decisions, evidence, execution, risk, behaviour and lessons. The journal values decision quality over whether a trade happens to win.</p>
        <div className="rj-hero-actions"><button onClick={exportJournal}><Download size={15}/> Export JSON</button><button onClick={exportReport}><FileText size={15}/> Export report</button><button onClick={copyReport}><ClipboardList size={15}/> Copy report</button><span className="rj-save-state">{toast || 'Local journal'}</span></div>
      </div>
      <div className="rj-hero-mark"><Brain size={42}/><b>THINK<br/>REVIEW<br/>IMPROVE</b></div>
    </header>

    <nav className="rj-tabs" aria-label="Journal sections">
      <button className={tab === 'journal' ? 'active' : ''} onClick={() => setTab('journal')}>Trade journal</button>
      <button className={tab === 'coach' ? 'active' : ''} onClick={() => setTab('coach')}>Coach assessment</button>
      <button className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}>Trading charter</button>
    </nav>

    {tab === 'journal' && <>
      <section className="rj-section-head"><div><span className="rj-eyebrow">ENTRY 001 · 24 NOVEMBER 2026</span><h2>The beginning of a new trading chapter</h2></div><span className="rj-status"><i/> {statusLabel}</span></section>
      <div className="rj-grid rj-metrics">
        <Metric label="ORDER PRICE" value={price(active.entryPrice)} detail="Limit price supplied by you"/>
        <Metric label="POSITION NOTIONAL" value={money(entryNotional)} detail="Quantity × limit price"/>
        <Metric label="ALLOCATED MARGIN" value={money(active.margin)} detail={active.leverage + '× leverage'}/>
        <Metric label="ACCOUNT EQUITY ESTIMATE" value={accountEstimate ? money(accountEstimate) : 'Not confirmed'} detail="Derived from 7% allocation"/>
      </div>

      <div className="rj-layout">
        <section className="rj-panel rj-main-panel">
          <div className="rj-panel-title"><div><span className="rj-eyebrow">TRADE RECORD</span><h3>SOPH/USDT · Long</h3></div><span className="rj-chip warn">Risk elevated</span></div>
          <div className="rj-trade-grid">
            <div><small>Quantity</small><b>{Number(active.quantity).toLocaleString()} SOPH</b></div>
            <div><small>Timeframe</small><b>{active.timeframe}</b></div>
            <div><small>Market type</small><b>{active.marketType}</b></div>
            <div><small>Order type</small><b>{active.orderType}</b></div>
            <div><small>Stop-loss</small><b className="negative">Not set</b></div>
            <div><small>Reported liquidation</small><b>{price(active.liquidationPrice)}</b></div>
            <div><small>Estimated institutional level</small><b>{price(active.institutionalLiquidityLevel)} · unverified</b></div>
            <div><small>Take-profit</small><b>Not supplied</b></div>
            <div><small>Order expiry</small><b>12 hours after placement</b></div>
            <div><small>Market bias reported</small><b className="negative">Bearish</b></div>
          </div>
          <form className="rj-execution-form" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); updateActive({ fillPrice: data.get('fillPrice') ? Number(data.get('fillPrice')) : null, exitPrice: data.get('exitPrice') ? Number(data.get('exitPrice')) : null, realizedPnl: data.get('realizedPnl') ? Number(data.get('realizedPnl')) : null, fees: data.get('fees') ? Number(data.get('fees')) : 0, funding: data.get('funding') ? Number(data.get('funding')) : 0, setupThesis: String(data.get('setupThesis') || '').trim(), invalidation: String(data.get('invalidation') || '').trim() }); setToast('Execution details updated'); }}>
            <div className="rj-subhead"><h4>Execution and outcome fields</h4><span>Update when order fills or closes</span></div>
            <div className="rj-execution-grid">
              <label>Average fill price<input name="fillPrice" type="number" step="any" defaultValue={active.fillPrice ?? ''} placeholder="Not filled yet"/></label>
              <label>Exit price<input name="exitPrice" type="number" step="any" defaultValue={active.exitPrice ?? ''} placeholder="Open position"/></label>
              <label>Realized P/L (USDT)<input name="realizedPnl" type="number" step="any" defaultValue={active.realizedPnl ?? ''} placeholder="Not realized"/></label>
              <label>Fees (USDT)<input name="fees" type="number" step="any" defaultValue={active.fees ?? ''} placeholder="0"/></label>
              <label>Funding (USDT)<input name="funding" type="number" step="any" defaultValue={active.funding ?? ''} placeholder="0"/></label>
              <label>Invalidation condition<input name="invalidation" defaultValue={active.invalidation || ''} placeholder="What disproves the setup?"/></label>
            </div>
            <label className="rj-thesis-label">Actual setup thesis<textarea name="setupThesis" rows="2" defaultValue={active.setupThesis || active.thesis} placeholder="Document the evidence supporting this trade."/></label>
            <button className="rj-primary" type="submit"><ClipboardList size={15}/> Save execution details</button>
          </form>
          <p className="rj-footnote">{active.institutionalLiquidityHypothesis || "No institutional liquidity reference has been verified."}</p>
          <div className="rj-callout danger"><ShieldAlert size={18}/><div><b>Risk review: 20× leverage with no stop-loss</b><p>A 5% adverse move in the underlying is approximately a $28.12 loss on the $562.33 notional, roughly equal to the stated $28.70 margin. This does not establish the liquidation point: your reported $0.000226 liquidation level is much farther below entry and may depend on cross margin, additional collateral, maintenance tiers, other positions, fees and mark price. The exchange, contract and margin mode must be verified before reconciling it. This is an exposure illustration, not an exchange liquidation calculation.</p></div></div>
          <div className="rj-subhead"><h4>Illustrative adverse-price scenarios</h4><span>Before fees and funding</span></div>
          <div className="rj-scenario-list">{scenarios.map(s => <div className="rj-scenario" key={s.move}><span>{s.move}% price move</span><div className="rj-bar"><i style={{ width: Math.min(100, Math.abs(s.pnl) / Math.max(active.margin || 1, 1) * 100) + '%' }}/></div><b className="negative">{money(s.pnl)}</b></div>)}</div>
          <div className="rj-footnote">Assumes a linear USDT-margined position with unchanged quantity. It does not model liquidation fees, maintenance margin tiers, funding or exchange-specific rules.</div>
          <div className="rj-market-box">
            <div className="rj-panel-title"><div><span className="rj-eyebrow">MULTI-TIMEFRAME MARKET ASSESSMENT</span><h4>Closed-candle technical review</h4></div><button className="rj-secondary" onClick={checkMarket} disabled={marketState === "loading" || !selectedExchange}><RefreshCw size={14}/>{marketState === "loading" ? "Assessing…" : "Run assessment"}</button></div>
            <label className="rj-market-select">Execution venue
              <select value={selectedExchange} onChange={event => setSelectedExchange(event.target.value)}>
                <option value="">Select venue before fetching data</option>
                <option value="bitget">Bitget · USDT-M futures</option>
              </select>
            </label>
            {marketState === "live" && market && <div className="rj-live-result"><b>Technical assessment completed · {market.exchange.toUpperCase()}</b><span>Checked {new Date(market.checkedAt).toLocaleString()} · {market.symbol}</span>
              <div className="rj-timeframe-grid">{Object.entries(market.timeframes).map(([tf, result]) => <div key={tf}><small>{tf}</small><b className={result.bias === "bullish" ? "positive" : result.bias === "bearish" ? "negative" : ""}>{result.bias}</b><span>Score {result.score ?? "—"} · RSI {result.rsi14?.toFixed?.(1) ?? "—"}</span><span>Trend {result.trend || "—"}</span></div>)}</div>
              {assessment && <div className="rj-callout warn"><AlertTriangle size={17}/><div><b>Engine assessment: {assessment.decision.status.toUpperCase()}</b><p>Multi-timeframe bias: {assessment.market.bias}. Evidence status: {assessment.status}. Deterministic research assessment, not a probability or order instruction.</p></div></div>}
              <AgentReport content={{ market: assessment?.market, process: assessment?.process, risk: assessment?.risk, coaching: assessment?.coaching }} title="technical-assessment" maxChars={3200} />
            </div>}
            {marketState === "unavailable" && <p className="rj-footnote">{marketError}. No missing market values have been invented.</p>}
            {marketState === "not-checked" && <p className="rj-footnote">Select the actual execution venue first. The current Cloudflare futures adapter supports Bitget for this multi-timeframe check. This fetches public candles; it does not verify your private order or liquidation price.</p>}
          </div>
        </section>

        <aside className="rj-panel">
          <span className="rj-eyebrow">OPENING STATEMENT</span>
          <h3>Your trading commitment</h3>
          <blockquote>{active.openingNarrative}</blockquote>
          <div className="rj-divider"/>
          <span className="rj-eyebrow">PAIR-SPECIFIC FUNDAMENTAL RESEARCH</span>
          <h3>SOPH research snapshot</h3>
          <p className="rj-footnote">Recorded 24 November 2026. This is a dated research snapshot, not a live feed.</p>
          <ul className="rj-research-list">
            <li><b>Project transition:</b> Sophon is winding down its own L2 chain and shifting toward consumer applications on Base. SOPH itself is not described as discontinued.</li>
            <li><b>Token value thesis:</b> the project describes product-revenue-funded buybacks and burns. Execution and revenue traction remain to be verified.</li>
            <li><b>Unlock watch:</b> a third-party tracker reports 169.45M SOPH on 28 November; other trackers disagree on vesting figures.</li>
            <li><b>Derivatives:</b> Binance snapshot showed $3.9M OI, down 5.7% in 24h, with positive funding. This is not an execution-venue quote.</li>
          </ul>
          <div className="rj-source-links"><a href="https://sophon.com/content/soph-token/" target="_blank" rel="noreferrer">Official SOPH token update</a><a href="https://sophon.com/content/sophon-migration/" target="_blank" rel="noreferrer">Official chain migration guide</a><a href="https://app.tokenomics.com/tokenomics/sophon/unlocks" target="_blank" rel="noreferrer">Unlock tracker</a><a href="https://seandra.ai/perp/soph" target="_blank" rel="noreferrer">Derivatives snapshot</a></div>
          <div className="rj-divider"/>
          <span className="rj-eyebrow">PROFIT ALLOCATION POLICY</span>
          <div className="rj-split"><div><b>50%</b><span>Withdraw</span></div><div><b>50%</b><span>Retain in account</span></div></div>
          <p className="rj-footnote">Apply this policy to realized net profit after fees and funding, not unrealized gains. Record each withdrawal and retained amount separately.</p>
          <div className="rj-divider"/>
          <span className="rj-eyebrow">ORDER STATUS · MANUAL RECORD</span>
          <div className="rj-status-actions">
            <button onClick={() => markStatus('pending-user-reported')}><Activity size={14}/> Pending</button>
            <button onClick={() => markStatus('filled-user-reported')}><CheckCircle2 size={14}/> Filled</button>
            <button onClick={() => markStatus('cancelled-user-reported')}><XCircle size={14}/> Cancelled</button>
            <button onClick={() => markStatus('expired-user-reported')}><CalendarDays size={14}/> Expired</button>
          </div>
          <p className="rj-footnote">These controls update your journal only. They do not place, cancel or verify an exchange order.</p>
          <div className="rj-divider"/>
          <span className="rj-eyebrow">PRIVATE CLOUD BACKUP</span>
          <h4>Cloudflare D1 journal sync</h4>
          <p className="rj-footnote">Use the private JPTI journal token configured as a Cloudflare Pages secret. The token stays in this browser session and is never included in exported journal files.</p>
          <input className="rj-token-input" type="password" autoComplete="off" value={journalToken} onChange={event => setJournalToken(event.target.value)} placeholder="Private journal access token"/>
          <button className="rj-secondary" onClick={connectJournal}>Connect and sync journal</button>
          <p className="rj-footnote">{syncStatus}</p>
        </aside>
      </div>

      <section className="rj-panel">
        <div className="rj-panel-title"><div><span className="rj-eyebrow">CONTINUOUS RECORD</span><h3>Reflect, update and learn</h3></div><MessageSquareText size={20}/></div>
        <form className="rj-reflection-form" onSubmit={addReflection}>
          <label>What happened or what new information should be added?<textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Example: The limit order filled at 0.000815. The 15m candle closed below support…" rows={3}/></label>
          <div className="rj-form-grid">
            <label>State of mind<select value={mood} onChange={e => setMood(e.target.value)}><option value="calm">Calm</option><option value="confident">Confident</option><option value="anxious">Anxious</option><option value="fearful">Fearful</option><option value="greedy">Greedy / overexcited</option><option value="frustrated">Frustrated</option><option value="uncertain">Uncertain</option></select></label>
            <label>Lesson learned<input value={lesson} onChange={e => setLesson(e.target.value)} placeholder="What did this teach you?"/></label>
          </div>
          <label>Next action<input value={nextAction} onChange={e => setNextAction(e.target.value)} placeholder="A measurable action or rule for the next trade"/></label>
          <button className="rj-primary" type="submit"><Plus size={15}/> Add dated journal update</button>
        </form>
        <div className="rj-timeline">{(active.reflection || []).slice().reverse().map(item => <article key={item.id}><span className="rj-timeline-dot"/><div><small>{new Date(item.at).toLocaleString()} · {item.mood}</small>{item.note && <p>{item.note}</p>}{item.lesson && <p><b>Lesson:</b> {item.lesson}</p>}{item.nextAction && <p><b>Next action:</b> {item.nextAction}</p>}</div></article>)}{!active.reflection?.length && <p className="rj-footnote">No post-entry updates yet. Every new fact you provide can be added here with its timestamp.</p>}</div>
      </section>
    </>}

    {tab === 'coach' && <div className="rj-coach-grid">
      <section className="rj-panel">
        <span className="rj-eyebrow">AI TRADING COUNCIL · CLOUDFLARE WORKERS AI</span><h2>Personal mentor and research review</h2>
        <p className="rj-lead">The AI review researches the pair through public asset and news sources, then assesses your journal, technical evidence, risk and behaviour. It must identify source conflicts and missing evidence.</p>
        <div className="rj-ai-actions"><button className="rj-primary" onClick={runMentorReview} disabled={mentorState === 'loading'}><Brain size={15}/>{mentorState === 'loading' ? 'Researching and reviewing…' : 'Run full AI mentor review'}</button><span className="rj-footnote">{mentorState === 'complete' ? 'Review saved to this trade record.' : 'Requires Cloudflare D1 connection and the Workers AI binding.'}</span></div>
        {mentorError && <div className="rj-callout danger"><AlertTriangle size={17}/><div>{mentorError}</div></div>}
        {(mentorReview || active.mentorReview) && <div className="rj-ai-report"><div className="rj-panel-title"><b>Latest AI mentor report</b><span className="rj-footnote">{active.aiReviewAt ? new Date(active.aiReviewAt).toLocaleString() : ''}</span></div><AgentReport content={mentorReview || active.mentorReview} title="ai-mentor-report" source="journal-mentor" /></div>}
        <SavedReportsPanel />
        <div className="rj-divider"/>
        <span className="rj-eyebrow">RULES-BASED PROFILE · LOW CONFIDENCE</span><h2>What this first decision suggests</h2>
        <div className="rj-callout warn"><Brain size={18}/><div><b>Honest capability boundary</b><p>This workspace currently provides deterministic, rules-based coaching and a structured journal. It does not contain a connected generative AI model, and it will not pretend to perform autonomous research or exchange actions. The conversational research, writing, mentoring and pair-specific analysis will be supplied here and recorded in the journal as you share updates.</p></div></div>
        <p className="rj-lead">This is a preliminary behavioural hypothesis based on one planned trade and the rules you supplied. It is not a fixed personality label or a statistically reliable trader profile.</p>
        <div className="rj-assessment"><div><TrendingUp/><b>Strengths emerging</b><ul><li>You are setting explicit operating rules.</li><li>You are documenting the trade before execution.</li><li>You want software-supported decisions and independent review.</li><li>You have a defined profit-retention policy.</li><li>You are willing to review and adapt rather than hide mistakes.</li></ul></div><div><AlertTriangle/><b>Risks and blind spots</b><ul><li>Long exposure conflicts with your stated bearish market view unless a countertrend setup is documented.</li><li>20× leverage and no stop-loss expose the margin to rapid depletion.</li><li>“Take profit whenever possible” is subjective without a planned exit framework.</li><li>“Confidence” needs evidence and invalidation conditions, not feeling alone.</li><li>Testing how daring you can be may reward risk-taking rather than good process.</li></ul></div></div>
      </section>
      <section className="rj-panel">
        <span className="rj-eyebrow">MENTOR'S FIRST DIRECTIVE</span><h2>Do not confuse bravery with risk control.</h2>
        <p>Professional development is measured by repeatable decisions, controlled downside, honest records and a growing sample of evidence. Your first task is to define exactly what would prove the long thesis wrong before the order fills.</p>
        <div className="rj-callout warn"><Lightbulb size={18}/><div><b>Before any future entry</b><p>Write the market regime, higher-timeframe direction, entry trigger, invalidation level, position size, maximum acceptable loss, target logic and the reason the setup has positive expectancy.</p></div></div>
        <h4>Decision-quality scorecard</h4>
        <div className="rj-score-row"><span>Preparation documented</span><b>Partial</b></div><div className="rj-score-row"><span>Market thesis explained</span><b>Incomplete</b></div><div className="rj-score-row"><span>Risk defined</span><b className="negative">No</b></div><div className="rj-score-row"><span>Execution verified</span><b>Pending</b></div><div className="rj-score-row"><span>Exit plan defined</span><b className="negative">No</b></div>
      </section>
    </div>}

    {tab === 'rules' && <section className="rj-panel">
      <span className="rj-eyebrow">YOUR TRADING CHARTER</span><h2>Rules you have declared</h2>
      <p className="rj-lead">These are recorded as your current preferences, not endorsed as safe risk-management practices. The journal will track rule adherence and flag conflicts.</p>
      <div className="rj-rule-list">{active.rules.map((rule, index) => <div key={index}><span>{String(index + 1).padStart(2, '0')}</span><b>{rule}</b>{index === 4 && <em>High-risk policy · review recommended</em>}</div>)}</div>
      <div className="rj-callout danger"><AlertTriangle size={18}/><div><b>Recommended amendment: replace “no SLs” with defined maximum risk.</b><p>If you choose not to use a conventional stop order, define an alternative exit trigger, maximum monetary loss, monitoring plan and liquidation buffer before entering. An experiment should have a bounded cost.</p></div></div>
      <h3>Operating principles I will apply as your JPTI mentor</h3>
      <ul className="rj-principles"><li>Separate facts, hypotheses and opinions.</li><li>Do not fabricate live prices, order status, news or technical signals.</li><li>Research the specific asset and venue when you submit a trade.</li><li>Challenge trades that conflict with the market evidence or your written rules.</li><li>Evaluate process quality independently of profit or loss.</li><li>Track sample size and uncertainty before making strategy claims.</li><li>Never recommend increasing risk to recover losses.</li><li>Keep a dated audit trail when you revise a thesis or rule.</li></ul>
    </section>}
    <footer className="rj-footer"><span>JPTI REFLECTIVE INTELLIGENCE · PERSONAL JOURNAL</span><span>Stored locally in this browser · Export backups regularly</span></footer>
  </main>;
}
