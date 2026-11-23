const number = value => Number.isFinite(Number(value)) ? Number(value) : null;
const utcSession = date => {
  const hour = new Date(date).getUTCHours();
  if (hour < 8) return 'Asia (00:00–08:00 UTC)';
  if (hour < 13) return 'Europe (08:00–13:00 UTC)';
  if (hour < 21) return 'US (13:00–21:00 UTC)';
  return 'Late (21:00–24:00 UTC)';
};

export function calculateTradePerformance(events = []) {
  const ordered = [...events].filter(e => e?.eventType === 'fill')
    .sort((a,b) => Date.parse(a.occurredAt || 0) - Date.parse(b.occurredAt || 0));
  const books = new Map(), exits = [], warnings = new Set(), thirdCurrencyFees = [];
  let unmatchedSellExecutions = 0, unmatchedSellQuantity = 0;
  for (const event of ordered) {
    const [base, quote] = String(event.symbol || '').split('/');
    const qty = number(event.quantity), price = number(event.price), fee = number(event.fee ?? 0);
    if (!base || !quote || !['buy','sell'].includes(event.side) || qty == null || qty <= 0 || price == null || price <= 0 || fee == null || fee < 0) {
      warnings.add('Some fill records are missing a valid symbol, side, quantity, price or fee and were excluded.');
      continue;
    }
    const key = [event.accountId || 'unknown-account', event.source || 'unknown-source', event.symbol].join(':');
    const book = books.get(key) || { quantity: 0, averageCost: 0 };
    const feeCurrency = String(event.feeCurrency || quote).toUpperCase();
    if (fee > 0 && feeCurrency !== base && feeCurrency !== quote) thirdCurrencyFees.push({ occurredAt:event.occurredAt || null, exchange:event.source || 'unknown', symbol:event.symbol, currency:feeCurrency, amount:fee, side:event.side });
    if (event.side === 'buy') {
      const acquired = Math.max(0, qty - (feeCurrency === base ? fee : 0));
      const totalCost = qty * price + (feeCurrency === quote ? fee : 0);
      book.averageCost = (book.quantity * book.averageCost + totalCost) / Math.max(1e-12, book.quantity + acquired);
      book.quantity += acquired;
    } else {
      const disposed = qty + (feeCurrency === base ? fee : 0);
      const matched = Math.min(book.quantity, disposed);
      const unmatched = Math.max(0, disposed - matched);
      const proceeds = qty * price - (feeCurrency === quote ? fee : 0);
      const realized = matched > 0 ? proceeds * (matched / disposed) - book.averageCost * matched : null;
      if (unmatched > 1e-12) {
        unmatchedSellExecutions++;
        unmatchedSellQuantity += unmatched;
        warnings.add('Unmatched sell quantity exists; missing opening inventory or incomplete fill history prevents full cost-basis attribution.');
      }
      const strategy = String(event.metadata?.strategyId || event.metadata?.strategy || event.metadata?.botId || 'unattributed').slice(0,80);
      if (matched > 1e-12) exits.push({
        occurredAt: event.occurredAt || null, date: new Date(event.occurredAt || Date.now()).toISOString().slice(0,10),
        exchange: event.source || 'unknown', accountId: event.accountId || 'unknown', symbol: event.symbol, quote,
        matchedQuantity: matched, realizedPnl: realized, strategy,
        session: utcSession(event.occurredAt || Date.now()), unmatchedQuantity: unmatched,
        feeCurrency, thirdCurrencyFee: fee > 0 && feeCurrency !== quote && feeCurrency !== base ? fee : 0
      });
      book.quantity -= matched;
      if (book.quantity <= 1e-12) { book.quantity = 0; book.averageCost = 0; }
    }
    books.set(key, book);
  }

  const currencies = [...new Set(exits.map(x => x.quote))].sort();
  const byCurrency = currencies.map(currency => {
    const rows = exits.filter(x => x.quote === currency).sort((a,b) => Date.parse(a.occurredAt || 0) - Date.parse(b.occurredAt || 0));
    const wins = rows.filter(x => x.realizedPnl > 0), losses = rows.filter(x => x.realizedPnl < 0);
    const grossProfit = wins.reduce((s,x)=>s+x.realizedPnl,0);
    const grossLoss = Math.abs(losses.reduce((s,x)=>s+x.realizedPnl,0));
    let equity = 0, peak = 0, maxDrawdown = 0, currentLossStreak = 0, longestLossStreak = 0;
    const dailyMap = new Map();
    for (const row of rows) {
      equity += row.realizedPnl; peak = Math.max(peak,equity); maxDrawdown = Math.max(maxDrawdown,peak-equity);
      currentLossStreak = row.realizedPnl < 0 ? currentLossStreak + 1 : 0;
      longestLossStreak = Math.max(longestLossStreak,currentLossStreak);
      dailyMap.set(row.date,(dailyMap.get(row.date)||0)+row.realizedPnl);
    }
    return { quoteCurrency:currency, closedExitExecutions:rows.length, wins:wins.length, losses:losses.length,
      winRatePercent:rows.length?wins.length/rows.length*100:null, grossProfit, grossLoss,
      netRealizedPnl:rows.reduce((s,x)=>s+x.realizedPnl,0),
      profitFactor:grossLoss>0?grossProfit/grossLoss:null,
      expectancyPerExit:rows.length?rows.reduce((s,x)=>s+x.realizedPnl,0)/rows.length:null,
      averageWin:wins.length?grossProfit/wins.length:null, averageLoss:losses.length?-grossLoss/losses.length:null,
      maxDrawdownCurrency:maxDrawdown, currentLossStreak, longestLossStreak,
      recent20NetPnl:rows.slice(-20).reduce((s,x)=>s+x.realizedPnl,0), daily:[...dailyMap].map(([date,pnl])=>({date,pnl})).sort((a,b)=>a.date.localeCompare(b.date)),
      bestExit:rows.length?rows.reduce((a,b)=>a.realizedPnl>b.realizedPnl?a:b):null,
      worstExit:rows.length?rows.reduce((a,b)=>a.realizedPnl<b.realizedPnl?a:b):null };
  });
  const group = key => [...new Set(exits.map(x=>String(x[key])+'::'+x.quote))].map(groupKey => {
    const splitAt = groupKey.lastIndexOf('::');
    const value = groupKey.slice(0, splitAt), quoteCurrency = groupKey.slice(splitAt + 2);
    const rows=exits.filter(x=>String(x[key])===value && x.quote===quoteCurrency);
    const net=rows.reduce((s,x)=>s+x.realizedPnl,0);
    return { [key]:value, quoteCurrency, exits:rows.length, wins:rows.filter(x=>x.realizedPnl>0).length,
      losses:rows.filter(x=>x.realizedPnl<0).length, netRealizedPnl:net,
      averagePnl:rows.length?net/rows.length:null, quoteCurrencies:[...new Set(rows.map(x=>x.quote))] };
  }).sort((a,b)=>b.netRealizedPnl-a.netRealizedPnl);
  const analystInsights = [];
  for (const row of byCurrency) {
    if (row.closedExitExecutions < 20) analystInsights.push({severity:'info',title:'Small performance sample',quoteCurrency:row.quoteCurrency,evidence:row.closedExitExecutions+' matched exit executions; use caution interpreting win rate and expectancy.',review:'Collect a larger sample before treating the observed edge as stable.'});
    if (row.closedExitExecutions >= 5 && row.profitFactor != null && row.profitFactor < 1) analystInsights.push({severity:'warning',title:'Gross losses exceed gross profits',quoteCurrency:row.quoteCurrency,evidence:'Profit factor '+row.profitFactor.toFixed(2)+' across '+row.closedExitExecutions+' exits.',review:'Review the largest losing markets, strategies, fees and execution conditions.'});
    if (row.currentLossStreak >= 3) analystInsights.push({severity:'warning',title:'Consecutive realized losses',quoteCurrency:row.quoteCurrency,evidence:row.currentLossStreak+' consecutive losing exit executions.',review:'Review recent entries and enforce the configured risk policy before increasing exposure.'});
    if (row.recent20NetPnl < 0 && row.closedExitExecutions >= 20) analystInsights.push({severity:'warning',title:'Recent performance is negative',quoteCurrency:row.quoteCurrency,evidence:'The latest 20 matched exits sum to '+row.recent20NetPnl.toFixed(6)+' '+row.quoteCurrency+'.',review:'Compare recent market regime and strategy behavior with the prior sample.'});
  }
  if (unmatchedSellExecutions) analystInsights.push({severity:'warning',title:'Ledger inventory is incomplete',evidence:unmatchedSellExecutions+' sell execution(s) include '+unmatchedSellQuantity.toFixed(8)+' unmatched base quantity.',review:'Import older fills and verify opening inventory before relying on realized PnL.'});
  const unattributed = exits.filter(x=>x.strategy==='unattributed').length;
  if (unattributed) analystInsights.push({severity:'info',title:'Some exits lack strategy attribution',evidence:unattributed+' of '+exits.length+' matched exits are not tagged to a strategy or bot.',review:'Persist a stable strategyId or botId in fill metadata when recording executions.'});
  return { generatedAt:new Date().toISOString(), methodology:'Weighted-average cost per exchange/account/market. Each sell execution is one closed-exit observation; partial exits are not merged into synthetic round trips. Results are separated by quote currency.',
    fillCount:ordered.length, matchedExitCount:exits.length, unmatchedSellExecutions,
    byCurrency, byStrategy:group('strategy'), byMarket:group('symbol'), byExchange:group('exchange'), bySession:group('session'), analystInsights,
    recentExits:exits.slice(-100).reverse(), thirdCurrencyFees,
    dataQuality:{warnings:[...warnings],unmatchedSellQuantity,
      unattributedExits:unattributed,
      note:'Profit factor, expectancy and drawdown are calculated separately by quote currency. Do not add USD, USDT, BTC or other quote-currency values together without timestamp-aligned FX conversion.'},
    limitations:['This is ledger-derived realized trading performance, not total account return. It excludes open-position mark-to-market PnL.',
      'A sell is counted only for the quantity matched to recorded opening inventory. Unmatched quantities are disclosed, not assigned a guessed cost basis.',
      'Fees in a third currency are itemized but not converted into quote currency; funding, interest, borrow and other cash-flow events are not included in these fill-only exit statistics.',
      'Strategy attribution depends on metadata.strategyId, metadata.strategy, or metadata.botId being recorded at fill ingestion. Unlabeled fills appear as unattributed.',
      'Sessions are coarse UTC windows and are descriptive only; they are not exchange-specific trading calendars.'] };
}
