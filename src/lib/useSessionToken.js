import { useEffect, useState } from 'react';
import { API_CONFIG_EVENT, getApiToken } from './api.js';

// Calls the listener whenever the session token or connection settings change.
export function useApiConfigChange(listener) {
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    window.addEventListener(API_CONFIG_EVENT, listener);
    return () => window.removeEventListener(API_CONFIG_EVENT, listener);
  }, [listener]);
}

const readSessionToken = (setToken) => () => setToken(getApiToken());

// State for a panel's token box: pre-filled with the session token, kept in step with it,
// and overridden only once the user types a different value into this panel.
export function useSessionToken() {
  const [sessionToken, setSessionToken] = useState(() => getApiToken());
  const [typed, setTyped] = useState(null);
  const [sync] = useState(() => readSessionToken(setSessionToken));
  useApiConfigChange(sync);
  return [typed ?? sessionToken, setTyped];
}
