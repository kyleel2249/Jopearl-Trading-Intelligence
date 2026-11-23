export const TRADING_SESSIONS = [
  { id: 'sydney', name: 'Sydney', timezone: 'Australia/Sydney', open: '08:00', close: '17:00', focus: 'AUD, NZD', color: 'violet' },
  { id: 'tokyo', name: 'Tokyo', timezone: 'Asia/Tokyo', open: '09:00', close: '18:00', focus: 'JPY, Asian range', color: 'blue' },
  { id: 'london', name: 'London', timezone: 'Europe/London', open: '08:00', close: '17:00', focus: 'EUR, GBP', color: 'cyan' },
  { id: 'new-york', name: 'New York', timezone: 'America/New_York', open: '08:00', close: '17:00', focus: 'USD, US indices, gold', color: 'amber' }
];

const formatterCache = new Map();
function partsAt(timestamp, timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    formatterCache.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
    dateKey: parts.year + '-' + parts.month + '-' + parts.day,
    time: parts.hour + ':' + parts.minute,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

function minutes(value) {
  const [hours, mins] = value.split(':').map(Number);
  return hours * 60 + mins;
}

export function getSessionSnapshot(timestamp = Date.now()) {
  const sessions = TRADING_SESSIONS.map(session => {
    const local = partsAt(timestamp, session.timezone);
    const openMinute = minutes(session.open);
    const closeMinute = minutes(session.close);
    const active = local.minuteOfDay >= openMinute && local.minuteOfDay < closeMinute;
    const elapsedMinutes = active ? local.minuteOfDay - openMinute : null;
    const remainingMinutes = active ? closeMinute - local.minuteOfDay : null;
    return {
      ...session, active, localTime: local.time, localDate: local.dateKey,
      elapsedMinutes, remainingMinutes,
      progressPercent: active ? Math.max(0, Math.min(100, elapsedMinutes / (closeMinute - openMinute) * 100)) : 0,
      phase: active ? 'open' : local.minuteOfDay < openMinute ? 'pre-open' : 'closed'
    };
  });
  const active = sessions.filter(session => session.active);
  return {
    timestamp: new Date(timestamp).toISOString(),
    sessions,
    activeSessionIds: active.map(session => session.id),
    activeSessionNames: active.map(session => session.name),
    overlap: active.length > 1,
    overlapName: active.length > 1 ? active.map(session => session.name).join(' + ') : null,
    londonNewYorkOverlap: active.some(session => session.id === 'london') && active.some(session => session.id === 'new-york'),
    killzones: sessions.filter(session => {
      if (!session.active) return false;
      const localMinute = minutes(session.localTime);
      return (session.id === 'london' || session.id === 'new-york')
        ? localMinute >= 8 * 60 && localMinute < 11 * 60
        : session.id === 'tokyo' && localMinute >= 9 * 60 && localMinute < 12 * 60;
    }).map(session => session.name)
  };
}

export function analyzeSessionCandles(candles = [], now = Date.now(), historyLimit = 20) {
  const valid = candles
    .filter(row => Array.isArray(row) && row.length >= 6 && row.slice(0, 6).every(value => Number.isFinite(Number(value))))
    .map(row => row.slice(0, 6).map(Number))
    .sort((a, b) => a[0] - b[0]);
  const grouped = new Map();

  for (const candle of valid) {
    for (const session of TRADING_SESSIONS) {
      const local = partsAt(candle[0], session.timezone);
      const minute = local.minuteOfDay;
      if (minute < minutes(session.open) || minute >= minutes(session.close)) continue;
      const key = session.id + '|' + local.dateKey;
      let bucket = grouped.get(key);
      if (!bucket) {
        bucket = { sessionId: session.id, date: local.dateKey, open: candle[1], high: candle[2], low: candle[3], close: candle[4], volume: 0, candles: 0, firstTimestamp: candle[0], lastTimestamp: candle[0] };
        grouped.set(key, bucket);
      }
      bucket.high = Math.max(bucket.high, candle[2]);
      bucket.low = Math.min(bucket.low, candle[3]);
      bucket.close = candle[4];
      bucket.volume += candle[5];
      bucket.candles += 1;
      bucket.lastTimestamp = candle[0];
    }
  }

  const snapshot = getSessionSnapshot(now);
  const todayBySession = {};
  const historyBySession = {};
  for (const session of TRADING_SESSIONS) {
    const buckets = [...grouped.values()].filter(bucket => bucket.sessionId === session.id).sort((a, b) => a.date.localeCompare(b.date));
    const today = buckets.find(bucket => bucket.date === snapshot.sessions.find(item => item.id === session.id).localDate) || null;
    const history = buckets.filter(bucket => bucket.date !== today?.date).slice(-historyLimit);
    const ranges = history.map(bucket => bucket.high - bucket.low).filter(Number.isFinite);
    const changes = history.map(bucket => bucket.open ? (bucket.close - bucket.open) / bucket.open * 100 : null).filter(Number.isFinite);
    todayBySession[session.id] = today ? {
      ...today,
      range: today.high - today.low,
      changePercent: today.open ? (today.close - today.open) / today.open * 100 : null
    } : null;
    historyBySession[session.id] = {
      observations: history.length,
      averageRange: ranges.length ? ranges.reduce((sum, value) => sum + value, 0) / ranges.length : null,
      averageAbsoluteChangePercent: changes.length ? changes.reduce((sum, value) => sum + Math.abs(value), 0) / changes.length : null,
      lastSessions: history.slice(-5).map(bucket => ({
        date: bucket.date, high: bucket.high, low: bucket.low, range: bucket.high - bucket.low,
        changePercent: bucket.open ? (bucket.close - bucket.open) / bucket.open * 100 : null,
        volume: bucket.volume, candles: bucket.candles
      }))
    };
  }
  return {
    candleCount: valid.length,
    latestCandleAt: valid.length ? new Date(valid[valid.length - 1][0]).toISOString() : null,
    today: todayBySession,
    history: historyBySession,
    methodology: 'Session statistics group exchange candle-open timestamps by each session’s IANA timezone and local trading date. Current-date session values are kept separate from prior-date averages; active cards identify sessions still in progress.'
  };
}

export function formatDuration(totalMinutes) {
  if (!Number.isFinite(totalMinutes) || totalMinutes < 0) return '—';
  const hours = Math.floor(totalMinutes / 60);
  const minutesLeft = totalMinutes % 60;
  return hours ? hours + 'h ' + minutesLeft + 'm' : minutesLeft + 'm';
}
