// Optional outbound alert channels. Alerts are always stored; delivery only happens for channels the
// operator configured through Worker secrets. Secrets are never logged or echoed in results.
import { meetsSeverity } from './alert-engine.js';

const MAX_LISTED = 10;
const TELEGRAM_LIMIT = 4000;
const ICON = { critical: '[CRITICAL]', warning: '[WARNING]', info: '[INFO]' };

export function formatAlertText(alerts) {
  const shown = alerts.slice(0, MAX_LISTED);
  const lines = shown.map((a) => (ICON[a.severity] || '[ALERT]') + ' ' + a.title + '\n' + a.message);
  if (alerts.length > shown.length) lines.push('...and ' + (alerts.length - shown.length) + ' more.');
  const text = 'JPTI alerts (' + alerts.length + ')\n\n' + lines.join('\n\n');
  return text.length > TELEGRAM_LIMIT ? text.slice(0, TELEGRAM_LIMIT - 1) + '…' : text;
}

export async function signPayload(secret, body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Only https webhooks are allowed so payloads and signatures never travel in clear text. */
export function webhookUrl(env) {
  const raw = String(env.JPTI_ALERT_WEBHOOK_URL || '').trim();
  if (!raw) return null;
  try { const u = new URL(raw); return u.protocol === 'https:' ? u.toString() : null; } catch { return null; }
}

export function configuredChannels(env = {}) {
  const channels = [];
  if (webhookUrl(env)) channels.push('webhook');
  if (env.JPTI_TELEGRAM_BOT_TOKEN && env.JPTI_TELEGRAM_CHAT_ID) channels.push('telegram');
  return channels;
}

async function post(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetchImpl(url, { ...init, signal: controller.signal }); } finally { clearTimeout(timer); }
}

/**
 * Sends one digest per channel for the alerts at or above `minSeverity`.
 * Returns what happened per channel so the caller can persist it.
 */
export async function deliverAlerts(alerts, { env = {}, fetchImpl = fetch, minSeverity = 'warning', timeoutMs = 5000 } = {}) {
  const eligible = alerts.filter((a) => meetsSeverity(a, minSeverity));
  const result = { eligible: eligible.length, channels: configuredChannels(env), delivered: [], failed: [] };
  if (!eligible.length || !result.channels.length) return result;

  if (result.channels.includes('webhook')) {
    try {
      const body = JSON.stringify({ service: 'jpti', sentAt: new Date().toISOString(), text: formatAlertText(eligible), alerts: eligible });
      const headers = { 'content-type': 'application/json' };
      if (env.JPTI_ALERT_WEBHOOK_SECRET) headers['x-jpti-signature'] = 'sha256=' + await signPayload(env.JPTI_ALERT_WEBHOOK_SECRET, body);
      const response = await post(fetchImpl, webhookUrl(env), { method: 'POST', headers, body }, timeoutMs);
      if (response.ok) result.delivered.push('webhook'); else result.failed.push({ channel: 'webhook', error: 'HTTP ' + response.status });
    } catch (error) { result.failed.push({ channel: 'webhook', error: error?.name === 'AbortError' ? 'timeout' : 'request failed' }); }
  }

  if (result.channels.includes('telegram')) {
    try {
      const url = 'https://api.telegram.org/bot' + encodeURIComponent(env.JPTI_TELEGRAM_BOT_TOKEN) + '/sendMessage';
      const body = JSON.stringify({ chat_id: env.JPTI_TELEGRAM_CHAT_ID, text: formatAlertText(eligible), disable_web_page_preview: true });
      const response = await post(fetchImpl, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, timeoutMs);
      if (response.ok) result.delivered.push('telegram'); else result.failed.push({ channel: 'telegram', error: 'HTTP ' + response.status });
    } catch (error) { result.failed.push({ channel: 'telegram', error: error?.name === 'AbortError' ? 'timeout' : 'request failed' }); }
  }
  return result;
}
