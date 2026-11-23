import React, { useEffect, useMemo, useState } from 'react';
import {
  aggregateTrades,
  detectLiveSweep,
  normalizeTrade
} from './chart-intelligence/live-trade-flow.js';
import './LiveOrderFlowPanel.css';

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
  candles = []
}) {
  const [trades, setTrades] = useState([]);
  const [state, setState] = useState('connecting');
  const [error, setError] = useState('');
  const [clock, setClock] = useState(Date.now());

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
              instId: pair(symbol)
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
  }, [exchange, symbol, marketType]);

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

  const direction = flow.pressure > 0
    ? 'buy'
    : flow.pressure < 0
      ? 'sell'
      : 'neutral';

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

      <footer>
        {error || 'Aggressor side from exchange prints. Unknown-side trades are excluded from directional delta. No trade signal without corroborating structure, risk, and higher-timeframe evidence.'}
      </footer>
    </section>
  );
}
