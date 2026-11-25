import React, { useState } from 'react';
import { apiFetch } from './lib/api.js';
import { productLabel } from './lib/bitget-search.js';
import { resolveInstrument, instrumentQuery } from './lib/bitget-instruments.js';
import { COMPARABLE_PRODUCTS, DEFAULT_FEE_BPS, buildReplayRequest, summarizeReplay, rankSummaries, comparisonCaveats } from './lib/backtest-compare.js';

const n = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }));
const FRAMES = ['5m', '15m', '30m', '1h', '4h', '1d'];

export default function BacktestCompare() {
  const [form, setForm] = useState({ symbol: 'BTC/USDT', timeframe: '1h', slippageBps: '5', initialCapital: '10000', riskPercent: '0.5', fundingRatePer8h: '0.0001', apiToken: '' });
  const [products, setProducts] = useState(['spot', 'futures']);
  const [fees, setFees] = useState({ ...DEFAULT_FEE_BPS });
  const [rows, setRows] = useState([]);
  const [problems, setProblems] = useState({});
  const [busy, setBusy] = useState(false);
  const [ranAt, setRanAt] = useState(null);
  const set = (key) => (event) => setForm((c) => ({ ...c, [key]: event.target.value }));
  const toggle = (id) => setProducts((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  const run = async () => {
    setBusy(true); setRows([]); setProblems({});
    const headers = { 'Content-Type': 'application/json', ...(form.apiToken ? { 'x-jpti-api-token': form.apiToken } : {}) };
    const capital = Number(form.initialCapital);
    const found = []; const failed = {};
    await Promise.all(products.map(async (product) => {
      try {
        const instrument = await resolveInstrument(apiFetch, product, form.symbol);
        if (!instrument) throw new Error(form.symbol + ' is not listed for this product.');
        const candlesResponse = await apiFetch('/api/exchanges/bitget/ohlcv/' + instrument.symbol.replace('/', '-') + '?timeframe=' + form.timeframe + '&limit=500&type=' + encodeURIComponent(product) + instrumentQuery(instrument.id), { cache: 'no-store' });
        const candleData = await candlesResponse.json();
        if (!candlesResponse.ok) throw new Error(candleData?.error || 'Candles unavailable.');
        const body = buildReplayRequest({ candles: candleData.candles, symbol: instrument.symbol, timeframe: form.timeframe, feeBps: Number(fees[product]), slippageBps: Number(form.slippageBps), initialCapital: capital, riskPercent: form.riskPercent });
        const replayResponse = await apiFetch('/api/alpha/replay', { method: 'POST', headers, body: JSON.stringify(body) });
        const replay = await replayResponse.json();
        if (!replayResponse.ok) throw new Error(replayResponse.status === 401 || replayResponse.status === 403 ? 'The replay API needs your JPTI API token (enter it above).' : replay?.error || 'Replay failed.');
        found.push(summarizeReplay(product, replay, { initialCapital: capital, fundingRatePer8h: Number(form.fundingRatePer8h) }));
      } catch (error) { failed[product] = error.message; }
    }));
    setRows(rankSummaries(found)); setProblems(failed); setRanAt(Date.now()); setBusy(false);
  };

  return <div className="bc-root">
    <section className="wb-card" aria-label="Comparison setup">
      <div className="wb-head"><b>PRODUCT COMPARISON</b><small>Same strategy engine, different Bitget products</small></div>
      <div className="bc-form">
        <label>Symbol<input value={form.symbol} onChange={set('symbol')} /></label>
        <label>Timeframe<select value={form.timeframe} onChange={set('timeframe')}>{FRAMES.map((f) => <option key={f} value={f}>{f}</option>)}</select></label>
        <label>Capital<input inputMode="decimal" value={form.initialCapital} onChange={set('initialCapital')} /></label>
        <label>Risk % per trade<input inputMode="decimal" value={form.riskPercent} onChange={set('riskPercent')} /></label>
        <label>Slippage bps<input inputMode="decimal" value={form.slippageBps} onChange={set('slippageBps')} /></label>
        <label>Assumed funding / 8h<input inputMode="decimal" value={form.fundingRatePer8h} onChange={set('fundingRatePer8h')} /></label>
        <label>API token<input type="password" autoComplete="off" value={form.apiToken} onChange={set('apiToken')} placeholder="if your API requires one" /></label>
      </div>
      <fieldset className="bc-products"><legend className="wb-note">Products and taker fee (bps — check your own fee tier)</legend>
        {COMPARABLE_PRODUCTS.map((id) => <label key={id} className="bc-product"><input type="checkbox" checked={products.includes(id)} onChange={() => toggle(id)} /> {productLabel(id)} <input aria-label={productLabel(id) + ' fee in basis points'} inputMode="decimal" value={fees[id]} onChange={(e) => setFees((c) => ({ ...c, [id]: e.target.value }))} /></label>)}
      </fieldset>
      <button className="bc-btn" type="button" disabled={busy || products.length < 2} onClick={run}>{busy ? 'Running replays…' : 'Run comparison'}</button>
      {products.length < 2 && <small className="wb-note">Select at least two products to compare.</small>}
      <small className="wb-note">Coin-M and CFD are excluded: the replay engine models linear PnL, so results for them would be wrong.</small>
    </section>
    {Object.keys(problems).length > 0 && <section className="wb-card" role="alert"><div className="wb-head"><b>COULD NOT RUN</b></div>{Object.entries(problems).map(([product, message]) => <p key={product} className="wb-note wb-warn"><b>{productLabel(product)}:</b> {message}</p>)}</section>}
    {rows.length > 0 && <section className="wb-card" aria-label="Comparison results">
      <div className="wb-head"><b>RESULTS</b><small>{ranAt ? new Date(ranAt).toLocaleTimeString() : ''} · ranked by net PnL after fees, slippage and assumed funding</small></div>
      <div className="table-scroll"><table className="bc-table"><thead><tr><th>#</th><th>PRODUCT</th><th>TRADES</th><th>WIN %</th><th>PROFIT FACTOR</th><th>NET PNL</th><th>FUNDING</th><th>MAX DD %</th><th>OUT-OF-SAMPLE PNL</th><th>CANDLES</th></tr></thead><tbody>{rows.map((r) => <tr key={r.product}><td>{r.rank}</td><td><b>{productLabel(r.product)}</b></td><td>{r.trades}</td><td>{n(r.winRatePercent, 1)}</td><td>{n(r.profitFactor, 2)}</td><td className={r.netPnl >= 0 ? 'wb-up' : 'wb-down'}>{n(r.netPnl, 2)}</td><td>{n(-r.fundingCost, 2)}</td><td>{n(r.maxDrawdownPercent, 1)}</td><td>{n(r.outOfSampleNetPnl, 2)}{r.outOfSampleTrades !== null ? <small className="wb-note"> ({r.outOfSampleTrades})</small> : null}</td><td>{r.candles ?? '—'}</td></tr>)}</tbody></table></div>
      {rows.some((r) => r.trades < 30) && <p className="wb-note wb-warn">Some products have fewer than 30 trades. Treat those figures as anecdotal, not as evidence of an edge.</p>}
      <ul className="wb-checks">{comparisonCaveats(form.fundingRatePer8h).map((line) => <li key={line}>{line}</li>)}</ul>
    </section>}
  </div>;
}
