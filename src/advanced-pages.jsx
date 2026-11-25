import React, { lazy } from 'react';
import { LayoutGrid, BellRing, GitCompare, HeartPulse } from 'lucide-react';
import './advanced.css';

// New workspaces register here, so App.jsx only needs to know about this one module.
const COMPONENTS = {
  'Bitget Workbench': lazy(() => import('./BitgetWorkbench.jsx')),
  'Alerts': lazy(() => import('./AlertsCenter.jsx')),
  'Backtest Compare': lazy(() => import('./BacktestCompare.jsx')),
  'Bitget Health': lazy(() => import('./BitgetHealth.jsx'))
};

export const ADVANCED_NAV = [
  { label: 'Bitget Workbench', icon: LayoutGrid, group: 'MARKETS' },
  { label: 'Alerts', icon: BellRing, group: 'OPERATIONS' },
  { label: 'Backtest Compare', icon: GitCompare, group: 'RESEARCH' },
  { label: 'Bitget Health', icon: HeartPulse, group: 'SYSTEM' }
];

export const ADVANCED_DESCRIPTIONS = {
  'Bitget Workbench': 'Search every Bitget product, compare up to four charts side by side, save layouts, and size trades with funding, basis and liquidation-distance checks.',
  'Alerts': 'Price, level-touch and percent-move alerts across Bitget products, checked while this page is open.',
  'Backtest Compare': 'Run the same replay engine across Bitget Spot, Margin and futures to compare fees, slippage and assumed funding.',
  'Bitget Health': 'Live status of every Bitget product: catalogue, ticker and candle freshness.'
};

export const isAdvancedPage = (page) => Object.prototype.hasOwnProperty.call(COMPONENTS, page);
export function AdvancedWorkspace({ page }) {
  const Component = COMPONENTS[page];
  return Component ? <Component /> : null;
}
