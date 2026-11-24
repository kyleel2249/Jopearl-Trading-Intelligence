const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-jpti-runtime': 'cloudflare-edge' };
const MAX_BODY = 24 * 1024;
const localWindows = new Map();

function respond(status, body) { return new Response(JSON.stringify(body), { status, headers }); }
async function digest(value) {
  const bytes = new TextEncoder().encode(String(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function rateLimit(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = 'jpti:signal-write:' + await digest(ip);
  const now = Date.now();
  if (env.JPTI_KV) {
    const previous = Number(await env.JPTI_KV.get(key)) || 0;
    if (previous >= 60) return false;
    await env.JPTI_KV.put(key, String(previous + 1), { expirationTtl: 60 });
    return true;
  }
  const previous = localWindows.get(key) || { start: now, count: 0 };
  if (now - previous.start >= 60000) { previous.start = now; previous.count = 0; }
  previous.count += 1; localWindows.set(key, previous);
  return previous.count <= 60;
}
function validSignal(signal) {
  return signal && typeof signal === 'object' && typeof signal.signalId === 'string' &&
    signal.signalId.length > 0 && signal.signalId.length <= 220 &&
    typeof signal.symbol === 'string' && /^[A-Z0-9._-]{2,20}\/[A-Z0-9._-]{2,20}$/.test(signal.symbol) &&
    ['long', 'short', 'neutral'].includes(signal.direction) &&
    Number.isFinite(Number(signal.score)) && Number(signal.score) >= 0 && Number(signal.score) <= 100;
}

export async function onRequest({ request, env = {} }) {
  if (!env.JPTI_DB) return respond(503, { error: 'Signal history storage is not configured: JPTI_DB binding is missing.' });
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname.endsWith('/history')) {
    try {
      const limit = Math.max(1, Math.min(250, Number(url.searchParams.get('limit')) || 100));
      const result = await env.JPTI_DB.prepare("SELECT payload, occurred_at FROM jpti_events WHERE kind = 'signal-intelligence' ORDER BY occurred_at DESC LIMIT ?").bind(limit).all();
      const records = (result.results || []).map((row) => {
        try { return { ...JSON.parse(row.payload), observedAt: row.occurred_at }; } catch { return null; }
      }).filter(Boolean);
      return respond(200, { records, count: records.length, source: 'cloudflare-d1' });
    } catch { return respond(503, { error: 'Could not read durable signal history.' }); }
  }
  if (request.method === 'POST' && url.pathname.endsWith('/observations')) {
    const length = Number(request.headers.get('content-length') || 0);
    if (length > MAX_BODY) return respond(413, { error: 'Signal observation payload is too large.' });
    if (!await rateLimit(request, env)) return respond(429, { error: 'Signal history write limit reached. Retry shortly.' });
    let body;
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_BODY) return respond(413, { error: 'Signal observation payload is too large.' });
      body = JSON.parse(raw);
    } catch { return respond(400, { error: 'A valid JSON signal observation payload is required.' }); }
    const signals = Array.isArray(body?.signals) ? body.signals : [];
    if (!signals.length || signals.length > 12 || !signals.every(validSignal)) return respond(400, { error: 'Provide 1–12 valid signal observations.' });
    try {
      const now = new Date().toISOString();
      const statements = await Promise.all(signals.map(async (signal) => {
        const id = 'signal:' + await digest(signal.signalId);
        const payload = JSON.stringify({ ...signal, observedAt: now, persistence: 'cloudflare-d1' });
        return env.JPTI_DB.prepare("INSERT INTO jpti_events (id, kind, source, external_id, symbol, occurred_at, payload) VALUES (?, 'signal-intelligence', 'signal-engine-v1', ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET occurred_at = excluded.occurred_at, payload = excluded.payload, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')")
          .bind(id, signal.signalId, signal.symbol, now, payload);
      }));
      await env.JPTI_DB.batch(statements);
      return respond(200, { status: 'saved', saved: statements.length, source: 'cloudflare-d1', occurredAt: now });
    } catch { return respond(503, { error: 'Signal observations could not be saved to D1.' }); }
  }
  return respond(404, { error: 'Signal Intelligence endpoint not found.' });
}
