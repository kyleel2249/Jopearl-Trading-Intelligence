import React, { useEffect, useMemo, useRef, useState } from 'react';
import './ConnectionSettings.css';
import { apiFetch, getApiBaseUrl, getApiToken, setApiToken } from './lib/api.js';
import { describeTokenCheck } from './lib/token-check.js';

const VAULT_KEY = 'jpti.connectionVault.v1';
const PROFILE_KEY = 'jpti.connectionProfile.v2';
const loadProfile = () => { try { const data = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null'); return data && typeof data === 'object' ? data : {}; } catch { return {}; } };
const SECRET_PATTERN = /(KEY|SECRET|PASSWORD|TOKEN|DATABASE_URL|PRIVATE|CREDENTIAL|AUTH)/i;
const parseEnv = (source) => {
  const values = {};
  for (const raw of String(source || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    values[match[1]] = value;
  }
  return values;
};
const groupFor = (key) => {
  if (/^(VITE_|JPTI_APP_|JPTI_API_|JPTI_CORS_|JPTI_ALLOW_)/.test(key) || key === 'PORT' || key === 'DATABASE_URL') return 'Core & API';
  if (/EXCHANGE|BINANCE|BYBIT|OKX|KUCOIN|KRAKEN|COINBASE|BITGET|GATEIO|MEXC|HTX/.test(key)) return 'Exchange connections';
  if (/FRED|ALCHEMY|HELIUS|ALPACA|QUIVER|FINNHUB|ALPHA|TWELVE|INFURA|LIQUID/.test(key)) return 'Market & data providers';
  if (/STORAGE|DATABASE|DATA_DIR|POOL|SSL/.test(key)) return 'Database & persistence';
  if (/SCHEDULER|INTERVAL|REFRESH|CACHE|STALE|TIMEOUT|MONITOR|STREAM/.test(key)) return 'Automation & polling';
  if (/TBOTS|GOVERNANCE|FUTURES|LIVE_TRADING|TRADING_MODE|ORDER|RISK|LOSS|RECONCILE|QUOTE/.test(key)) return 'Trading, risk & T-Bots';
  return 'Other settings';
};
async function deriveKey(passphrase, salt) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptVault(data, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(data)));
  const to64 = (bytes) => btoa(String.fromCharCode(...bytes));
  return { version: 1, kdf: 'PBKDF2-SHA256', iterations: 310000, cipher: 'AES-256-GCM', salt: to64(salt), iv: to64(iv), data: to64(new Uint8Array(encrypted)), updatedAt: new Date().toISOString() };
}
async function decryptVault(payload, passphrase) {
  const from64 = (value) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
  const key = await deriveKey(passphrase, from64(payload.salt));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: from64(payload.iv) }, key, from64(payload.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

export default function ConnectionSettings() {
  const initialProfile = loadProfile();
  const [url, setUrl] = useState(typeof window !== 'undefined' ? window.location.origin : getApiBaseUrl());
  const [savedUrl, setSavedUrl] = useState(typeof window !== 'undefined' ? window.location.origin : getApiBaseUrl());
  const [token, setToken] = useState(() => getApiToken());
  const [savedToken, setSavedToken] = useState('');
  const [apiStatus, setApiStatus] = useState(null);
  const [apiBusy, setApiBusy] = useState(false);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenCheck, setTokenCheck] = useState(null);
  const [serverMessage, setServerMessage] = useState('');
  const [apiError, setApiError] = useState('');
  const [variables, setVariables] = useState(initialProfile.variables || {});
  const [revealed, setRevealed] = useState({});
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [vaultExists, setVaultExists] = useState(() => Boolean(localStorage.getItem(VAULT_KEY)));
  const [vaultUnlocked, setVaultUnlocked] = useState(false);
  const [vaultMessage, setVaultMessage] = useState('');
  const [vaultError, setVaultError] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const fileRef = useRef(null);
  const groups = useMemo(() => {
    const grouped = {};
    Object.entries(variables).sort(([a], [b]) => a.localeCompare(b)).forEach(([key, value]) => {
      const group = groupFor(key);
      if (!grouped[group]) grouped[group] = [];
      grouped[group].push([key, value]);
    });
    return grouped;
  }, [variables]);
  const count = Object.keys(variables).length;
  const secretCount = Object.keys(variables).filter(key => SECRET_PATTERN.test(key)).length;
  useEffect(() => { try { localStorage.setItem(PROFILE_KEY, JSON.stringify({ variables, apiBaseUrl: url, apiToken: '', savedAt: new Date().toISOString() })); } catch { setVaultError('Auto-save failed: device storage is full or unavailable.'); } }, [variables, url]);

  const importText = async (text) => {
    const parsed = parseEnv(text);
    if (!Object.keys(parsed).length) throw new Error('No KEY=value entries were found in that file.');
    setVariables(current => ({ ...current, ...parsed }));
    const importedToken = parsed.JPTI_JOURNAL_TOKEN || parsed.JPTI_API_TOKEN || '';
    if (importedToken) setToken(importedToken);
    // Imported variables are retained in the encrypted device profile only; they are not pushed to a server.
    setVaultUnlocked(true);
    setVaultMessage('Imported and auto-saved ' + Object.keys(parsed).length + ' variables on this device.');
    setVaultError('');
  };
  const addVariable = () => {
    const key = window.prompt('Variable name (for example JPTI_PROVIDER_API_KEY)');
    if (!key) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key.trim())) { setVaultError('Use a valid environment variable name.'); return; }
    setVariables(current => ({ ...current, [key.trim()]: current[key.trim()] || '' }));
    setVaultUnlocked(true);
    setVaultError('');
  };
  const updateVariable = (key, value) => setVariables(current => ({ ...current, [key]: value }));
  const removeVariable = (key) => setVariables(current => { const next = { ...current }; delete next[key]; return next; });

  const unlockVault = async () => {
    setBusy(true); setVaultError(''); setVaultMessage('');
    try {
      const payload = JSON.parse(localStorage.getItem(VAULT_KEY) || 'null');
      if (!payload) throw new Error('No encrypted vault is saved on this device yet.');
      const data = await decryptVault(payload, passphrase);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Vault contents are invalid.');
      setVariables(data.variables || {});
      setUrl('');
      setToken(data.apiToken || '');
      setApiToken(data.apiToken || '');
      setVaultUnlocked(true);
      setVaultMessage('Encrypted connection vault unlocked on this device.');
    } catch { setVaultError('Could not unlock the vault. Check the passphrase or import a valid JPTI configuration file.'); }
    finally { setBusy(false); }
  };
  const saveVault = async () => {
    if (!passphrase || passphrase.length < 12) { setVaultError('Use a vault passphrase with at least 12 characters.'); return; }
    if (!vaultExists && passphrase !== confirmPassphrase) { setVaultError('The passphrases do not match.'); return; }
    setBusy(true); setVaultError(''); setVaultMessage('');
    try {
      const payload = await encryptVault({ variables, apiBaseUrl: url, apiToken: token }, passphrase);
      localStorage.setItem(VAULT_KEY, JSON.stringify(payload));
      setVaultExists(true); setVaultUnlocked(true); setConfirmPassphrase('');
      setVaultMessage('Saved ' + count + ' variables in an AES-256-GCM encrypted vault on this device.');
    } catch (error) { setVaultError(error.message || 'Could not save encrypted vault.'); }
    finally { setBusy(false); }
  };
  const exportConfig = () => {
    const blob = new Blob([JSON.stringify({ format: 'jpti-connection-config', version: 1, exportedAt: new Date().toISOString(), variables, apiBaseUrl: url, apiToken: token }, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = href; anchor.download = 'jpti-connection-config.json'; anchor.click();
    URL.revokeObjectURL(href);
  };
  const importConfig = async (file) => {
    const text = await file.text();
    if (file.name.toLowerCase().endsWith('.json')) {
      const data = JSON.parse(text);
      if (data.format !== 'jpti-connection-config' || !data.variables || typeof data.variables !== 'object') throw new Error('This is not a JPTI connection configuration export.');
      setVariables(data.variables); setUrl(''); setToken(data.apiToken || ''); setApiToken(data.apiToken || ''); setVaultUnlocked(true);
      setVaultMessage('Imported ' + Object.keys(data.variables).length + ' settings from a JPTI configuration export.');
    } else await importText(text);
  };
  const testApi = async () => {
    setApiBusy(true); setApiError(''); setApiStatus(null);
    try {
      const response = await fetch('/api/health', { cache: 'no-store', headers: { accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok || data.status !== 'ok' || data.mode !== 'cloudflare-edge') {
        throw new Error(data.error || 'The Cloudflare Pages market-data function did not return a healthy response.');
      }
      setApiStatus(data);
      setUrl(typeof window !== 'undefined' ? window.location.origin : '');
      setSavedUrl(typeof window !== 'undefined' ? window.location.origin : '');
    } catch (error) {
      setApiError((error.message || 'Cloudflare API health check failed.') + ' Confirm that this app is deployed on Cloudflare Pages with its Functions enabled.');
    } finally { setApiBusy(false); }
  };

  // Proves the token against the server instead of assuming it works, so a typo or a wrong secret is
  // caught here and not later as an unexplained 401 inside the private panels.
  const verifyToken = async () => {
    const candidate = token.trim();
    if (!candidate) { setTokenCheck({ kind: 'missing', message: 'Enter your JPTI_JOURNAL_TOKEN value first.' }); return; }
    setTokenBusy(true); setTokenCheck(null);
    try {
      setApiToken(candidate);
      setSavedToken('ACTIVE IN THIS SESSION');
      const response = await apiFetch('/api/auth/check', { cache: 'no-store', headers: { accept: 'application/json' } });
      const payload = await response.json().catch(() => ({}));
      setTokenCheck(describeTokenCheck(response.status, payload));
    } catch (error) {
      setTokenCheck({ kind: 'error', message: 'Could not reach the JPTI API to check the token: ' + (error?.message || 'network error') });
    } finally { setTokenBusy(false); }
  };

  const saveSettingsAndSync = async () => {
    try {
      const profile = { variables, apiBaseUrl: '', apiToken: '', savedAt: new Date().toISOString() };
      setApiToken(token);
      setSavedToken(token ? 'ACTIVE IN THIS SESSION' : 'NOT CONFIGURED');
      localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
      setUrl(typeof window !== 'undefined' ? window.location.origin : '');
      setSavedUrl(typeof window !== 'undefined' ? window.location.origin : '');
      setApiError('');
      setServerMessage(token ? 'Device settings saved. Private agent, department and journal requests will use the token for this browser session; public charts remain token-free.' : 'Device settings saved. Public charts are available; private agent, department and journal requests need the existing JPTI_JOURNAL_TOKEN.');
      await testApi();
      if (token.trim()) await verifyToken();
    } catch (error) {
      setApiError(error.message || 'Settings could not be saved.');
    }
  };

  const visibleEntries = Object.entries(groups).map(([group, entries]) => [group, entries.filter(([key]) => !filter || key.toLowerCase().includes(filter.toLowerCase()) || group.toLowerCase().includes(filter.toLowerCase()))]).filter(([, entries]) => entries.length);

  return <section className="glass-panel detail-workspace connection-settings">
    <span className="eyebrow">JPTI CONNECTION CONTROL CENTER</span>
    <h3>Connections, providers & environment variables</h3>
    <p>Configure the API endpoint and maintain a complete JPTI settings profile. Import your existing environment file or add variables manually. Imported files are parsed inside this app; their contents are not sent to GitHub or uploaded to a server.</p>
    <div className="quote-consensus-stats">
      <div><span>VARIABLES LOADED</span><b>{count}</b></div>
      <div><span>SENSITIVE VALUES</span><b>{secretCount}</b></div>
      <div><span>LOCAL VAULT</span><b>{vaultExists ? (vaultUnlocked ? 'UNLOCKED' : 'LOCKED') : 'NOT CREATED'}</b></div>
      <div><span>API CONNECTION</span><b>{apiStatus ? 'CLOUDFLARE EDGE' : 'SAME-ORIGIN'}</b></div>
    </div>

    <div className="detail-workspace">
      <div className="connection-section-head"><div><span className="eyebrow">01 · CLOUDFLARE EDGE</span><h4>Built-in JPTI market-data connection</h4></div><span className={apiStatus ? 'connected' : 'not-connected'}>{apiStatus ? 'CLOUDFLARE ONLINE' : 'NOT CHECKED'}</span></div>
      <p className="subtle-note">JPTI uses the Cloudflare Pages Functions API on this same domain. Public market charts need no token. Private agent evaluations, department operations and journal memory require the existing JPTI_JOURNAL_TOKEN Cloudflare secret.</p>
      <label className="connection-label" htmlFor="jpti-private-token">Private JPTI access token</label>
      <input id="jpti-private-token" className="connection-url" type="password" autoComplete="off" spellCheck="false" value={token} onChange={event => setToken(event.target.value)} placeholder="Enter the existing JPTI_JOURNAL_TOKEN value" />
      <p className="subtle-note">The token is held in session storage and sent only to protected same-origin JPTI routes. It is excluded from the unencrypted device profile. Save device settings to activate it for this session.{savedToken ? ' Status: ' + savedToken + '.' : ''}</p>
      <div className="news-search"><button type="button" onClick={testApi} disabled={apiBusy}>{apiBusy ? 'Checking…' : 'Check Cloudflare connection'}</button><button type="button" onClick={verifyToken} disabled={tokenBusy || !token.trim()}>{tokenBusy ? 'Verifying…' : 'Verify access token'}</button><button type="button" onClick={saveSettingsAndSync}>Save device settings</button></div>
      {tokenCheck && <p className={tokenCheck.kind === 'ok' ? 'connection-success' : 'quote-error'} role="status" aria-live="polite">{tokenCheck.message}</p>}
      {apiError && <p className="quote-error">{apiError}</p>}
      {apiStatus && <p className="connection-success">Connected · {apiStatus.service} · {apiStatus.exchanges?.join(', ')} · public market data only.</p>}
      <p className="subtle-note">Public catalog, ticker and candlestick data are read-only. Private account access, order execution and durable server-side portfolio services are not yet available in this Cloudflare edge runtime.</p>
    </div>

    <div className="detail-workspace">
      <div className="connection-section-head"><div><span className="eyebrow">02 · CONFIGURATION IMPORT</span><h4>Upload or enter all JPTI variables</h4></div><span className="not-connected">LOCAL PARSING</span></div>
      <p className="subtle-note">Accepts .env, .env.local, .txt and JPTI JSON exports. Existing variable names are preserved in this encrypted device profile only; values are not uploaded to Cloudflare.</p>
      <input ref={fileRef} type="file" accept=".env,.local,.txt,.json,text/plain,application/json" style={{display:'none'}} onChange={event => { const file = event.target.files?.[0]; if (file) importConfig(file).catch(error => setVaultError(error.message)); event.target.value=''; }}/>
      <div className="news-search"><button type="button" onClick={() => fileRef.current?.click()}>Upload configuration file</button><button type="button" onClick={addVariable}>Add variable manually</button><button type="button" onClick={exportConfig} disabled={!count}>Export JSON profile</button></div>{serverMessage && <p className="connection-success">{serverMessage}</p>}
      <div className="connection-toolbar"><input className="connection-url" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Filter variable names…"/><span>{count} total · {secretCount} sensitive</span></div>
      {visibleEntries.length === 0 && <p className="subtle-note">No variables loaded yet. Upload your existing environment file or add the first variable.</p>}
      {visibleEntries.map(([group, entries]) => <div className="connection-variable-group" key={group}>
        <div className="connection-group-title">{group}<span>{entries.length} variables</span></div>
        {entries.map(([key, value]) => <div className="connection-variable" key={key}>
          <label>{key}{SECRET_PATTERN.test(key) && <small>SECRET</small>}</label>
          <div><input className="connection-url" type={SECRET_PATTERN.test(key) && !revealed[key] ? 'password' : 'text'} autoComplete="off" spellCheck="false" value={value} onChange={event => updateVariable(key, event.target.value)} placeholder="Enter value (leave blank if unused)"/><button type="button" className="connection-visibility" onClick={() => setRevealed(current => ({...current,[key]:!current[key]}))}>{revealed[key] ? 'Hide' : 'Show'}</button><button type="button" className="connection-visibility" onClick={() => removeVariable(key)}>Remove</button></div>
        </div>)}
      </div>)}
    </div>

    <div className="detail-workspace">
      <div className="connection-section-head"><div><span className="eyebrow">03 · ENCRYPTED DEVICE VAULT</span><h4>Protect the configuration profile</h4></div><span className={vaultUnlocked ? 'connected' : 'not-connected'}>{vaultUnlocked ? 'UNLOCKED' : 'LOCKED'}</span></div>
      {!vaultUnlocked && vaultExists && <><label className="connection-label">Vault passphrase</label><input className="connection-url" type="password" autoComplete="current-password" value={passphrase} onChange={event => setPassphrase(event.target.value)} placeholder="Enter your vault passphrase"/><div className="news-search"><button type="button" onClick={unlockVault} disabled={busy || !passphrase}>{busy ? 'Unlocking…' : 'Unlock vault'}</button></div></>}
      {(!vaultExists || vaultUnlocked) && <><label className="connection-label">Vault passphrase (minimum 12 characters)</label><input className="connection-url" type="password" autoComplete="new-password" value={passphrase} onChange={event => setPassphrase(event.target.value)} placeholder="Create or enter a strong passphrase"/>{!vaultExists && <><label className="connection-label">Confirm passphrase</label><input className="connection-url" type="password" autoComplete="new-password" value={confirmPassphrase} onChange={event => setConfirmPassphrase(event.target.value)} placeholder="Repeat passphrase"/></>}<div className="news-search"><button type="button" onClick={saveVault} disabled={busy || !count}>{busy ? 'Encrypting…' : 'Save encrypted device vault'}</button><button type="button" onClick={() => { setVaultUnlocked(false); setVariables({}); setPassphrase(''); setConfirmPassphrase(''); }}>Lock editor</button></div></>}
      {vaultMessage && <p className="connection-success">{vaultMessage}</p>}{vaultError && <p className="quote-error">{vaultError}</p>}
      <p className="subtle-note">The device vault uses PBKDF2-SHA256 (310,000 iterations) and AES-256-GCM. The passphrase is not saved. Clearing browser/app storage or losing the passphrase can make the local vault unrecoverable. Exported JSON profiles contain readable secrets; store them securely.</p>
    </div>

    <div className="detail-workspace">
      <h4>Important deployment boundary</h4>
      <div className="risk-list">
        <p><b>Secrets stay out of frontend bundles.</b> Never place exchange credentials, database URLs, third-party service-account keys or private tokens in VITE_ variables or browser code.</p>
        <p><b>Import and vault are device-side.</b> The encrypted profile is stored in this browser/app only. Exported JSON is a portable configuration backup, not a server deployment.</p>
        <p><b>Server activation.</b> Apply server variables through the authenticated JPTI configuration endpoint. The server encrypts them outside the .env files; restart the JPTI API before expecting every module to use the new values. Client-only VITE_ variables are excluded from server submission.</p>
        <p><b>Trading safety:</b> keep paper mode enabled and exchange keys read-only while testing. Do not enable withdrawals. Live trading remains governed by the server-side risk controls.</p>
      </div>
    </div>
  </section>;
}
