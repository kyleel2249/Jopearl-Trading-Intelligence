export { default as DashboardApp } from './DashboardApp.jsx';
export { analyzeSignal, ema, rsi, atr, timeframeMs } from './engines/signal-engine.js';
export { classifyMarketRegime, detectSignalCollisions, rankOpportunities } from './engines/advanced-intelligence.js';
export { useSignalIntelligence } from './hooks/useSignalIntelligence.js';
