export function detectSmartMoney(candles, swingLength = 3) {
  const fairValueGaps = [], liquiditySweeps = [], structureBreaks = [], orderBlocks = [];
  let lastHigh = null, lastLow = null, trend = 0;
  const swingHighs = [], swingLows = [];
  for (let i = 0; i < candles.length; i += 1) {
    if (i >= swingLength * 2) {
      const pivot = i - swingLength;
      const sample = candles.slice(pivot - swingLength, pivot + swingLength + 1);
      if (sample.every((c,j) => j === swingLength || candles[pivot][2] > c[2])) {
        lastHigh = { index: pivot, price: candles[pivot][2], broken: false, swept: false };
        swingHighs.push(lastHigh);
      }
      if (sample.every((c,j) => j === swingLength || candles[pivot][3] < c[3])) {
        lastLow = { index: pivot, price: candles[pivot][3], broken: false, swept: false };
        swingLows.push(lastLow);
      }
    }
    const c = candles[i], previous = candles[i-1];
    if (i >= 2) {
      const two = candles[i-2];
      if (c[3] > two[2]) fairValueGaps.push({ direction:'bullish', start:i-2, end:i, top:c[3], bottom:two[2] });
      if (c[2] < two[3]) fairValueGaps.push({ direction:'bearish', start:i-2, end:i, top:two[3], bottom:c[2] });
    }
    if (lastHigh && !lastHigh.broken && !lastHigh.swept && c[2] > lastHigh.price && c[4] < lastHigh.price) { liquiditySweeps.push({ direction:'buy-side', index:i, level:lastHigh.price }); lastHigh.swept = true; }
    if (lastLow && !lastLow.broken && !lastLow.swept && c[3] < lastLow.price && c[4] > lastLow.price) { liquiditySweeps.push({ direction:'sell-side', index:i, level:lastLow.price }); lastLow.swept = true; }
    if (lastHigh && !lastHigh.broken && c[4] > lastHigh.price && previous && previous[4] <= lastHigh.price) {
      const kind = trend < 0 ? 'CHoCH' : 'BOS';
      structureBreaks.push({ direction:'bullish', kind, index:i, level:lastHigh.price });
      lastHigh.broken = true; trend = 1;
      for (let j=i-1; j>=Math.max(0,i-12); j-=1) if (candles[j][4] < candles[j][1]) {
        orderBlocks.push({ direction:'bullish', start:j, end:i, top:candles[j][2], bottom:candles[j][3] }); break;
      }
    }
    if (lastLow && !lastLow.broken && c[4] < lastLow.price && previous && previous[4] >= lastLow.price) {
      const kind = trend > 0 ? 'CHoCH' : 'BOS';
      structureBreaks.push({ direction:'bearish', kind, index:i, level:lastLow.price });
      lastLow.broken = true; trend = -1;
      for (let j=i-1; j>=Math.max(0,i-12); j-=1) if (candles[j][4] > candles[j][1]) {
        orderBlocks.push({ direction:'bearish', start:j, end:i, top:candles[j][2], bottom:candles[j][3] }); break;
      }
    }
  }
  fairValueGaps.forEach((gap) => {
    for (let j = gap.end + 1; j < candles.length; j += 1) {
      const candle = candles[j];
      if ((gap.direction === 'bullish' && candle[3] <= gap.bottom) || (gap.direction === 'bearish' && candle[2] >= gap.top)) { gap.mitigatedAt = j; break; }
    }
    gap.end = gap.mitigatedAt ?? candles.length - 1;
  });
  orderBlocks.forEach((zone) => {
    for (let j = zone.end + 1; j < candles.length; j += 1) {
      const close = candles[j][4];
      if ((zone.direction === 'bullish' && close < zone.bottom) || (zone.direction === 'bearish' && close > zone.top)) { zone.mitigatedAt = j; break; }
    }
    zone.end = zone.mitigatedAt ?? candles.length - 1;
  });
  return { fairValueGaps:fairValueGaps.slice(-30), liquiditySweeps:liquiditySweeps.slice(-20), structureBreaks:structureBreaks.slice(-20), orderBlocks:orderBlocks.slice(-20), swingHighs:swingHighs.slice(-12), swingLows:swingLows.slice(-12) };
}

