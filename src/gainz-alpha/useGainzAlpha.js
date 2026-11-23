import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getHub } from './hub.js';
import { createApiRemote } from './remote.js';
import { apiFetch } from '../lib/api.js';

let remoteAttached = false;

let chartSeq = 0;

/**
 * Shared chart-intelligence hook. Every live candlestick chart calls this with its own
 * exchange/symbol/timeframe/candles; the hub runs the engine once per context and shares results.
 */
export function useGainzAlpha({ exchange, symbol, timeframe, candles, higherTimeframes }) {
  const hub = getHub();
  const idRef = useRef(null);
  if (idRef.current === null) idRef.current = 'chart-' + (++chartSeq);
  const [settings, setSettings] = useState(() => hub.getSettings());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (remoteAttached) return;
    remoteAttached = true;
    hub.attachRemote(createApiRemote(apiFetch));
  }, [hub]);

  useEffect(() => hub.onSettingsChange((next) => setSettings({ ...next })), [hub]);

  useEffect(() => {
    const id = idRef.current;
    const unsubscribe = hub.subscribe(id, [exchange, symbol, timeframe].join('|'), () => setTick((t) => t + 1));
    return () => { unsubscribe(); hub.release(id); };
  }, [hub, exchange, symbol, timeframe]);

  const result = useMemo(() => {
    if (!settings.enabled || !symbol || !timeframe || !candles || !candles.length) return null;
    try {
      return hub.ingest({ chartId: idRef.current, exchange, symbol, timeframe, candles, higherTimeframes });
    } catch (error) {
      return { error: error.message };
    }
  }, [hub, exchange, symbol, timeframe, candles, higherTimeframes, settings, tick]);

  const update = useCallback((patch) => setSettings({ ...hub.updateSettings(patch) }), [hub]);
  const reset = useCallback(() => setSettings({ ...hub.resetSettings() }), [hub]);
  const diagnose = useCallback((env) => hub.diagnose(result, env), [hub, result]);

  return { hub, chartId: idRef.current, result, settings, update, reset, diagnose };
}
