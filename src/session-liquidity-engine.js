import { TRADING_SESSIONS } from './session-intelligence.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

export function timeframeToMs(value = '1h') {
  const match = String(value).trim().match(/^(\d+)(m|h|d|w)$/i);
  if (!match) return HOUR;
  const amount = Number(match[1]);
  return amount * ({ m: 60_000, h: HOUR, d: DAY, w: 7 * DAY })[match[2].toLowerCase()];
}

function zonedParts(timestamp, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  return { date: parts.year + '-' + parts.month + '-' + parts.day, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

function sessionContains(timestamp, session) {
  const local = zonedParts(timestamp, session.timezone);
  const [openHour, openMinute] = session.open.split(':').map(Number);
  const [closeHour, closeMinute] = session.close.split(':').map(Number);
  const minute = local.minute;
  return minute >= openHour * 60 + openMinute && minute < closeHour * 60 + closeMinute;
}

function normalizeCandles(input = []) {
  return input.map(row => Array.isArray(row)
    ? row.slice(0, 6).map(Number)
    : [row?.timestamp, row?.open, row?.high, row?.low, row?.close, row?.volume].map(Number))
    .filter(row => row.length === 6 && row.every(Number.isFinite) && row[0] > 0
      && row[2] >= row[3] && row[1] > 0 && row[4] > 0)
    .sort((a, b) => a[0] - b[0]);
}

function findExtreme(candles, index, side, timeframeMs) {
  const row = candles[index];
  return { price: row[side === 'high' ? 2 : 3], timestamp: row[0], candleCloseAt: row[0] + timeframeMs };
}

function pctDistance(price, level) {
  return Number.isFinite(price) && Number.isFinite(level) && level !== 0
    ? ((price - level) / level) * 100 : null;
}

function nearestExtremeCandle(candles, level, side) {
  if (!Number.isFinite(level)) return null;
  const tolerance = Math.max(Math.abs(level) * 0.00025, 1e-10);
  let best = null;
  for (const candle of candles) {
    const value = candle[side === 'high' ? 2 : 3];
    if (Math.abs(value - level) <= tolerance && (!best || candle[0] > best.timestamp)) {
      best = { timestamp: candle[0], open: candle[1], high: candle[2], low: candle[3], close: candle[4] };
    }
  }
  return best;
}

function sessionAttribution(candles, level, side) {
  const match = nearestExtremeCandle(candles, level, side);
  if (!match) return { session: 'Unattributed', timestamp: null, confidence: 'unavailable' };
  const sessions = TRADING_SESSIONS.filter(item => sessionContains(match.timestamp, item));
  return {
    session: sessions.length ? sessions.map(item => item.name).join(' + ') : 'Outside configured sessions',
    timestamp: new Date(match.timestamp).toISOString(),
    confidence: sessions.length > 1 ? 'overlap-candle-match' : 'candle-match',
    note: 'Session attribution is inferred from the loaded OHLCV candle containing the exchange-reported extreme.'
  };
}

function sessionRanges(candles, start, end, timeframeMs) {
  return TRADING_SESSIONS.map(session => {
    const rows = candles.filter(row => row[0] < end && row[0] + timeframeMs > start && sessionContains(row[0], session));
    if (!rows.length) return { ...session, high: null, low: null, range: null, candles: 0, volume: 0, status: 'no-data' };
    const high = Math.max(...rows.map(row => row[2]));
    const low = Math.min(...rows.map(row => row[3]));
    return {
      ...session, high, low, range: high - low, candles: rows.length,
      volume: rows.reduce((sum, row) => sum + row[5], 0),
      changePercent: rows[0][1] ? ((rows.at(-1)[4] - rows[0][1]) / rows[0][1]) * 100 : null,
      highTimestamp: new Date(rows.find(row => row[2] === high)[0]).toISOString(),
      lowTimestamp: new Date(rows.find(row => row[3] === low)[0]).toISOString(),
      status: 'observed'
    };
  });
}

function previousUtcDay(candles, now) {
  const currentDay = Math.floor(now / DAY) * DAY;
  const rows = candles.filter(row => row[0] >= currentDay - DAY && row[0] < currentDay);
  if (!rows.length) return { high: null, low: null, status: 'insufficient-history' };
  const high = Math.max(...rows.map(row => row[2]));
  const low = Math.min(...rows.map(row => row[3]));
  return {
    high, low, status: 'observed',
    highTimestamp: new Date(rows.find(row => row[2] === high)[0]).toISOString(),
    lowTimestamp: new Date(rows.find(row => row[3] === low)[0]).toISOString()
  };
}

function detectLevelInteraction(candles, level, side, timeframeMs) {
  if (!Number.isFinite(level) || candles.length < 2) return { state: 'unavailable' };
  const recent = candles.slice(-Math.min(8, candles.length));
  const last = recent.at(-1);
  const touched = recent.find(row => side === 'high' ? row[2] > level : row[3] < level);
  if (!touched) return { state: 'untested' };
  const reclaimed = side === 'high' ? last[4] < level : last[4] > level;
  const latestCross = [...recent].reverse().find(row => side === 'high' ? row[2] > level : row[3] < level);
  if (reclaimed) return {
    state: 'sweep-and-reclaim',
    direction: side === 'high' ? 'bearish-rejection' : 'bullish-reclaim',
    touchedAt: new Date(latestCross[0]).toISOString(),
    confirmedAt: new Date(last[0]).toISOString(),
    barsSinceTouch: recent.length - 1 - recent.indexOf(latestCross)
  };
  return {
    state: 'breakout-or-acceptance',
    direction: side === 'high' ? 'bullish-acceptance' : 'bearish-acceptance',
    touchedAt: new Date(latestCross[0]).toISOString(),
    pending: last[0] + timeframeMs > Date.now()
  };
}

export function analyze24hLiquidity(candleInput = [], {
  now = Date.now(), timeframe = '1h', ticker = null, proximityPercent = 0.15
} = {}) {
  const candles = normalizeCandles(candleInput);
  const timeframeMs = timeframeToMs(timeframe);
  const start = now - DAY;
  const windowCandles = candles.filter(row => row[0] < now && row[0] + timeframeMs > start);
  const latest = windowCandles.at(-1) || candles.at(-1) || null;
  const candleHigh = windowCandles.length ? findExtreme(windowCandles, windowCandles.reduce((best, row, i, all) => row[2] > all[best][2] ? i : best, 0), 'high', timeframeMs) : null;
  const candleLow = windowCandles.length ? findExtreme(windowCandles, windowCandles.reduce((best, row, i, all) => row[3] < all[best][3] ? i : best, 0), 'low', timeframeMs) : null;

  const tickerHigh = Number(ticker?.high);
  const tickerLow = Number(ticker?.low);
  const high = Number.isFinite(tickerHigh) && tickerHigh > 0 ? tickerHigh : candleHigh?.price ?? null;
  const low = Number.isFinite(tickerLow) && tickerLow > 0 ? tickerLow : candleLow?.price ?? null;
  const last = Number(ticker?.last) > 0 ? Number(ticker.last) : latest?.[4] ?? null;
  const highSource = Number.isFinite(tickerHigh) && tickerHigh > 0 ? 'exchange-24h-ticker' : 'loaded-ohlcv-window';
  const lowSource = Number.isFinite(tickerLow) && tickerLow > 0 ? 'exchange-24h-ticker' : 'loaded-ohlcv-window';
  const range = high != null && low != null ? high - low : null;
  const rangePercent = range != null && low > 0 ? range / low * 100 : null;
  const rangePosition = range > 0 && last != null ? clamp((last - low) / range * 100, 0, 100) : null;
  const change24h = ticker?.percentage != null && Number.isFinite(Number(ticker.percentage)) ? Number(ticker.percentage)
    : Number.isFinite(Number(ticker?.open)) && Number(ticker.open) > 0 && last != null
      ? (last - Number(ticker.open)) / Number(ticker.open) * 100 : null;

  const precedingWindow = windowCandles.slice(0, -1);
  const priorWindowHigh = precedingWindow.length ? Math.max(...precedingWindow.map(row => row[2])) : null;
  const priorWindowLow = precedingWindow.length ? Math.min(...precedingWindow.map(row => row[3])) : null;
  const highInteraction = detectLevelInteraction(windowCandles, priorWindowHigh, 'high', timeframeMs);
  const lowInteraction = detectLevelInteraction(windowCandles, priorWindowLow, 'low', timeframeMs);
  highInteraction.referenceLevel = priorWindowHigh;
  lowInteraction.referenceLevel = priorWindowLow;
  const previousDay = previousUtcDay(candles, now);
  const sessions = sessionRanges(windowCandles, start, now, timeframeMs);
  const ranges = windowCandles.map(row => row[2] - row[3]).filter(value => value > 0);
  const averageCandleRange = mean(ranges.slice(-24));
  const latestRange = latest ? latest[2] - latest[3] : null;
  const rangeMultiple = averageCandleRange && latestRange != null ? latestRange / averageCandleRange : null;
  const volumes = windowCandles.map(row => row[5]).filter(value => value >= 0);
  const baselineVolume = mean(volumes.slice(-24, -3));
  const recentVolume = mean(volumes.slice(-3));
  const volumeMultiple = baselineVolume > 0 && recentVolume != null ? recentVolume / baselineVolume : null;

  const highNear = high != null && last != null && Math.abs(pctDistance(last, high)) <= proximityPercent;
  const lowNear = low != null && last != null && Math.abs(pctDistance(last, low)) <= proximityPercent;
  const nearest = highNear ? '24h-high' : lowNear ? '24h-low'
    : high != null && low != null && last != null
      ? (Math.abs(last - high) < Math.abs(last - low) ? '24h-high' : '24h-low') : null;
  const bias = rangePosition == null ? 'unavailable'
    : rangePosition >= 70 ? 'upper-range'
      : rangePosition <= 30 ? 'lower-range' : 'mid-range';
  const alerts = [];
  if (highInteraction.state === 'sweep-and-reclaim') alerts.push({ severity: 'watch', code: 'HIGH_SWEEP_RECLAIM', message: 'Price traded above the 24-hour high and returned below it; watch for bearish follow-through.' });
  if (lowInteraction.state === 'sweep-and-reclaim') alerts.push({ severity: 'watch', code: 'LOW_SWEEP_RECLAIM', message: 'Price traded below the 24-hour low and reclaimed it; watch for bullish follow-through.' });
  if (rangeMultiple != null && rangeMultiple >= 2) alerts.push({ severity: 'caution', code: 'RANGE_EXPANSION', message: 'The latest candle range is at least 2× the recent average.' });
  if (volumeMultiple != null && volumeMultiple >= 2) alerts.push({ severity: 'info', code: 'VOLUME_EXPANSION', message: 'Recent three-candle volume is at least 2× the preceding baseline.' });
  if (highNear) alerts.push({ severity: 'info', code: 'NEAR_24H_HIGH', message: 'Price is within the configured proximity threshold of the 24-hour high.' });
  if (lowNear) alerts.push({ severity: 'info', code: 'NEAR_24H_LOW', message: 'Price is within the configured proximity threshold of the 24-hour low.' });

  return {
    status: latest && high != null && low != null ? 'ready' : 'insufficient',
    asOf: new Date(now).toISOString(), windowStart: new Date(start).toISOString(),
    timeframe, candleCount: windowCandles.length, last,
    levels: {
      high: { price: high, source: highSource, ...sessionAttribution(windowCandles, high, 'high'), interaction: highInteraction },
      low: { price: low, source: lowSource, ...sessionAttribution(windowCandles, low, 'low'), interaction: lowInteraction },
      previousUtcDay: previousDay
    },
    range: { absolute: range, percent: rangePercent, positionPercent: rangePosition, location: bias },
    proximity: { thresholdPercent: proximityPercent, nearest, nearHigh: highNear, nearLow: lowNear,
      distanceToHighPercent: pctDistance(last, high), distanceToLowPercent: pctDistance(last, low) },
    sessions,
    volatility: { averageCandleRange, latestCandleRange: latestRange, latestRangeMultiple: rangeMultiple,
      recentVolumeAverage: recentVolume, baselineVolumeAverage: baselineVolume, volumeMultiple },
    change24h,
    alerts,
    methodology: 'The exchange ticker is authoritative for the rolling 24-hour high/low when available. Candle-derived levels are a fallback over bars intersecting the rolling window. Session attribution is inferred only when a loaded candle matches the reported extreme; otherwise it is explicitly unattributed. Previous-day levels use UTC boundaries.'
  };
}


const medianValue = values => { const a=values.filter(Number.isFinite).sort((x,y)=>x-y); if(!a.length)return null; const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; };
const percentileValue = (values,p) => { const a=values.filter(Number.isFinite).sort((x,y)=>x-y); return a.length?a[Math.min(a.length-1,Math.max(0,Math.ceil(p*a.length)-1))]:null; };

/**
 * Session-specific forecast bands for the next/current session in the rolling 24h cycle.
 * Historical session ranges are measured from timestamped candles; projected levels are estimates, never guaranteed highs/lows.
 */
export function predictSessionHighLow(candleInput=[],{now=Date.now(),timeframe='1h',chainDex=null,maxHistory=20}={}){
 const candles=normalizeCandles(candleInput);
 if(candles.length<24)return{status:'insufficient',generatedAt:new Date(now).toISOString(),sessions:[],reason:'At least 24 valid candles are required for session forecasts'};
 const grouped=new Map();
 for(const row of candles){for(const session of TRADING_SESSIONS){const local=zonedParts(row[0],session.timezone);const [oh,om]=session.open.split(':').map(Number),[ch,cm]=session.close.split(':').map(Number);if(local.minute<oh*60+om||local.minute>=ch*60+cm)continue;const key=session.id+'|'+local.date;let b=grouped.get(key);if(!b){b={sessionId:session.id,date:local.date,open:row[1],high:row[2],low:row[3],close:row[4],volume:0,candles:0};grouped.set(key,b);}b.high=Math.max(b.high,row[2]);b.low=Math.min(b.low,row[3]);b.close=row[4];b.volume+=row[5];b.candles++;}}
 const latest=candles.at(-1),price=latest[4],ranges=candles.slice(-24).map(c=>c[2]-c[3]).filter(x=>x>0),longRanges=candles.slice(-Math.min(160,candles.length)).map(c=>c[2]-c[3]).filter(x=>x>0),volScale=clamp((medianValue(ranges)||1)/(medianValue(longRanges)||1),0.7,1.5);
 const momentumBase=candles[Math.max(0,candles.length-7)][4],momentum=momentumBase?(price-momentumBase)/momentumBase:0;
 const flowPct=Number(chainDex?.flow?.imbalancePct),flowBias=Number.isFinite(flowPct)?clamp(flowPct/100,-1,1):0;
 const directionalBias=clamp(momentum*120+flowBias*0.18,-1,1);
 const snapshot=TRADING_SESSIONS.map(session=>{
  const local=zonedParts(now,session.timezone),[oh,om]=session.open.split(':').map(Number),[ch,cm]=session.close.split(':').map(Number),open=oh*60+om,close=ch*60+cm,minute=local.minute;
  const active=minute>=open&&minute<close,preOpen=minute<open,remaining=active?close-minute:preOpen?close-open:close-open;
  const history=[...grouped.values()].filter(x=>x.sessionId===session.id&&x.date!==local.date&&x.high>x.low).slice(-maxHistory);
  const histRanges=history.map(x=>x.high-x.low),medianRange=medianValue(histRanges),p80Range=percentileValue(histRanges,.8);
  const current=grouped.get(session.id+'|'+local.date)||null;
  const baseline=p80Range??medianRange;
  const expectedRange=baseline==null?null:baseline*volScale;
  const remainingFactor=active?Math.sqrt(clamp(remaining/(close-open),0.05,1)):1;
  const projectedRange=expectedRange==null?null:expectedRange*remainingFactor;
  const skew=projectedRange==null?0:directionalBias*projectedRange*0.12;
  const observedHigh=active&&current?current.high:null,observedLow=active&&current?current.low:null;
  const forecastHigh=projectedRange==null?null:Math.max(observedHigh??-Infinity,price+projectedRange*0.55+skew);
  const forecastLow=projectedRange==null?null:Math.min(observedLow??Infinity,price-projectedRange*0.55+skew);
  const confidence=history.length>=12?'high':history.length>=6?'moderate':history.length>=3?'low':'very-low';
  return{id:session.id,name:session.name,timezone:session.timezone,phase:active?'active':preOpen?'upcoming':'next-cycle',localDate:local.date,localTime:Math.floor(minute/60).toString().padStart(2,'0')+':'+(minute%60).toString().padStart(2,'0'),historySamples:history.length,confidence,observed:{high:observedHigh,low:observedLow},forecast:{high:forecastHigh==null?null:Number(forecastHigh.toFixed(8)),low:forecastLow==null?null:Number(forecastLow.toFixed(8)),expectedRange:expectedRange==null?null:Number(expectedRange.toFixed(8)),projectedRemainingRange:projectedRange==null?null:Number(projectedRange.toFixed(8))},directionalBias:Number(directionalBias.toFixed(3)),volatilityScale:Number(volScale.toFixed(3)),method:'historical session 80th-percentile range × current volatility scale, adjusted for remaining session time and bounded directional skew'};
 });
 return{status:snapshot.some(s=>s.forecast.high!==null)?'ready':'insufficient',generatedAt:new Date(now).toISOString(),symbol:null,timeframe,referencePrice:price,directionalBias:Number(directionalBias.toFixed(3)),flowBias:Number(flowBias.toFixed(3)),sessions:snapshot,methodology:'Session highs/lows are forecast bands from historical session ranges and current volatility. Current observed extremes are never replaced. Forecasts are estimates with sample-count confidence, not guaranteed levels.'};
}
