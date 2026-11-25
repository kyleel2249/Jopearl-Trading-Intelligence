// Price, level-touch and percent-move alerts. Pure evaluation so crossing and cooldown rules are
// testable. Alerts are evaluated by the page while it is open; there is no server-side scheduler,
// so a closed tab raises nothing.
export const ALERT_TYPES = ['price_above', 'price_below', 'level_touch', 'pct_move'];
export const MAX_ALERTS = 50;
export const STORAGE_KEY = 'jpti.alerts.v1';
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
export const quoteKey = ({ exchange = 'bitget', product = 'spot', symbol }) => [exchange, product, String(symbol || '').toUpperCase()].join('|');

export function createAlert(raw, currentPrice, now = Date.now(), id = 'a' + now.toString(36) + Math.random().toString(36).slice(2, 6)) {
  const type = ALERT_TYPES.includes(raw?.type) ? raw.type : null;
  if (!type) return { error: 'Choose an alert type.' };
  const symbol = String(raw?.symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9._-]{1,20}(\/[A-Z0-9._-]{1,20}(:[A-Z0-9._-]{1,20})?)?$/.test(symbol)) return { error: 'Enter a valid symbol.' };
  const value = num(raw?.value);
  if (value === null || value <= 0) return { error: type === 'pct_move' ? 'Enter a percent move above 0.' : 'Enter a price above 0.' };
  const price = num(currentPrice);
  if (type === 'pct_move' && price === null) return { error: 'A current price is needed to set the percent-move baseline.' };
  const cooldownMinutes = Math.max(0, Math.min(1440, Math.round(num(raw?.cooldownMinutes) ?? 0)));
  return {
    alert: {
      id, type, exchange: String(raw?.exchange || 'bitget'), product: String(raw?.product || 'spot'), symbol, value,
      direction: ['up', 'down', 'either'].includes(raw?.direction) ? raw.direction : 'either',
      tolerancePercent: Math.max(0, Math.min(5, num(raw?.tolerancePercent) ?? 0.1)),
      repeat: Boolean(raw?.repeat), cooldownMinutes, enabled: true,
      instrumentId: String(raw?.instrumentId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40),
      baseline: type === 'pct_move' ? price : null, lastPrice: price, createdAt: now, lastTriggeredAt: null, triggerCount: 0,
      note: String(raw?.note || '').slice(0, 80)
    }
  };
}

function fires(alert, price) {
  const last = alert.lastPrice;
  switch (alert.type) {
    case 'price_above': return price >= alert.value && (last === null || last < alert.value);
    case 'price_below': return price <= alert.value && (last === null || last > alert.value);
    case 'level_touch': {
      const near = Math.abs(price - alert.value) / alert.value * 100 <= alert.tolerancePercent;
      const crossed = last !== null && (last - alert.value) * (price - alert.value) < 0;
      return near || crossed;
    }
    case 'pct_move': {
      if (!(alert.baseline > 0)) return false;
      const move = (price / alert.baseline - 1) * 100;
      return alert.direction === 'up' ? move >= alert.value : alert.direction === 'down' ? move <= -alert.value : Math.abs(move) >= alert.value;
    }
    default: return false;
  }
}

export function describeAlert(alert) {
  const where = alert.symbol + ' (' + alert.product + ')';
  if (alert.type === 'price_above') return where + ' crossed above ' + alert.value;
  if (alert.type === 'price_below') return where + ' crossed below ' + alert.value;
  if (alert.type === 'level_touch') return where + ' touched ' + alert.value;
  return where + ' moved ' + alert.value + '% (' + alert.direction + ') from ' + alert.baseline;
}

export function evaluateAlerts(alerts, quotes, now = Date.now()) {
  const triggered = [];
  const next = alerts.map((alert) => {
    const price = num(quotes[quoteKey(alert)]);
    if (price === null) return alert;
    let updated = { ...alert, lastPrice: price };
    if (!alert.enabled) return updated;
    const cooling = alert.lastTriggeredAt !== null && now - alert.lastTriggeredAt < alert.cooldownMinutes * 60000;
    if (!cooling && fires(alert, price)) {
      triggered.push({ alertId: alert.id, price, at: now, message: describeAlert(alert) + ' at ' + price, alert });
      updated = { ...updated, lastTriggeredAt: now, triggerCount: alert.triggerCount + 1, enabled: alert.repeat, baseline: alert.type === 'pct_move' && alert.repeat ? price : alert.baseline };
    }
    return updated;
  });
  return { alerts: next, triggered };
}

export function sanitizeAlerts(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw.slice(0, MAX_ALERTS)) {
    const probe = createAlert(item, num(item?.lastPrice) ?? num(item?.baseline) ?? 1, num(item?.createdAt) ?? 0, String(item?.id || ''));
    if (!probe.alert || !/^[a-z0-9_-]{1,32}$/i.test(probe.alert.id) || seen.has(probe.alert.id)) continue;
    seen.add(probe.alert.id);
    out.push({ ...probe.alert, enabled: item.enabled !== false, baseline: probe.alert.type === 'pct_move' ? (num(item.baseline) ?? probe.alert.baseline) : null, lastPrice: num(item.lastPrice), lastTriggeredAt: num(item.lastTriggeredAt), triggerCount: Math.max(0, Math.round(num(item.triggerCount) ?? 0)), createdAt: num(item.createdAt) ?? 0 });
  }
  return out;
}
export const parseAlerts = (text) => { try { return sanitizeAlerts(JSON.parse(String(text))); } catch { return []; } };
export const serializeAlerts = (alerts) => JSON.stringify(alerts);
