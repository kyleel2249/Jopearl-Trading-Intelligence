// Cloudflare Pages-native JPTI market-data API.
// This replaces the old Render pass-through. Public exchange data is fetched from
// Cloudflare's edge and normalized through the same tested provider used by the UI.
// Private account access, order execution, durable ledger and Node-only API routes
// are intentionally NOT advertised as implemented by this edge adapter.
import { createDirectProvider, DIRECT_EXCHANGES } from '../../src/lib/browser-direct.js';
import { createBitgetCfdProvider } from '../bitget-cfd.js';
import { correlateCandleSeries } from '../../src/pair-scanner-engine.js';

const provider = createDirectProvider();
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-jpti-runtime': 'cloudflare-edge'
};
const MAX_URL_LENGTH = 2048;


async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function marketCacheTtl(path) {
  if (/\/markets(?:\/|$)/i.test(path)) return 300;
  if (/\/ohlcv(?:\/|$)/i.test(path)) return 20;
  return 8;
}

async function readMarketCache(env, routeKey) {
  if (!env.JPTI_KV) return null;
  try {
    const key = 'jpti:market:v1:' + await sha256Hex(routeKey);
    const cached = await env.JPTI_KV.get(key, 'json');
    return cached && Number.isInteger(cached.status) && cached.body ? { ...cached, key } : null;
  } catch {
    return null;
  }
}

async function persistMarketSnapshot(env, routeKey, body, occurredAt) {
  if (!env.JPTI_DB) return;
  try {
    const routeHash = await sha256Hex(routeKey);
    const id = 'market:' + routeHash;
    await env.JPTI_DB.prepare(
      "INSERT INTO jpti_events (id, kind, source, external_id, occurred_at, payload) VALUES (?, 'market-snapshot', 'cloudflare-edge', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET external_id = excluded.external_id, occurred_at = excluded.occurred_at, payload = excluded.payload, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"
    ).bind(id, routeKey, occurredAt, JSON.stringify(body)).run();
  } catch {
    // Public market delivery must remain available if optional snapshot persistence is degraded.
  }
}

async function cacheMarketResponse(env, routeKey, status, body, occurredAt) {
  const ttl = marketCacheTtl(routeKey);
  if (env.JPTI_KV) {
    try {
      const key = 'jpti:market:v1:' + await sha256Hex(routeKey);
      const value = JSON.stringify({ status, body, cachedAt: occurredAt });
      // KV values have a finite size limit. Skip oversized market catalogs rather than fail the API.
      if (new TextEncoder().encode(value).byteLength <= 900000) {
        await env.JPTI_KV.put(key, value, { expirationTtl: ttl });
      }
    } catch {
      // Cache failures must not make live exchange data unavailable.
    }
  }
  await persistMarketSnapshot(env, routeKey, body, occurredAt);
}

async function readStoredMarketSnapshot(env, routeKey) {
  if (!env.JPTI_DB) return null;
  try {
    const row = await env.JPTI_DB.prepare(
      "SELECT payload, occurred_at FROM jpti_events WHERE kind = 'market-snapshot' AND external_id = ? ORDER BY occurred_at DESC LIMIT 1"
    ).bind(routeKey).first();
    if (!row?.payload) return null;
    const body = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    return { body, occurredAt: row.occurred_at || null };
  } catch {
    return null;
  }
}

async function cacheStaleMarketResponse(env, routeKey, body, occurredAt) {
  if (!env.JPTI_KV) return;
  try {
    const key = 'jpti:market:v1:' + await sha256Hex(routeKey);
    await env.JPTI_KV.put(key, JSON.stringify({ status: 200, body, cachedAt: occurredAt, stale: true }), { expirationTtl: 5 });
  } catch {
    // Stale cache is best-effort; D1 remains the durable source.
  }
}

function buildCandleContext(exchange, symbol, timeframe, candles, generatedAt) {
  const rows = (Array.isArray(candles) ? candles : [])
    .filter((row) => Array.isArray(row) && row.length >= 6 && row.slice(0, 6).every((value) => Number.isFinite(Number(value))))
    .map((row) => row.slice(0, 6).map(Number));
  if (rows.length < 21) {
    return { status: 422, body: { error: 'At least 21 valid candles are required for market context.', source: 'cloudflare-edge' } };
  }
  const closed = rows.slice(0, -1);
  const closes = closed.map((row) => row[4]);
  const volumes = closed.map((row) => row[5]);
  const latest = closed.at(-1);
  const prior = closes.at(-21);
  const priceChangePct = prior ? ((latest[4] - prior) / prior) * 100 : 0;
  const avgVolume = volumes.slice(-21, -1).reduce((sum, value) => sum + value, 0) / Math.max(1, volumes.slice(-21, -1).length);
  const volumeChangePct = avgVolume > 0 ? ((latest[5] / avgVolume) - 1) * 100 : null;
  const sma20 = closes.slice(-20).reduce((sum, value) => sum + value, 0) / 20;
  const trendPct = sma20 ? ((latest[4] - sma20) / sma20) * 100 : 0;
  const momentumContribution = Math.max(-35, Math.min(35, priceChangePct * 3));
  const trendContribution = Math.max(-25, Math.min(25, trendPct * 8));
  const volumeContribution = volumeChangePct === null ? 0 : Math.sign(priceChangePct) * Math.max(0, Math.min(15, volumeChangePct * 0.15));
  const score = Math.round(Math.max(-100, Math.min(100, momentumContribution + trendContribution + volumeContribution)));
  const direction = score >= 12 ? 'bullish' : score <= -12 ? 'bearish' : 'neutral';
  const confidence = Math.abs(score) >= 45 ? 'moderate' : 'low';
  const bias = priceChangePct > 0.15 ? 'bullish' : priceChangePct < -0.15 ? 'bearish' : 'neutral';
  return {
    status: 200,
    body: {
      exchange,
      symbol: symbol.replace('-', '/'),
      generatedAt,
      market: {
        exchange, symbol: symbol.replace('-', '/'), priceChangePct: Number(priceChangePct.toFixed(4)),
        volumeChangePct: volumeChangePct === null ? null : Number(volumeChangePct.toFixed(2)),
        orderBookImbalancePct: null, fundingRate: null, last: latest[4], sma20
      },
      broadContext: { globalMarketCapChange24hPct: null, status: 'not-connected' },
      multiTimeframe: [{ timeframe, bias, changePct: Number(priceChangePct.toFixed(4)), source: 'selected-timeframe OHLCV' }],
      score: {
        score, direction, confidence,
        evidence: [
          { factor: '20-bar momentum', contribution: Number(momentumContribution.toFixed(2)) },
          { factor: 'SMA20 trend', contribution: Number(trendContribution.toFixed(2)) },
          { factor: 'Relative volume confirmation', contribution: Number(volumeContribution.toFixed(2)) }
        ]
      },
      sources: [
        { name: exchange.toUpperCase() + ' OHLCV', status: 'live' },
        { name: 'Order book depth', status: 'unsupported' },
        { name: 'Perpetual funding', status: 'unsupported' },
        { name: 'Global market context', status: 'not-connected' }
      ],
      limitations: [
        'This is a lightweight, single-timeframe OHLCV heuristic generated at the Cloudflare edge.',
        'Order-book depth, funding, global market breadth and multi-timeframe confirmation are not included; this is not a trade instruction.'
      ],
      source: 'cloudflare-edge'
    }
  };
}

function json(status, body, request, extra = {}) {
  const headers = new Headers({ ...JSON_HEADERS, ...extra });
  const origin = request.headers.get('Origin');
  // Same-origin Pages traffic plus the standard Capacitor WebView origins.
  // No wildcard is used and credentials are never enabled.
  const nativeOrigins = new Set(['capacitor://localhost', 'https://localhost', 'http://localhost']);
  let allowed = false;
  if (origin) {
    try { allowed = new URL(origin).origin === new URL(request.url).origin || nativeOrigins.has(origin); }
    catch { allowed = false; }
  }
  if (allowed) {
    headers.set('access-control-allow-origin', origin);
    headers.append('vary', 'Origin');
  }
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(body), { status, headers });
}


async function verifyJournalToken(request, env) {
  const expected = String(env.JPTI_JOURNAL_TOKEN || env.JPTI_API_TOKEN || '');
  const provided = String(request.headers.get('x-jpti-api-token') || request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '');
  if (!expected) return { ok: false, status: 503, error: 'Private journal storage is not configured. Set the JPTI_JOURNAL_TOKEN Cloudflare secret.' };
  const [a,b] = await Promise.all([
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(expected)),
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(provided))
  ]);
  const left = new Uint8Array(a), right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0 ? { ok: true } : { ok: false, status: 401, error: 'Private journal authorization failed.' };
}

async function handleJournalRoute(request, env, url) {
  if (!env.JPTI_DB) return json(503, { error: 'Cloudflare D1 binding JPTI_DB is unavailable.' }, request);
  const auth = await verifyJournalToken(request, env);
  if (!auth.ok) return json(auth.status, { error: auth.error }, request);
  const ownerKey = 'primary';
  if (request.method === 'GET') {
    try {
      const result = await env.JPTI_DB.prepare(
        'SELECT payload, updated_at FROM jpti_journal_entries WHERE owner_key = ? ORDER BY updated_at DESC LIMIT 200'
      ).bind(ownerKey).all();
      const entries = (result.results || []).map(row => {
        try { return typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload; } catch { return null; }
      }).filter(Boolean);
      return json(200, { entries, count: entries.length, storage: 'cloudflare-d1', durable: true }, request);
    } catch (error) {
      return json(500, { error: 'Could not read journal records from D1.', detail: String(error?.message || error).slice(0, 180) }, request);
    }
  }
  if (request.method === 'POST') {
    const length = Number(request.headers.get('content-length') || 0);
    if (length > 512000) return json(413, { error: 'Journal record exceeds the 512 KB request limit.' }, request);
    let body;
    try { body = await request.json(); } catch { return json(400, { error: 'A valid JSON journal record is required.' }, request); }
    const entry = body?.entry;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return json(400, { error: 'Send one journal entry in the entry field.' }, request);
    const id = String(entry.id || '').trim();
    const symbol = String(entry.symbol || '').trim().toUpperCase();
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !/^[A-Z0-9._/-]{3,40}$/.test(symbol)) {
      return json(400, { error: 'Journal entry id or symbol is invalid.' }, request);
    }
    const payload = JSON.stringify(entry);
    if (new TextEncoder().encode(payload).byteLength > 500000) return json(413, { error: 'Journal record exceeds the 500 KB storage limit.' }, request);
    try {
      await env.JPTI_DB.prepare(
        "INSERT INTO jpti_journal_entries (owner_key, entry_id, symbol, payload) VALUES (?, ?, ?, ?) ON CONFLICT(owner_key, entry_id) DO UPDATE SET symbol = excluded.symbol, payload = excluded.payload, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"
      ).bind(ownerKey, id, symbol, payload).run();
      return json(200, { ok: true, id, symbol, storage: 'cloudflare-d1', durable: true }, request);
    } catch (error) {
      return json(500, { error: 'Could not save journal record to D1.', detail: String(error?.message || error).slice(0, 180) }, request);
    }
  }
  return json(405, { error: 'Journal route supports GET and POST only.' }, request, { allow: 'GET, POST, OPTIONS' });
}

const MAX_SESSION_OUTCOMES=20000,MAX_GAINZ_OUTCOMES=5000,MAX_GAINZ_BATCH=500;
const btxt=(v,n,d='unknown')=>String(v??'').trim().slice(0,n)||d;
const bnum=(v,lo,hi)=>{if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)?Math.min(hi,Math.max(lo,n)):null;};
function cleanSessionOutcome(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Object.assign(new Error('Outcome record must be an object.'),{status:400});
 const outcome=String(input.outcome||'').toLowerCase();if(!['win','loss','breakeven'].includes(outcome))throw Object.assign(new Error('Outcome must be win, loss or breakeven.'),{status:400});
 const returnR=bnum(input.returnR,-50,50);if(input.returnR!==null&&input.returnR!==undefined&&input.returnR!==''&&returnR===null)throw Object.assign(new Error('Return in R must be finite.'),{status:400});
 const date=input.createdAt?new Date(input.createdAt):new Date();if(!Number.isFinite(date.getTime()))throw Object.assign(new Error('Invalid outcome timestamp.'),{status:400});
 const id=btxt(input.id||crypto.randomUUID(),160,'');if(!/^[a-zA-Z0-9._:|/-]{1,160}$/.test(id))throw Object.assign(new Error('Outcome id is invalid.'),{status:400});
 return{id,session:btxt(input.session,120),symbol:btxt(input.symbol,32).toUpperCase(),strategy:btxt(input.strategy,120,'Unspecified'),volatility:btxt(input.volatility,40),outcome,returnR,notes:String(input.notes||'').slice(0,500),createdAt:date.toISOString()};
}
function summarizeSessionOutcomes(records){
 const groups=new Map();for(const r of records){const k=[r.session,r.symbol,r.strategy,r.volatility].join('|');const g=groups.get(k)||{session:r.session,symbol:r.symbol,strategy:r.strategy,volatility:r.volatility,trades:0,wins:0,losses:0,breakevens:0,totalR:0,scored:0};g.trades++;if(r.outcome==='win')g.wins++;else if(r.outcome==='loss')g.losses++;else g.breakevens++;if(Number.isFinite(r.returnR)){g.totalR+=r.returnR;g.scored++;}groups.set(k,g);}
 return [...groups.values()].map(g=>({...g,winRate:g.trades?g.wins/g.trades*100:0,averageR:g.scored?g.totalR/g.scored:null}));
}
async function loadD1OutcomeRecords(env,kind,limit){
 const result=await env.JPTI_DB.prepare('SELECT id, payload, occurred_at FROM jpti_events WHERE kind = ? ORDER BY occurred_at DESC, created_at DESC LIMIT ?').bind(kind,limit).all(),seen=new Set(),out=[];
 for(const row of result.results||[]){let event;try{event=typeof row.payload==='string'?JSON.parse(row.payload):row.payload;}catch{continue;}const r=event?.record||event;if(!r?.id||seen.has(r.id))continue;seen.add(r.id);out.push(r);}return out.reverse();
}
async function countD1OutcomeRecords(env,kind){
 const result=await env.JPTI_DB.prepare('SELECT COUNT(*) AS count FROM jpti_events WHERE kind = ?').bind(kind).all();
 return Number(result.results?.[0]?.count||0);
}
async function loadD1OutcomeById(env,id){
 const result=await env.JPTI_DB.prepare('SELECT payload FROM jpti_events WHERE id = ?').bind(id).all();
 const raw=result.results?.[0]?.payload;if(!raw)return null;
 try{const event=typeof raw==='string'?JSON.parse(raw):raw;return event?.record||event;}catch{return null;}
}
async function insertD1Outcome(env,id,kind,source,record){
 const r=await env.JPTI_DB.prepare('INSERT OR IGNORE INTO jpti_events (id, kind, source, external_id, symbol, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id,kind,source,record.id,record.symbol,record.createdAt||new Date(record.candleTs).toISOString(),JSON.stringify({record})).run();
 return Number(r?.meta?.changes||0)>0;
}
async function handleSessionMemoryRoute(request,env,url){
 if(!env.JPTI_DB)return json(503,{error:'Cloudflare D1 binding JPTI_DB is unavailable.'},request);
 const auth=await verifyJournalToken(request,env);if(!auth.ok)return json(auth.status,{error:auth.error},request);
 try{
  if(request.method==='GET'){
   const requested=Number(url.searchParams.get('limit')||1000),limit=Number.isFinite(requested)?Math.min(5000,Math.max(1,Math.floor(requested))):1000;
   const recent=await loadD1OutcomeRecords(env,'session-outcome',limit),count=await countD1OutcomeRecords(env,'session-outcome');
   return json(200,{records:recent,summary:summarizeSessionOutcomes(recent),count,returned:recent.length,backend:true,storage:'cloudflare-d1'},request);
  }
  if(request.method!=='POST')return json(405,{error:'Session memory supports GET and POST only.'},request,{allow:'GET, POST, OPTIONS'});
  if(Number(request.headers.get('content-length')||0)>512000)return json(413,{error:'Session outcome request exceeds the 512 KB limit.'},request);
  let body;try{body=await request.json();}catch{return json(400,{error:'A valid JSON outcome record is required.'},request);}
  if(new TextEncoder().encode(JSON.stringify(body)).byteLength>512000)return json(413,{error:'Session outcome payload exceeds the 512 KB limit.'},request);
  if(url.pathname.replace(/\/+$/,'')==='/api/session/memory/batch'){
   if(!Array.isArray(body?.records)||body.records.length>2000)return json(400,{error:'Send an array of up to 2,000 session outcome records.'},request);
   const cleaned=body.records.map(cleanSessionOutcome),known=new Set();let imported=0,duplicates=0;
   for(const r of cleaned){if(known.has(r.id)){duplicates++;continue;}known.add(r.id);const ok=await insertD1Outcome(env,'session:'+r.id,'session-outcome','jpti-session-intelligence',r);if(ok)imported++;else duplicates++;}
   const recent=await loadD1OutcomeRecords(env,'session-outcome',1000),count=await countD1OutcomeRecords(env,'session-outcome');
   return json(201,{ok:true,imported,duplicates,count,returned:recent.length,summary:summarizeSessionOutcomes(recent),storage:'cloudflare-d1'},request);
  }
  const record=cleanSessionOutcome(body),inserted=await insertD1Outcome(env,'session:'+record.id,'session-outcome','jpti-session-intelligence',record);
  const stored=inserted?record:(await loadD1OutcomeById(env,'session:'+record.id))||record;
  const recent=await loadD1OutcomeRecords(env,'session-outcome',1000),count=await countD1OutcomeRecords(env,'session-outcome');
  return json(201,{ok:true,record:stored,duplicate:!inserted,eventId:inserted?'session:'+record.id:null,count,returned:recent.length,summary:summarizeSessionOutcomes(recent),storage:'cloudflare-d1',backend:true},request);
 }catch(e){return json(e.status||500,{error:e.message||'Session outcome storage failed.'},request);}
}
function cleanGainzOutcome(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Object.assign(new Error('Outcome record must be an object.'),{status:400});
 const outcome=String(input.outcome||'').toLowerCase(),direction=String(input.direction||'').toLowerCase();if(!['win','loss','timeout'].includes(outcome))throw Object.assign(new Error('Outcome must be win, loss or timeout.'),{status:400});if(!['bullish','bearish'].includes(direction))throw Object.assign(new Error('Direction must be bullish or bearish.'),{status:400});
 const returnR=bnum(input.returnR,-20,50),candleTs=bnum(input.candleTs,1,8.64e15);if(returnR===null||candleTs===null)throw Object.assign(new Error('returnR and candleTs must be valid finite numbers.'),{status:400});
 const symbol=btxt(input.symbol,32).toUpperCase(),timeframe=btxt(input.timeframe,8);if(symbol==='UNKNOWN'||timeframe==='unknown')throw Object.assign(new Error('symbol and timeframe are required.'),{status:400});
 const factors={};if(input.factors&&typeof input.factors==='object'&&!Array.isArray(input.factors))for(const[k,v]of Object.entries(input.factors).slice(0,16)){const n=bnum(v,-2,2);if(n!==null)factors[btxt(k,24)]=n;}
 const id=btxt(input.id,200,[symbol,timeframe,input.preset,candleTs,input.setupId].join('|'));
 return{id,setupId:btxt(input.setupId,200,id),symbol,exchange:btxt(input.exchange,30),timeframe,preset:btxt(input.preset,20,'balanced').toLowerCase(),setupType:btxt(input.setupType,40,'confluence'),direction,session:btxt(input.session,30),regime:btxt(input.regime,20),volRegime:btxt(input.volRegime,12),candleTs,outcome,returnR,mfeR:bnum(input.mfeR,-50,50),maeR:bnum(input.maeR,-50,50),bars:bnum(input.bars,0,10000),falseSignal:input.falseSignal===true,confidence:bnum(input.confidence,0,100),score:bnum(input.score,-1,1),factors,confirmations:Array.isArray(input.confirmations)?input.confirmations.slice(0,12).map(v=>btxt(v,24)):[],modelVersion:btxt(input.modelVersion,40),tfMs:bnum(input.tfMs,0,3e9)};
}
async function handleGainzOutcomesRoute(request,env,url){
 if(!env.JPTI_DB)return json(503,{error:'Cloudflare D1 binding JPTI_DB is unavailable.'},request);
 const auth=await verifyJournalToken(request,env);if(!auth.ok)return json(auth.status,{error:auth.error},request);
 try{
  const symbol=url.searchParams.get('symbol')?.toUpperCase()||null,timeframe=url.searchParams.get('timeframe')||null;
  if(request.method==='GET'){
   const requested=Number(url.searchParams.get('limit')||MAX_GAINZ_OUTCOMES),limit=Number.isFinite(requested)?Math.min(MAX_GAINZ_OUTCOMES,Math.max(1,Math.floor(requested))):MAX_GAINZ_OUTCOMES;
   const records=await loadD1OutcomeRecords(env,'gainz-alpha-outcome',limit),rows=records.filter(r=>(!symbol||r.symbol===symbol)&&(!timeframe||r.timeframe===timeframe));
   return json(200,{records:rows,count:rows.length,backend:true,storage:'cloudflare-d1'},request);
  }
  if(request.method!=='POST')return json(405,{error:'GainzAlpha outcomes support GET and POST only.'},request,{allow:'GET, POST, OPTIONS'});
  if(Number(request.headers.get('content-length')||0)>512000)return json(413,{error:'GainzAlpha outcome request exceeds the 512 KB limit.'},request);
  let body;try{body=await request.json();}catch{return json(400,{error:'A valid outcomes payload is required.'},request);}
  if(new TextEncoder().encode(JSON.stringify(body)).byteLength>512000)return json(413,{error:'GainzAlpha outcomes payload exceeds the 512 KB limit.'},request);
  if(!Array.isArray(body?.records)||body.records.length>MAX_GAINZ_BATCH)return json(400,{error:'Send an array of up to '+MAX_GAINZ_BATCH+' GainzAlpha outcome records.'},request);
  const known=new Set();let saved=0,duplicates=0;const rejected=[];
  for(const[index,raw]of body.records.entries()){let r;try{r=cleanGainzOutcome(raw);}catch(e){rejected.push({index,error:e.message});continue;}if(known.has(r.id)){duplicates++;continue;}known.add(r.id);const ok=await insertD1Outcome(env,'gainz:'+r.id,'gainz-alpha-outcome','gainz-alpha',r);if(ok)saved++;else duplicates++;}
  const count=await countD1OutcomeRecords(env,'gainz-alpha-outcome');
  return json(200,{saved,duplicates,rejected,count,storage:'cloudflare-d1'},request);
 }catch(e){return json(e.status||500,{error:e.message||'GainzAlpha outcome storage failed.'},request);}
}

function decodeXml(value) {
  return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function rssItems(xml, limit = 10) {
  const items = [];
  for (const match of String(xml || '').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const field = name => decodeXml(block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i'))?.[1] || '').replace(/<[^>]+>/g, '').trim();
    const title = field('title'), link = field('link'), publishedAt = field('pubDate');
    if (title && link) items.push({ title: title.slice(0, 300), url: link.slice(0, 1000), publishedAt: publishedAt || null, source: 'Google News RSS' });
    if (items.length >= limit) break;
  }
  return items;
}

async function fetchPairResearch(symbol, fetchImpl = fetch) {
  const base = String(symbol || '').split('/')[0].trim().toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/.test(base)) return { status: 'invalid-symbol', symbol, generatedAt: new Date().toISOString(), sources: [], errors: ['Pair base symbol is invalid.'] };
  const generatedAt = new Date().toISOString();
  const result = { status: 'partial', symbol, base, generatedAt, asset: null, candidates: [], news: [], sources: [], errors: [], caveats: [
    'Public research endpoints can be rate-limited, delayed or incomplete.',
    'CoinGecko asset matching is based on ticker symbol; multiple assets may share a ticker.',
    'News headlines are leads for review, not verified facts or trading signals.',
    'This research feed does not provide a full order-book, liquidation map, institutional flow or exchange-specific derivatives history.'
  ] };
  try {
    const searchResponse = await fetchImpl('https://api.coingecko.com/api/v3/search?query=' + encodeURIComponent(base), { headers: { accept: 'application/json' } });
    if (!searchResponse.ok) throw new Error('CoinGecko search returned HTTP ' + searchResponse.status);
    const search = await searchResponse.json();
    const candidates = (search.coins || []).filter(coin => String(coin.symbol || '').toUpperCase() === base).slice(0, 8);
    result.candidates = candidates.map(coin => ({ id: coin.id, name: coin.name, symbol: coin.symbol, marketCapRank: coin.market_cap_rank, thumb: coin.thumb }));
    if (candidates.length === 1 || (candidates.length > 1 && candidates[0].market_cap_rank && (!candidates[1].market_cap_rank || candidates[0].market_cap_rank < candidates[1].market_cap_rank))) {
      const selected = candidates[0];
      const detailResponse = await fetchImpl('https://api.coingecko.com/api/v3/coins/' + encodeURIComponent(selected.id) + '?localization=false&tickers=false&market_data=true&community_data=true&developer_data=true&sparkline=false', { headers: { accept: 'application/json' } });
      if (!detailResponse.ok) throw new Error('CoinGecko asset details returned HTTP ' + detailResponse.status);
      const coin = await detailResponse.json(), md = coin.market_data || {};
      const cleanDescription = String(coin.description?.en || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
      result.asset = {
        id: coin.id, name: coin.name, symbol: coin.symbol, categories: coin.categories || [],
        description: cleanDescription, marketCapRank: coin.market_cap_rank,
        currentPriceUsd: md.current_price?.usd ?? null, marketCapUsd: md.market_cap?.usd ?? null,
        fullyDilutedValuationUsd: md.fully_diluted_valuation?.usd ?? null, totalVolume24hUsd: md.total_volume?.usd ?? null,
        circulatingSupply: md.circulating_supply ?? null, totalSupply: md.total_supply ?? null, maxSupply: md.max_supply ?? null,
        priceChange24hPct: md.price_change_percentage_24h ?? null, priceChange7dPct: md.price_change_percentage_7d ?? null,
        priceChange14dPct: md.price_change_percentage_14d ?? null, priceChange30dPct: md.price_change_percentage_30d ?? null,
        allTimeHighUsd: md.ath?.usd ?? null, allTimeHighDate: md.ath_date?.usd ?? null,
        allTimeLowUsd: md.atl?.usd ?? null, allTimeLowDate: md.atl_date?.usd ?? null,
        homepage: (coin.links?.homepage || []).filter(Boolean).slice(0, 3),
        blockchainExplorers: (coin.links?.blockchain_site || []).filter(Boolean).slice(0, 5),
        officialTwitter: coin.links?.twitter_screen_name || null, officialTelegram: coin.links?.telegram_channel_identifier || null,
        github: (coin.links?.repos_url?.github || []).slice(0, 3),
        community: { twitterFollowers: coin.community_data?.twitter_followers ?? null, redditSubscribers: coin.community_data?.reddit_subscribers ?? null },
        developer: { forks: coin.developer_data?.forks ?? null, stars: coin.developer_data?.stars ?? null, commits4Weeks: coin.developer_data?.commit_count_4_weeks ?? null },
        lastUpdated: coin.last_updated || null
      };
      result.sources.push({ name: 'CoinGecko asset profile and market data', url: 'https://www.coingecko.com/en/coins/' + encodeURIComponent(coin.id), retrievedAt: generatedAt });
    } else if (candidates.length > 1) {
      result.status = 'ambiguous-asset-match';
      result.errors.push('Multiple CoinGecko assets share this ticker. Select the correct asset before treating any profile data as pair-specific.');
    } else {
      result.errors.push('No exact CoinGecko ticker match was found for ' + base + '.');
    }
  } catch (error) { result.errors.push(String(error?.message || error).slice(0, 240)); }

  try {
    const newsUrl = 'https://news.google.com/rss/search?q=' + encodeURIComponent(base + ' crypto token') + '&hl=en-US&gl=US&ceid=US:en';
    const newsResponse = await fetchImpl(newsUrl, { headers: { accept: 'application/rss+xml, application/xml, text/xml' } });
    if (!newsResponse.ok) throw new Error('Google News RSS returned HTTP ' + newsResponse.status);
    result.news = rssItems(await newsResponse.text(), 12);
    result.sources.push({ name: 'Google News RSS search', url: newsUrl, retrievedAt: generatedAt });
  } catch (error) { result.errors.push(String(error?.message || error).slice(0, 240)); }

  if (result.asset) result.status = result.news.length ? 'research-available' : 'asset-profile-available';
  return result;
}

async function handleMentorRoute(request, env, fetchImpl = fetch) {
  if (!env.JPTI_DB) return json(503, { error: 'Cloudflare D1 binding JPTI_DB is unavailable.' }, request);
  const auth = await verifyJournalToken(request, env);
  if (!auth.ok) return json(auth.status, { error: auth.error }, request);
  if (!env.AI || typeof env.AI.run !== 'function') return json(503, {
    error: 'Cloudflare Workers AI is not connected. Add a Workers AI binding named AI to the JPTI Pages project and redeploy.',
    code: 'WORKERS_AI_BINDING_MISSING'
  }, request);
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 96000) return json(413, { error: 'Mentor review request exceeds the 96 KB limit.' }, request);
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'A valid JSON mentor-review request is required.' }, request); }
  const entry = body?.entry;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return json(400, { error: 'Send the active journal entry in the entry field.' }, request);
  const symbol = String(entry.symbol || '').slice(0, 40);
  const research = await fetchPairResearch(symbol, fetchImpl);
  const context = JSON.stringify({
    entry, technicalAssessment: body.technicalAssessment || entry.technicalAssessment || null,
    userProvidedResearch: body.research || entry.researchSnapshot || null,
    independentlyRetrievedPublicResearch: research,
    recentJournalHistory: Array.isArray(body.history) ? body.history.slice(-30) : []
  }).slice(0, 42000);
  const system = [
    'You are JPTI, a rigorous personal trading development council.',
    'Act as: skeptical market researcher, technical analyst, derivatives risk analyst, trading coach, mentor, behavioural assessor, reflective-journal writer and excellent financial copywriter.',
    'Be thoughtful and adaptable in approach, but strict about facts. Never flatter, agree blindly, invent evidence, claim a trade was filled, state an unsupported probability, or present a model opinion as a fact.',
    'Separate USER-SUPPLIED FACTS, RETRIEVED PUBLIC DATA, TECHNICAL CALCULATIONS, INTERPRETATION, UNKNOWN / UNVERIFIED ITEMS and RECOMMENDATIONS.',
    'Use source URLs and timestamps from retrieved research. Flag ambiguous token matches, stale data, conflicting supply/unlock figures and missing evidence. Headlines are leads, not verified facts.',
    'Assess the trader only from observed journal behaviour and label personality conclusions provisional. Evaluate process quality separately from trade P/L.',
    'For leveraged trades, discuss notional exposure, margin, leverage, liquidation uncertainty, funding, fees, stop/invalidation and bounded loss. Never encourage reckless exposure or loss recovery.',
    'Review whether the trade direction agrees with multi-timeframe structure. Explain countertrend trades without automatically rejecting them.',
    'Write a polished, detailed reflective journal report that starts with the user exact opening statement when provided. Preserve their meaning and voice.',
    'Provide concrete next actions and questions. Do not place, modify or cancel orders.',
    'Return Markdown with headings: Executive assessment; Pair research; Technical assessment; Trade and risk review; Trader profile; Strengths; Weaknesses and blind spots; Coaching plan; Journal narrative; Uncertainties and source quality.'
  ].join(' ');
  try {
    const output = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [{ role: 'system', content: system }, { role: 'user', content: 'Analyze this trading record and evidence. Be candid, detailed and source-aware.\n\n' + context }],
      max_tokens: 2600, temperature: 0.25
    });
    const review = typeof output === 'string' ? output : output?.response || output?.result?.response || JSON.stringify(output);
    return json(200, { ok: true, model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', generatedAt: new Date().toISOString(), symbol, research, review, source: 'cloudflare-workers-ai' }, request);
  } catch (error) {
    return json(502, { error: 'Workers AI mentor review failed.', detail: String(error?.message || error).slice(0, 240) }, request);
  }
}

export function createPagesApiHandler({ marketProvider = provider, bitgetCfdProvider = createBitgetCfdProvider(), now = () => new Date(), fetchImpl = fetch } = {}) {
  return async function onRequest({ request, env = {} }) {
    const url = new URL(request.url);
    if (url.href.length > MAX_URL_LENGTH) return json(414, { error: 'Request URL is too long.' }, request);

    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('Origin');
      const sameOrigin = (() => { try { return origin && new URL(origin).origin === url.origin; } catch { return false; } })();
      const allowedOrigin = sameOrigin || ['capacitor://localhost', 'https://localhost', 'http://localhost'].includes(origin);
      const headers = {
        allow: 'GET, HEAD, POST, OPTIONS',
        'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization, x-jpti-api-token',
        'cache-control': 'no-store'
      };
      if (allowedOrigin) {
        headers['access-control-allow-origin'] = origin;
        headers.vary = 'Origin';
      }
      return new Response(null, { status: 204, headers });
    }
    if (url.pathname.replace(/\/+$/, '') === '/api/journal/entries') {
      if (!['GET', 'HEAD', 'POST'].includes(request.method)) return json(405, { error: 'Journal route supports GET and POST only.' }, request, { allow: 'GET, HEAD, POST, OPTIONS' });
      if (request.method === 'HEAD') return json(200, { status: 'available' }, request);
      return handleJournalRoute(request, env, url);
    }
    const sessionPath = url.pathname.replace(/\/+$/, '');
    if (sessionPath === '/api/session/memory' || sessionPath === '/api/session/memory/batch') {
      if (!['GET', 'POST'].includes(request.method)) return json(405, { error: 'Session memory supports GET and POST only.' }, request, { allow: 'GET, POST, OPTIONS' });
      return handleSessionMemoryRoute(request, env, url);
    }
    if (url.pathname.replace(/\/+$/, '') === '/api/alpha/gainz/outcomes') {
      if (!['GET', 'POST'].includes(request.method)) return json(405, { error: 'GainzAlpha outcomes support GET and POST only.' }, request, { allow: 'GET, POST, OPTIONS' });
      return handleGainzOutcomesRoute(request, env, url);
    }
    if (url.pathname === '/api/mentor/analyze') {
      if (request.method !== 'POST') return json(405, { error: 'Mentor analysis supports POST only.' }, request, { allow: 'POST, OPTIONS' });
      return handleMentorRoute(request, env, fetchImpl);
    }

    if (!['GET', 'HEAD'].includes(request.method)) {
      return json(405, { error: 'This Cloudflare edge API currently accepts read-only requests.' }, request, { allow: 'GET, HEAD, OPTIONS' });
    }

    const isMarketDataRoute =
      /^\/api\/exchanges\/[^/]+\/(?:markets|ticker\/[^/]+|ohlcv\/[^/]+)(?:\/|$)/i.test(url.pathname) ||
      /^\/api\/exchanges\/compare\/ticker$/i.test(url.pathname) ||
      /^\/api\/intelligence\/market\/[^/]+\/[^/]+\/context$/i.test(url.pathname);
    const marketRouteKey = url.pathname + url.search;
    if (isMarketDataRoute) {
      const cached = await readMarketCache(env, marketRouteKey);
      if (cached) {
        return json(cached.status, cached.body, request, { 'x-jpti-cache': 'hit', 'x-jpti-runtime': 'cloudflare-edge' });
      }
    }

    if (url.pathname.replace(/\/+$/, '') === '/api/storage/health') {
      const missing = [];
      if (!env.JPTI_DB) missing.push('JPTI_DB');
      if (!env.JPTI_KV) missing.push('JPTI_KV');
      if (missing.length) {
        return json(503, { status: 'degraded', service: 'JPTI Cloudflare storage', missingBindings: missing }, request);
      }
      try {
        const result = await env.JPTI_DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'jpti_%' ORDER BY name").all();
        const tables = (result?.results || []).map((row) => row.name);
        const requiredTables = ['jpti_events', 'jpti_outbox', 'jpti_scheduler_leases', 'jpti_schema_migrations', 'jpti_sync_cursors', 'jpti_journal_entries'];
        const missingTables = requiredTables.filter((name) => !tables.includes(name));
        const snapshotIndex = await env.JPTI_DB.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?"
        ).bind('jpti_events_market_snapshot_lookup').first();
        const missingIndexes = snapshotIndex ? [] : ['jpti_events_market_snapshot_lookup'];
        // A read-only KV lookup exercises the binding without creating a public write surface.
        await env.JPTI_KV.get('jpti:system:health');
        const healthy = missingTables.length === 0 && missingIndexes.length === 0;
        return json(healthy ? 200 : 503, {
          status: healthy ? 'ok' : 'migration-required',
          service: 'JPTI Cloudflare storage',
          d1: { connected: true, tables, missingTables, indexes: snapshotIndex ? [snapshotIndex.name] : [], missingIndexes },
          kv: { connected: true, operation: 'read' },
          timestamp: now().toISOString()
        }, request);
      } catch (error) {
        return json(503, {
          status: 'degraded',
          service: 'JPTI Cloudflare storage',
          error: 'Cloudflare storage health check failed.',
          detail: String(error?.message || error).slice(0, 240)
        }, request);
      }
    }

    if (url.pathname.replace(/\/+$/, '') === '/api/health') {
      return json(200, {
        status: 'ok',
        service: 'JPTI Cloudflare Edge Market Data',
        mode: 'cloudflare-edge',
        source: 'cloudflare-edge',
        directMode: true,
        liveTradingEnabled: false,
        capabilities: {
          publicMarketCatalog: true,
          publicTicker: true,
          publicCandlesticks: true,
          crossVenuePublicTicker: true,
          bitgetProductTypes: ['spot', 'margin', 'futures', 'coin-futures', 'usdc-futures', 'cfd'],
          bitgetCfd: true,
          bitgetCfdConfigured: Boolean(env.JPTI_BITGET_API_KEY && env.JPTI_BITGET_API_SECRET && (env.JPTI_BITGET_API_PASSPHRASE || env.JPTI_BITGET_PASSWORD)),
          bitgetCfdRequiresCloudflareSecrets: true,
          privateAccounts: false,
          orderExecution: false,
          durablePortfolioLedger: false,
          serverBackedAdvancedAnalytics: false
        },
        exchanges: DIRECT_EXCHANGES,
        timestamp: now().toISOString()
      }, request);
    }

    const requestedType = String(url.searchParams.get('type') || 'spot').toLowerCase();
    const supportedBitgetTypes = ['spot', 'margin', 'futures', 'perpetual', 'coin-futures', 'usdc-futures', 'usdt-m', 'usdt-m-futures', 'usdt-futures', 'coin-m', 'coin-m-futures', 'usdc-m', 'usdc-m-futures', 'cfd', 'all'];
    const isExchangeMarketRoute = /\/api\/exchanges\/([a-z0-9_]+)\/(?:markets|ticker\/[^/]+|ohlcv\/[^/]+)$/i.test(url.pathname);
    const exchangeMatch = url.pathname.match(/\/api\/exchanges\/([a-z0-9_]+)\//i);
    const requestedExchange = exchangeMatch?.[1]?.toLowerCase();
    if (isExchangeMarketRoute && requestedExchange !== 'bitget' && !['spot', 'all'].includes(requestedType)) {
      return json(501, { error: 'This direct market adapter currently exposes spot markets for this exchange.', code: 'EXCHANGE_PRODUCT_TYPE_UNAVAILABLE', requestedExchange, requestedType, supportedTypes: ['spot'] }, request);
    }
    if (isExchangeMarketRoute && requestedExchange === 'bitget' && !supportedBitgetTypes.includes(requestedType)) {
      return json(400, { error: 'Unsupported Bitget market category.', code: 'BITGET_CATEGORY_UNSUPPORTED', requestedType, supportedTypes: supportedBitgetTypes }, request);
    }

    if (url.pathname === '/api/exchanges/bitget/cfd/diagnostics') {
      try {
        const result = await bitgetCfdProvider.request(env, { kind: 'diagnostics' });
        return json(result.status, result.body, request);
      } catch (error) {
        return json(error.status || 502, {
          error: error.message || 'Bitget CFD API diagnostics are unavailable.',
          code: error.code || 'BITGET_CFD_UPSTREAM_ERROR',
          upstreamStatus: error.upstreamStatus || null,
          upstreamCode: error.upstreamCode || null,
          upstreamMessage: error.upstreamMessage || null,
          upstreamContentType: error.upstreamContentType || null,
          upstreamPreview: error.upstreamPreview || null,
          exchange: 'bitget', productType: 'cfd'
        }, request);
      }
    }

    // CFD is a separate Bitget product line with its own signed UTA read-only API.
    // Never route CFD symbols through the crypto CCXT/browser-direct adapter.
    const cfdRoute = url.pathname.match(/^\/api\/exchanges\/bitget\/(markets|ticker\/([^/]+)|ohlcv\/([^/]+))$/i);
    if (cfdRoute && requestedType === 'cfd') {
      try {
        const kind = cfdRoute[1] === 'markets' ? 'markets' : cfdRoute[1].startsWith('ticker/') ? 'ticker' : 'ohlcv';
        const symbol = cfdRoute[2] || cfdRoute[3] || '';
        const result = await bitgetCfdProvider.request(env, {
          kind,
          symbol,
          timeframe: url.searchParams.get('timeframe') || '1h',
          side: url.searchParams.get('side') || 'buy',
          search: url.searchParams.get('search') || '',
          limit: url.searchParams.get('limit') || '100'
        });
        const body = { ...result.body, source: 'cloudflare-edge' };
        await cacheMarketResponse(env, marketRouteKey, result.status, body, now().toISOString());
        return json(result.status, body, request, { 'x-jpti-cache': 'miss' });
      } catch (error) {
        return json(error.status || 502, {
          error: error.message || 'Bitget CFD market data is unavailable.',
          code: error.code || 'BITGET_CFD_UPSTREAM_ERROR',
          upstreamStatus: error.upstreamStatus || null,
          upstreamCode: error.upstreamCode || null,
          upstreamMessage: error.upstreamMessage || null,
          upstreamContentType: error.upstreamContentType || null,
          upstreamPreview: error.upstreamPreview || null,
          exchange: 'bitget', productType: 'cfd'
        }, request);
      }
    }

    const contextRoute = url.pathname.match(/^\/api\/intelligence\/market\/([a-z0-9_]+)\/([^/]+)\/context$/i);
    if (contextRoute) {
      const exchange = contextRoute[1].toLowerCase();
      let symbol;
      try { symbol = decodeURIComponent(contextRoute[2]); }
      catch { return json(400, { error: 'Invalid encoded market symbol.', code: 'MARKET_SYMBOL_ENCODING_INVALID' }, request); }
      const timeframe = String(url.searchParams.get('timeframe') || '1h');
      const instrumentId = String(url.searchParams.get('instrumentId') || '').trim();
      const instrumentQuery = instrumentId ? '&instrumentId=' + encodeURIComponent(instrumentId) : '';
      const contextType = String(url.searchParams.get('type') || 'spot').toLowerCase();
      let candlesResult;
      if (exchange === 'bitget' && contextType === 'cfd') {
        try {
          candlesResult = await bitgetCfdProvider.request(env, {
            kind: 'ohlcv', symbol, timeframe, side: url.searchParams.get('side') || 'buy', limit: 200
          });
        } catch (error) {
          candlesResult = { status: error.status || 502, body: { error: error.message, code: error.code || 'BITGET_CFD_UPSTREAM_ERROR' } };
        }
      } else {
        const candleUrl = '/api/exchanges/' + exchange + '/ohlcv/' + encodeURIComponent(symbol) +
          '?timeframe=' + encodeURIComponent(timeframe) + '&limit=200&type=' + encodeURIComponent(contextType) + instrumentQuery;
        candlesResult = await marketProvider.request(candleUrl, { method: 'GET', signal: request.signal });
      }
      if (!candlesResult || candlesResult.status !== 200) {
        const snapshot = await readStoredMarketSnapshot(env, marketRouteKey);
        if (snapshot) {
          const staleBody = { ...snapshot.body, stale: true, lastUpdatedAt: snapshot.occurredAt, source: 'cloudflare-d1-stale' };
          await cacheStaleMarketResponse(env, marketRouteKey, staleBody, now().toISOString());
          return json(200, staleBody, request, { 'x-jpti-cache': 'd1-stale' });
        }
        return json(candlesResult?.status || 502, candlesResult?.body || { error: 'Market candles are unavailable for context analysis.' }, request);
      }
      const generatedAt = now().toISOString();
      const context = buildCandleContext(exchange, symbol, timeframe, candlesResult.body?.candles, generatedAt);
      if (context.status === 200) await cacheMarketResponse(env, marketRouteKey, context.status, context.body, generatedAt);
      return json(context.status, context.body, request, { 'x-jpti-cache': 'miss' });
    }

    if (url.pathname.replace(/\/+$/, '') === '/api/market/pair-scanner') {
      try {
        const rawRangePct = Number(url.searchParams.get('rangePct') || 20);
        const rangePct = Number.isFinite(rawRangePct) ? Math.min(100, Math.max(1, rawRangePct)) : 20;
        const rawMinTurnover = Number(url.searchParams.get('minTurnover') || 50000);
        const minTurnover = Number.isFinite(rawMinTurnover) ? Math.max(0, rawMinTurnover) : 50000;
        const requestedInterval = String(url.searchParams.get('timeframe') || '1h').toLowerCase();
        const intervalMap = { '15m': '15m', '1h': '1H', '4h': '4H' };
        const interval = intervalMap[requestedInterval] || '1H';
        const base = 'https://api.bitget.com/api/v3/market/';
        const get = async (path) => {
          const response = await fetch(base + path, { headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error('Bitget market endpoint returned HTTP ' + response.status);
          const payload = await response.json();
          if (payload.code && payload.code !== '00000') throw new Error(payload.msg || 'Bitget market endpoint rejected the request.');
          return payload.data;
        };
        const [tickersRaw, instrumentsRaw] = await Promise.all([
          get('tickers?category=USDT-FUTURES'),
          get('instruments?category=USDT-FUTURES')
        ]);
        const tickers = Array.isArray(tickersRaw) ? tickersRaw : [];
        const instruments = Array.isArray(instrumentsRaw) ? instrumentsRaw : [];
        const byInstrument = new Map(instruments.map(item => [item.symbol, item]));
        const reference = tickers.find(item => item.symbol === 'SOPHUSDT');
        if (!reference || !(Number(reference.lastPrice) > 0)) {
          return json(503, { error: 'SOPHUSDT is not currently available in Bitget USDT-M ticker data.', code: 'REFERENCE_CONTRACT_UNAVAILABLE' }, request);
        }
        const referencePrice = Number(reference.lastPrice);
        const minPrice = referencePrice * (1 - rangePct / 100), maxPrice = referencePrice * (1 + rangePct / 100);
        const eligible = tickers.filter(item => {
          const p = Number(item.lastPrice), turnover = Number(item.turnover24h || 0);
          return item.symbol.endsWith('USDT') && p > 0 && p >= minPrice && p <= maxPrice && turnover >= minTurnover;
        });
        if (!eligible.some(item => item.symbol === 'SOPHUSDT')) eligible.push(reference);
        const pairs = eligible.map(item => {
          const instrument = byInstrument.get(item.symbol) || {};
          const bid = Number(item.bid1Price), ask = Number(item.ask1Price);
          const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
          const price = Number(item.lastPrice);
          const mark = Number(item.markPrice || price);
          const oi = Number(item.openInterest);
          return {
            symbol: item.symbol, price, markPrice: mark,
            distancePct: Number(((price / referencePrice - 1) * 100).toFixed(3)),
            change24h: Number(item.price24hPcnt || 0) * 100,
            turnover24h: Number(item.turnover24h || 0),
            spreadPct: mid ? Number(((ask - bid) / mid * 100).toFixed(4)) : null,
            bid1Price: bid || null, ask1Price: ask || null,
            bid1Size: Number(item.bid1Size || 0), ask1Size: Number(item.ask1Size || 0),
            openInterestBase: Number.isFinite(oi) ? oi : null,
            openInterestUsd: Number.isFinite(oi) ? oi * mark : null,
            fundingRate: item.fundingRate == null ? null : Number(item.fundingRate),
            fundingInterval: Number(instrument.fundInterval || 0) || null,
            maxLeverage: Number(instrument.maxLeverage || 0) || null,
            minOrderAmount: instrument.minOrderAmount || null,
            makerFeeRate: instrument.makerFeeRate == null ? null : Number(instrument.makerFeeRate),
            takerFeeRate: instrument.takerFeeRate == null ? null : Number(instrument.takerFeeRate),
            status: instrument.status || null,
            sourceTimestamp: item.ts || null
          };
        }).sort((a,b) => b.turnover24h - a.turnover24h);
        const selected = pairs.filter(item => item.symbol !== 'SOPHUSDT').slice(0, 14);
        const correlationSymbols = ['SOPHUSDT', ...selected.map(item => item.symbol)];
        const candleResults = await Promise.all(correlationSymbols.map(async symbol => {
          try {
            const candles = await get('candles?category=USDT-FUTURES&symbol=' + encodeURIComponent(symbol) + '&interval=' + interval + '&type=market&limit=100');
            return [symbol, Array.isArray(candles) ? candles.slice(0, -1) : []];
          } catch { return [symbol, []]; }
        }));
        const candleMap = new Map(candleResults);
        const referenceCandles = candleMap.get('SOPHUSDT') || [];
        const correlations = selected.map(item => correlateCandleSeries(referenceCandles, candleMap.get(item.symbol) || [], item.symbol, interval))
          .filter(item => item.status === 'measured');
        const observationCounts = correlations.map(item => item.observations);
        return json(200, {
          generatedAt: new Date().toISOString(),
          venue: 'Bitget', category: 'USDT-FUTURES',
          reference: { symbol: 'SOPHUSDT', price: referencePrice, change24h: Number(reference.price24hPcnt || 0) * 100, turnover24h: Number(reference.turnover24h || 0) },
          filters: { rangePct, minTurnover, timeframe: interval },
          pairs,
          correlations,
          correlationMeta: { timeframe: interval, observations: observationCounts.length ? Math.min(...observationCounts) : 0, candidateCount: correlations.length, method: 'Pearson correlation of matched timestamp log returns from closed Bitget candles' },
          caveats: [
            'The candidate universe is limited to Bitget USDT perpetuals and the selected price and turnover filters.',
            'Correlation is computed from matched candle timestamps; fewer than 12 matched returns are excluded.',
            'Correlation is historical co-movement, not causation, a hedge guarantee or a forecast.',
            'Open interest value is estimated as base open interest multiplied by mark price.',
            'This scanner is public market research only; it does not place or manage orders.'
          ]
        }, request, { 'x-jpti-cache': 'miss' });
      } catch (error) {
        return json(502, { error: error.message || 'Bitget pair scanner unavailable.', code: 'PAIR_SCANNER_UPSTREAM_ERROR' }, request);
      }
    }

    const result = await marketProvider.request(url.pathname + url.search, {
      method: request.method,
      signal: request.signal
    });
    if ((!result || result.status >= 500) && isMarketDataRoute) {
      const snapshot = await readStoredMarketSnapshot(env, marketRouteKey);
      if (snapshot) {
        const staleBody = { ...snapshot.body, stale: true, lastUpdatedAt: snapshot.occurredAt, source: 'cloudflare-d1-stale' };
        await cacheStaleMarketResponse(env, marketRouteKey, staleBody, now().toISOString());
        return json(200, staleBody, request, { 'x-jpti-cache': 'd1-stale' });
      }
    }
    if (!result) {
      return json(501, {
        error: 'This endpoint is not implemented in the Cloudflare edge runtime.',
        code: 'CLOUDFLARE_EDGE_ROUTE_UNAVAILABLE',
        path: url.pathname,
        available: [
          '/api/health',
          '/api/exchanges',
          '/api/exchanges/compare/ticker',
          '/api/exchanges/:id/markets',
          '/api/exchanges/:id/ticker/:symbol',
          '/api/exchanges/:id/ohlcv/:symbol'
        ],
        note: 'Public chart data is available without an external API gateway. Private trading and persistent server services require separate Cloudflare-native implementations.'
      }, request);
    }

    const body = { ...result.body, source: 'cloudflare-edge' };
    if (isMarketDataRoute && result.status >= 200 && result.status < 300) {
      await cacheMarketResponse(env, marketRouteKey, result.status, body, now().toISOString());
    }
    return json(result.status, body, request, isMarketDataRoute ? { 'x-jpti-cache': 'miss' } : {});
  };
}

const handler = createPagesApiHandler();
export async function onRequest(context) {
  return handler(context);
}
