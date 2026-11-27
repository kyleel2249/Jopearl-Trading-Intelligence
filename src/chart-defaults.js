export const DEFAULT_CHART_EXCHANGE = 'bitget';
export const DEFAULT_CHART_SYMBOL = 'BTC/USDT';

/**
 * Migrate only the previous built-in Binance/EUR default. Other saved markets
 * are user choices and must remain untouched.
 */
export function resolveSavedChartMarket(savedExchange, savedSymbol) {
  const hasSavedMarket = Boolean(savedExchange || savedSymbol);
  const isLegacyDefault = !hasSavedMarket || (savedExchange === 'binance' && savedSymbol === 'EUR/USDT');
  return {
    exchange: isLegacyDefault ? DEFAULT_CHART_EXCHANGE : (savedExchange || DEFAULT_CHART_EXCHANGE),
    symbol: isLegacyDefault ? DEFAULT_CHART_SYMBOL : (savedSymbol || DEFAULT_CHART_SYMBOL),
    migrated: isLegacyDefault
  };
}
