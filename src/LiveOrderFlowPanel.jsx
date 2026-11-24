import React, { useEffect, useMemo, useState } from 'react';
import {
  aggregateTrades,
  detectLiveSweep,
  normalizeTrade
} from './chart-intelligence/live-trade-flow.js';
import './LiveOrderFlowPanel.css';
import { analyzeOrderBook, normalizeOrderBookMessage } from './chart-intelligence/microstructure.js';

const pair = (symbol) =>
  String(symbol || 'BTC/USDT').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

const fmt = (value) =>
  value == null
    ? '—'
    : Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 });

export default function LiveOrderFlowPanel({
  exchange = 'bitget',
  symbol = 'BTC/USDT',
  marketType = 'spot',
  instrumentId = '',
  candles = []
}) {
  const [trades, setTrades] = useState([]);
  const [state, setState] = useState('connecting');
  const [error, setError] = useState('');
  const [clock, setClock] = useState(Date.now());
  const [book, setBook] = useState(null);
  const [bookState, setBookState] = useState('connecting');
  const [bookError, setBookError] = useState('');

  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let ws;
    let timer;
    let heartbeat;
    let alive = true;
    let delay = 1000;

    const connect = () => {
      if (!alive) return;
      setTrades([]);
      setError('');
      if (marketType === 'cfd') { setState('unsupported'); setError('Bitget CFD market data does not expose this public crypto trade-print stream. CVD and taker pressure are intentionally unavailable for CFDs.'); return; }
      if (exchange !== 'bitget') { setState('unsupported'); setError('Native trade stream is currently wired to Bitget only.'); return; }

      setState('connecting');

      try {
        ws = new WebSocket('wss://ws.bitget.com/v2/ws/public');

        ws.onopen = () => {
          if (!alive) return;

          setState('live');
          delay = 1000;

          ws.send(JSON.stringify({
            op: 'subscribe',
            args: [{
              instType: ({ spot: 'SPOT', margin: 'SPOT', futures: 'USDT-FUTURES', perpetual: 'USDT-FUTURES', 'coin-futures': 'COIN-FUTURES', 'usdc-futures': 'USDC-FUTURES' })[marketType] || 'SPOT',
              channel: 'trade',
              instId: String(instrumentId || pair(symbol))
            }]
          }));

          heartbeat = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send('ping');
            }
          }, 25000);
        };

        ws.onmessage = (event) => {
          if (!alive || event.data === 'pong') return;

          try {
            const message = JSON.parse(event.data);

            if (message.event === 'error') {
              setError(message.msg || 'Subscription rejected');
              return;
            }

            const normalized = (Array.isArray(message.data) ? message.data : [])
              .map((trade) => normalizeTrade({
                price: trade.price,
                size: trade.size,
                side: trade.side,
                ts: trade.ts
              }))
              .filter(Boolean);

            if (normalized.length) {
              setTrades((previous) => [...previous, ...normalized].slice(-3000));
            }
          } catch {
            setError('Unable to parse exchange trade event');
          }
        };

        ws.onerror = () => {
          setState('offline');
          setError('Trade websocket error; reconnecting');
        };

        ws.onclose = () => {
          if (!alive) return;

          clearInterval(heartbeat);
          setState('reconnecting');
          timer = setTimeout(connect, delay);
          delay = Math.min(delay * 2, 30000);
        };
      } catch {
        setState('offline');
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30000);
      }
    };

    connect();

    return () => {
      alive = false;
      clearTimeout(timer);
      clearInterval(heartbeat);

      try {
        ws?.close();
      } catch {
        // The socket may already have closed during component teardown.
      }
    };
  }, [exchange, symbol, marketType, instrumentId]);

  useEffect(() => {
    let ws, timer, heartbeat, alive = true, delay = 1000;
    const connect = () => {
      if (!alive) return;
      setBook(null); setBookError('');
      if (exchange !== 'bitget') { setBookState('unsupported'); setBookError('Native order-book depth is currently available from the Bitget public depth stream. Other venues are withheld until their own depth adapters are connected.'); return; }
      if (marketType === 'cfd') { setBookState('unsupported'); setBookError('A consolidated public order book is not supplied for this CFD instrument.'); return; }
      setBookState('connecting');
      try {
        ws = new WebSocket('wss://ws.bitget.com/v2/ws/public');
        ws.onopen = () => {
          if (!alive) return;
          setBookState('live'); delay = 1000;
          const instType = ({ spot:'SPOT', margin:'SPOT', futures:'USDT-FUTURES', perpetual:'USDT-FUTURES', 'coin-futures':'COIN-FUTURES', 'usdc-futures':'USDC-FUTURES' })[marketType] || 'SPOT';
          ws.send(JSON.stringify({ op:'subscribe', args:[{ instType, channel:'books5', instId:String(instrumentId || pair(symbol)) }] }));
          heartbeat = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send('ping'); }, 25000);
        };
        ws.onmessage = event => {
          if (!alive || event.data === 'pong') return;
          try {
            const message = JSON.parse(event.data);
            if (message.event === 'error') { setBookError(message.msg || 'Order-book subscription rejected'); setBookState('offline'); return; }
            const snapshot = normalizeOrderBookMessage(message);
            if (snapshot) setBook(snapshot);
          } catch { setBookError('Unable to parse public order-book update'); }
        };
        ws.onerror = () => { if (alive) { setBookState('offline'); setBookError('Depth stream error; reconnecting'); } };
        ws.onclose = () => { if (!alive) return; clearInterval(heartbeat); setBookState('reconnecting'); timer = setTimeout(connect, delay); delay = Math.min(delay * 2, 30000); };
      } catch { setBookState('offline'); timer = setTimeout(connect, delay); delay = Math.min(delay * 2, 30000); }
    };
    connect();
    return () => { alive = false; clearTimeout(timer); clearInterval(heartbeat); try { ws?.close(); } catch {} };
  }, [exchange, symbol, marketType, instrumentId]);

  const flow = useMemo(
    () => aggregateTrades(trades, clock),
    [trades, clock]
  );

  const cvd = useMemo(
    () => trades.reduce(
      (total, trade) =>
        total + (trade.side === 'buy' ? trade.size : trade.side === 'sell' ? -trade.size : 0),
      0
    ),
    [trades]
  );

  const sweep = useMemo(
    () => detectLiveSweep(candles, flow.latest?.price),
    [candles, flow.latest]
  );

  const depth = useMemo(() => analyzeOrderBook(book), [book]);

  const direction = flow.pressure > 0
    ? 'buy'
    : flow.pressure < 0
      ? 'sell'
      : 'neutral';

  if (marketType === 'cfd') return <section className="jpti-live-flow"><header><div><b>LIVE ORDER FLOW / LIQUIDITY</b><small>{symbol} · BITGET CFD</small></div><span className="jpti-flow-state unsupported"><i /> NOT AVAILABLE</span></header><p>Bitget CFD market data provides bid/ask quotes and side-specific candles, not this public crypto trade-print stream. CVD, taker pressure and live sweep claims are withheld rather than inferred from candle volume.</p></section>;

  return (
    <section className="jpti-live-flow">
      <header>
        <div>
          <b>LIVE ORDER FLOW / LIQUIDITY</b>
          <small>{symbol} · {exchange.toUpperCase()} public trades · rolling 60 seconds</small>
        </div>
        <span className={'jpti-flow-state ' + state}>
          <i /> {state.toUpperCase()}
        </span>
      </header>

      <div className="jpti-flow-grid">
        <article>
          <small>BUY VOLUME</small>
          <strong className="buy">{fmt(flow.buy)}</strong>
          <small>Notional {fmt(flow.buyNotional)}</small>
        </article>
        <article>
          <small>SELL VOLUME</small>
          <strong className="sell">{fmt(flow.sell)}</strong>
          <small>Notional {fmt(flow.sellNotional)}</small>
        </article>
        <article>
          <small>NET DELTA</small>
          <strong className={direction}>
            {flow.delta > 0 ? '+' : ''}{fmt(flow.delta)}
          </strong>
          <small>{flow.count} prints · unknown {fmt(flow.unknown)}</small>
        </article>
        <article>
          <small>TAKER PRESSURE</small>
          <strong className={direction}>{Math.round(flow.pressure * 100)}%</strong>
          <small>Side coverage {Math.round(flow.coverage * 100)}%</small>
        </article>
        <article>
          <small>LIVE CVD · BUFFER</small>
          <strong className={cvd >= 0 ? 'buy' : 'sell'}>
            {cvd >= 0 ? '+' : ''}{fmt(cvd)}
          </strong>
          <small>Last 3,000 trades held locally</small>
        </article>
        <article>
          <small>LAST PRICE</small>
          <strong>{fmt(flow.latest?.price)}</strong>
          <small>
            {flow.latest
              ? new Date(flow.latest.ts).toLocaleTimeString()
              : 'Waiting for trade prints'}
          </small>
        </article>
      </div>

      <div className="jpti-flow-insight">
        <b>
          {flow.count < 10 || flow.coverage < 0.7
            ? 'LOW FLOW CONFIDENCE'
            : flow.pressure >= 0.18
              ? 'BUY PRESSURE'
              : flow.pressure <= -0.18
                ? 'SELL PRESSURE'
                : 'BALANCED FLOW'}
        </b>
        <span>
          Venue-local trade evidence. Does not represent total market activity
          and cannot independently trigger a trade.
        </span>
      </div>

      {sweep && (
        <div className="jpti-flow-alert">
          <b>{sweep.label}</b>
          <span>
            {sweep.bias.toUpperCase()} watch · level {fmt(sweep.level)} · unconfirmed price action
          </span>
        </div>
      )}

      <section className="jpti-microstructure">
        <header><div><b>INSTITUTIONAL MICROSTRUCTURE · L2 DEPTH</b><small>{symbol} · Bitget top-five price levels · {book?.receivedAt ? new Date(book.receivedAt).toLocaleTimeString() : 'awaiting snapshot'}</small></div><span className={'jpti-flow-state ' + bookState}><i/> {bookState.toUpperCase()}</span></header>
        {depth.status === 'ready' ? <>
          <div className="jpti-micro-metrics">
            <article><small>BEST BID / ASK</small><b>{fmt(depth.bestBid)} / {fmt(depth.bestAsk)}</b></article>
            <article><small>SPREAD</small><b>{fmt(depth.spread)} · {fmt(depth.spreadBps)} bps</b></article>
            <article><small>BOOK IMBALANCE</small><b className={depth.imbalancePct >= 0 ? 'buy' : 'sell'}>{depth.imbalancePct > 0 ? '+' : ''}{depth.imbalancePct}%</b><small>{depth.imbalanceLabel}</small></article>
            <article><small>MICROPRICE PREMIUM</small><b>{depth.micropricePremiumBps > 0 ? '+' : ''}{fmt(depth.micropricePremiumBps)} bps</b></article>
            <article><small>BID / ASK NOTIONAL</small><b>{fmt(depth.bidNotional)} / {fmt(depth.askNotional)}</b><small>Top-five levels · quote currency</small></article>
            <article><small>DEPTH-ADJUSTED MID</small><b>{fmt(depth.microprice)}</b></article>
          </div>
          <div className="jpti-depth-columns">
            <div><b>BUY-SIDE DEPTH</b>{depth.bids.map((level,i)=><div key={'b'+i}><span>{fmt(level.price)}</span><i><em style={{width:(level.relative*100)+'%'}}/></i><strong>{fmt(level.notional)}</strong></div>)}</div>
            <div><b>SELL-SIDE DEPTH</b>{depth.asks.map((level,i)=><div key={'a'+i}><span>{fmt(level.price)}</span><i><em style={{width:(level.relative*100)+'%'}}/></i><strong>{fmt(level.notional)}</strong></div>)}</div>
          </div>
          <div className="jpti-depth-insight"><b>{depth.wall?.side ? depth.wall.side.toUpperCase()+' LIQUIDITY WALL' : 'NO DOMINANT WALL IN TOP FIVE LEVELS'}</b><span>{depth.wall ? fmt(depth.wall.price)+' · '+fmt(depth.wall.notional)+' quote notional · '+depth.wall.multiple.toFixed(2)+'× median level' : 'No level currently exceeds the wall threshold.'}</span></div>
          <p className="jpti-micro-note">Snapshot depth is venue-local, limited to five levels, and can be cancelled or spoofed. Imbalance and walls are descriptive, not proof of intent or executable liquidity.</p>
        </> : <p className="jpti-micro-note">{bookError || 'Waiting for a valid order-book snapshot. No depth-derived metrics are inferred from candles.'}</p>}
      </section>
      <footer>
        {error || 'Aggressor side from exchange prints. Unknown-side trades are excluded from directional delta. No trade signal without corroborating structure, risk, and higher-timeframe evidence.'}
      </footer>
    </section>
  );
}
