import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import Chart from '../../src/LiveCandlestickChart.jsx';
import ExchangeConnectivity from '../../src/ExchangeConnectivity.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const PRODUCTS = ['margin', 'coin-futures', 'usdc-futures', 'futures', 'spot', 'futures'];
const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
const settle = async (ms = 20, rounds = 4) => { for (let i = 0; i < rounds; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };

async function exercise(name, element) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const select = () => host.querySelector('select[aria-label="Market type"]');
  await act(async () => { root.render(element); });
  await settle();
  const result = { name, start: select().value, picks: [] };
  for (const product of PRODUCTS) {
    await act(async () => { setValue.call(select(), product); select().dispatchEvent(new window.Event('change', { bubbles: true })); });
    await settle();
    result.picks.push([product, select().value]);
  }
  root.unmount();
  return result;
}

export async function run() {
  const notices = [];
  const original = console.error;
  console.error = (...args) => { notices.push(String(args[0]).slice(0, 120)); };
  const results = [];
  results.push(await exercise('standalone chart pinned to futures', <Chart exchange="bitget" symbol="BTC/USDT" initialMarketType="futures" />));
  const Tracking = () => {
    const [product, setProduct] = useState('futures');
    return <Chart exchange="bitget" symbol="BTC/USDT" initialMarketType={product} onMarketTypeChange={setProduct} />;
  };
  results.push(await exercise('chart under a parent that tracks the product', <Tracking />));
  results.push(await exercise('Futures page (ExchangeConnectivity)', <ExchangeConnectivity symbol="BTC/USDT" initialExchange="bitget" initialMarketType="futures" />));
  console.error = original;
  return { results, notices };
}
