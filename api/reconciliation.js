const finite = value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;

function add(map, currency, amount) {
  if (!currency || !Number.isFinite(amount)) return;
  const key = String(currency).toUpperCase();
  map[key] = (map[key] || 0) + amount;
}

export function calculateBalanceReconciliation({ events = [], balances = {}, openingBalances = {} } = {}) {
  const totals = balances.total && typeof balances.total === 'object' ? balances.total : balances;
  const movements = {};
  const unresolved = {};
  const currencies = new Set(Object.keys(totals || {}).map(x => x.toUpperCase()));
  const opening = openingBalances && typeof openingBalances === 'object' ? openingBalances : {};
  for (const event of events) {
    if (event.kind !== 'ledger-transaction') continue;
    const currency = String(event.currency || '').toUpperCase();
    const qty = finite(event.quantity);
    const fee = finite(event.fee) ?? 0;
    const feeCurrency = String(event.feeCurrency || '').toUpperCase();
    if (event.eventType === 'fill') {
      const [base, quote] = String(event.symbol || '').toUpperCase().split('/');
      const price = finite(event.price);
      if (!base || !quote || !['buy', 'sell'].includes(event.side) || qty === null || price === null) {
        unresolved[event.accountId] = (unresolved[event.accountId] || 0) + 1;
        continue;
      }
      currencies.add(base); currencies.add(quote);
      const baseDelta = event.side === 'buy' ? qty : -qty;
      const quoteDelta = event.side === 'buy' ? -qty * price : qty * price;
      add(movements, base, baseDelta - (feeCurrency === base ? fee : 0));
      add(movements, quote, quoteDelta - (feeCurrency === quote ? fee : 0));
      if (fee > 0 && feeCurrency && feeCurrency !== base && feeCurrency !== quote) {
        currencies.add(feeCurrency); add(movements, feeCurrency, -fee);
      }
      continue;
    }
    if (['deposit', 'withdrawal'].includes(event.eventType) && currency && qty !== null) {
      currencies.add(currency);
      add(movements, currency, event.eventType === 'deposit' ? qty : -qty);
      if (fee > 0) add(movements, feeCurrency || currency, -fee);
      continue;
    }
    if (event.eventType === 'fee' && feeCurrency && fee > 0) {
      currencies.add(feeCurrency); add(movements, feeCurrency, -fee); continue;
    }
    if (['transfer', 'adjustment', 'funding', 'interest', 'borrow', 'rebate'].includes(event.eventType)) {
      const direction = String(event.metadata?.direction || '').toLowerCase();
      if (currency && qty !== null && ['in', 'credit', 'deposit', 'positive', 'out', 'debit', 'withdrawal', 'negative'].includes(direction)) {
        currencies.add(currency);
        add(movements, currency, ['in', 'credit', 'deposit', 'positive'].includes(direction) ? qty : -qty);
      } else unresolved[event.accountId] = (unresolved[event.accountId] || 0) + 1;
    }
  }
  for (const currency of Object.keys(opening)) currencies.add(currency.toUpperCase());
  const rows = [...currencies].sort().map(currency => {
    const actual = finite(totals?.[currency]);
    const baseline = finite(opening[currency]) ?? null;
    const delta = movements[currency] || 0;
    const impliedOpening = actual === null ? null : actual - delta;
    const expected = baseline === null ? null : baseline + delta;
    const difference = expected === null || actual === null ? null : actual - expected;
    const tolerance = Math.max(1e-8, Math.abs(actual ?? 0) * 1e-8);
    return { currency, actualTotal: actual, ledgerNetMovement: delta, openingBalance: baseline, impliedOpeningBalance: impliedOpening,
      expectedTotal: expected, difference, status: actual === null ? 'exchange_balance_missing' : expected === null ? 'baseline_missing' : Math.abs(difference) <= tolerance ? 'matched' : 'mismatch' };
  });
  const unresolvedCount = Object.values(unresolved).reduce((a, b) => a + b, 0);
  return { generatedAt: new Date().toISOString(), status: rows.some(x => x.status === 'mismatch') ? 'mismatch' : rows.some(x => x.status === 'exchange_balance_missing') ? 'exchange_balance_incomplete' : rows.some(x => x.status === 'baseline_missing') ? 'baseline_required' : 'matched',
    rows, unresolvedEventCount: unresolvedCount, unresolvedByAccount: unresolved,
    complete: unresolvedCount === 0 && rows.every(x => x.status === 'matched'),
    caveat: 'Reconciliation compares current exchange totals with configured opening balances plus supported ledger movements. Missing opening balances, unrecorded deposits/withdrawals/transfers, incomplete fill history, liability/derivative balances and third-currency conversions can prevent a complete account reconciliation. A missing baseline is reported as baseline_missing, never treated as a zero opening balance.' };
}
