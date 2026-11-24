import React, { useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, BookOpen, Brain, CalendarDays, CheckCircle2, ClipboardList, Download, FileText, Lightbulb, MessageSquareText, Plus, RefreshCw, ShieldAlert, Target, TrendingDown, TrendingUp, XCircle } from 'lucide-react';
import { apiFetch } from './lib/api.js';
import './ReflectiveJournal.css';

const STORAGE_KEY = 'jpti.reflective-journal.v1';
const INITIAL_ENTRY = {
  id: 'jpti-2026-11-24-sophusdt-001',
  date: '2026-11-24',
  createdAt: '2026-11-24T00:00:00.000Z',
  symbol: 'SOPH/USDT',
  exchange: 'Not specified by user',
  marketType: 'USDT-M Futures',
  direction: 'long',
  timeframe: '15m',
  orderType: 'Limit',
  orderStatus: 'pending-user-reported',
  entryPrice: 0.000815,
  quantity: 689973,
  margin: 28.7,
  leverage: 20,
  stopLoss: null,
  takeProfit: null,
  allocationPercent: 7,
  accountEquity: null,
  notional: 562.328995,
  expiryHours: 12,
  marketBias: 'bearish',
  thesis: 'User reports a bearish market but chose a 15-minute long limit entry. The intended thesis and reversal confirmation have not yet been documented.',
  rules: ['No trading on weekends', 'Adequate setup for meaningful trades', 'Confidence in the setup', 'Take profit whenever possible', 'No stop-loss for now (high-risk experiment)', 'No preparation, no trade'],
  profitPolicy: 'Withdraw 50% of realized profit and retain 50% in the trading account.',
  openingNarrative: 'Today I have decided to start anew in my trading journey. Today is to mark the solid day of trade transformation based on how often I could have started long ago but didn\\u2019t. I have heard of a lot of stories that are so fearful but I have decided to risk it starting from today with experience, strategy, curious and continuous learning, implementing other techniques, rewinding, adapting and becoming better. My objective is to be a pro trader and that journey starts today.',
  reflection: [],
  tags: ['first-trade', 'limit-order', 'high-leverage', 'no-stop-loss', 'learning'],
  assessment: { process: 'incomplete', risk: 'high', confidence: 'unverified' }
};

const money = (n, digits = 2) => Number.isFinite(Number(n)) ? '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
const price = (n) => Number.isFinite(Number(n)) ? Number(n).toLocaleString(undefined, { maximumFractionDigits: 10 }) : '—';
const pct = (n) => (Number(n) > 0 ? '+' : '') + Number(n).toFixed(2) + '%';
const safeLoad = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    return Array.isArray(parsed) && parsed.length ? parsed : [INITIAL_ENTRY];
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
  const addReflection = (event) => {
    event.preventDefault();
    if (!note.trim() && !lesson.trim() && !nextAction.trim()) return;
    const item = { id: crypto.randomUUID?.() || String(Date.now()), at: new Date().toISOString(), note: note.trim(), mood, lesson: lesson.trim(), nextAction: nextAction.trim() };
    updateActive({ reflection: [...(active.reflection || []), item] });
    setNote(''); setLesson(''); setNextAction('');
  };
  const checkMarket = async () => {
    setMarketState('loading'); setMarketError('');
    try {
      const symbol = active.symbol.replace('/', '');
      const [tickerResponse, candlesResponse] = await Promise.all([
        apiFetch('/api/exchanges/bitget/ticker/' + encodeURIComponent(active.symbol) + '?type=futures', { cache: 'no-store' }),
        apiFetch('/api/exchanges/bitget/ohlcv/' + encodeURIComponent(active.symbol) + '?type=futures&timeframe=15m&limit=100', { cache: 'no-store' })
      ]);
      const [ticker, candles] = await Promise.all([tickerResponse.json(), candlesResponse.json()]);
      if (!tickerResponse.ok) throw new Error(ticker.error || 'Ticker request failed');
      if (!candlesResponse.ok) throw new Error(candles.error || 'Candlestick request failed');
      setMarket({ ticker, candles, checkedAt: new Date().toISOString(), symbol });
      setMarketState('live');
    } catch (error) {
      setMarketState('unavailable');
      setMarketError(error.message || 'Live market context unavailable');
    }
  };
  const exportJournal = () => {
    const blob = new Blob([JSON.stringify({ product: 'JPTI Reflective Trading Journal', exportedAt: new Date().toISOString(), entries }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'jpti-reflective-trading-journal.json'; a.click(); URL.revokeObjectURL(url);
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
        <div className="rj-hero-actions"><button onClick={exportJournal}><Download size={15}/> Export journal</button><span className="rj-save-state">{toast || 'Local journal'}</span></div>
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
          <div className="rj-callout danger"><ShieldAlert size={18}/><div><b>Risk review: 20× leverage with no stop-loss</b><p>A 5% adverse move in the underlying is approximately a $28.12 loss on the stated $562.33 notional, roughly equal to the stated $28.70 margin. Actual liquidation can occur earlier because of maintenance margin, fees and mark-price rules. This is a simplified exposure illustration, not an exchange liquidation calculation.</p></div></div>
          <div className="rj-subhead"><h4>Illustrative adverse-price scenarios</h4><span>Before fees and funding</span></div>
          <div className="rj-scenario-list">{scenarios.map(s => <div className="rj-scenario" key={s.move}><span>{s.move}% price move</span><div className="rj-bar"><i style={{ width: Math.min(100, Math.abs(s.pnl) / Math.max(active.margin || 1, 1) * 100) + '%' }}/></div><b className="negative">{money(s.pnl)}</b></div>)}</div>
          <div className="rj-footnote">Assumes a linear USDT-margined position with unchanged quantity. It does not model liquidation fees, maintenance margin tiers, funding or exchange-specific rules.</div>
          <div className="rj-market-box">
            <div className="rj-panel-title"><div><span className="rj-eyebrow">LIVE MARKET CHECK</span><h4>Public futures market-data cross-check (Bitget adapter; execution venue not confirmed)</h4></div><button className="rj-secondary" onClick={checkMarket} disabled={marketState === 'loading'}><RefreshCw size={14}/>{marketState === 'loading' ? 'Checking…' : 'Check now'}</button></div>
            {marketState === 'live' && market && <div className="rj-live-result"><b>Market response received</b><span>Checked {new Date(market.checkedAt).toLocaleString()}</span><pre>{JSON.stringify({ ticker: market.ticker, latestCandles: Array.isArray(market.candles?.data) ? market.candles.data.slice(-3) : market.candles?.data || market.candles }, null, 2).slice(0, 1800)}</pre></div>}
            {marketState === 'unavailable' && <p className="rj-footnote">{marketError}. The public-data adapter may not support this symbol format or product category. No market values have been invented.</p>}
            {marketState === 'not-checked' && <p className="rj-footnote">Live quote and candles have not yet been checked from this screen. Use the main JPTI chart to confirm the exact contract and product category.</p>}
          </div>
        </section>

        <aside className="rj-panel">
          <span className="rj-eyebrow">OPENING STATEMENT</span>
          <h3>Your trading commitment</h3>
          <blockquote>{active.openingNarrative}</blockquote>
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
        <span className="rj-eyebrow">INITIAL TRADER PROFILE · LOW CONFIDENCE</span><h2>What this first decision suggests</h2>
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
