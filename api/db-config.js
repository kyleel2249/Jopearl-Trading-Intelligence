import { readFileSync } from 'node:fs';

// Single source of truth for how JPTI connects to PostgreSQL (including Supabase).
// storage.js and scheduler-lease.js previously each built their own SSL settings, and
// neither could trust Supabase's private CA. Both now call buildPoolConfig().

const PEM_MARKER = '-----BEGIN';

function normalizePem(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  // Dashboards that cannot hold multi-line values store the PEM with literal \n sequences.
  const unescaped = text.replace(/\\n/g, '\n');
  if (unescaped.includes(PEM_MARKER)) return unescaped;
  // Otherwise accept a base64-encoded PEM.
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    if (decoded.includes(PEM_MARKER)) return decoded;
  } catch { /* fall through */ }
  throw new Error('JPTI_DATABASE_SSL_CA must be a PEM certificate (literal \\n allowed) or a base64-encoded PEM.');
}

export function loadDatabaseCa(env = process.env) {
  if (env.JPTI_DATABASE_SSL_CA) return normalizePem(env.JPTI_DATABASE_SSL_CA);
  if (env.JPTI_DATABASE_SSL_CA_FILE) {
    const pem = readFileSync(env.JPTI_DATABASE_SSL_CA_FILE, 'utf8');
    if (!pem.includes(PEM_MARKER)) throw new Error('JPTI_DATABASE_SSL_CA_FILE does not contain a PEM certificate.');
    return pem;
  }
  return '';
}

export function resolveDatabaseSsl(env = process.env) {
  if (String(env.JPTI_DATABASE_SSL || '').toLowerCase() !== 'true') return false;
  const ssl = { rejectUnauthorized: env.JPTI_DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' };
  const ca = loadDatabaseCa(env);
  if (ca) ssl.ca = ca;
  return ssl;
}

// Describes the target without ever returning the password.
export function describeDatabaseUrl(url, env = process.env) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return { valid: false, warnings: ['DATABASE_URL is not a valid URL. URL-encode special characters in the password.'] }; }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) return { valid: false, warnings: ['DATABASE_URL must start with postgresql:// or postgres://'] };
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port || '5432';
  const user = decodeURIComponent(parsed.username || '');
  const pooler = /\.pooler\.supabase\.com$/.test(host);
  const direct = /^db\.[a-z0-9]+\.supabase\.co$/.test(host);
  const supabase = pooler || direct || /\.supabase\.(co|com)$/.test(host);
  let mode = 'other';
  if (supabase) mode = pooler ? (port === '6543' ? 'supabase-transaction-pooler' : 'supabase-session-pooler') : (port === '6543' ? 'supabase-dedicated-pooler' : 'supabase-direct');
  const warnings = [];
  if (supabase && String(env.JPTI_DATABASE_SSL || '').toLowerCase() !== 'true') warnings.push('Supabase requires TLS: set JPTI_DATABASE_SSL=true.');
  if (pooler && !user.includes('.')) warnings.push('Supabase pooler logins use postgres.<project-ref>, not plain "postgres".');
  if (direct && port === '5432') warnings.push('Supabase direct connections are IPv6-only on the free plan; use the session pooler from IPv4-only hosts such as an IPv4-only hosting environment.');
  if (mode === 'supabase-transaction-pooler') warnings.push('Transaction pooler works for JPTI queries (no prepared statements are used), but the session pooler (port 5432) is the better fit for a long-running API.');
  if (parsed.searchParams.has('sslmode')) warnings.push('Remove sslmode from DATABASE_URL: the driver can let it override JPTI_DATABASE_SSL settings. Configure TLS with the JPTI_DATABASE_SSL* variables instead.');
  return { valid: true, provider: supabase ? 'supabase' : 'postgres', mode, host, port: Number(port), database: parsed.pathname.replace(/^\//, '') || 'postgres', user, warnings };
}

export function buildPoolConfig({ max, applicationName, env = process.env } = {}) {
  const queryTimeout = Number(env.JPTI_DATABASE_QUERY_TIMEOUT_MS);
  return {
    connectionString: env.DATABASE_URL,
    ssl: resolveDatabaseSsl(env),
    max: Math.max(1, Math.min(20, Number(max) || 10)),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    // Client-side only: server-side startup parameters are rejected by some poolers.
    query_timeout: Number.isFinite(queryTimeout) && queryTimeout > 0 ? queryTimeout : 60000,
    keepAlive: true,
    application_name: applicationName || 'jpti-trading-intelligence'
  };
}

// Supabase exposes every table in the public schema through its Data API, using the
// public anon key. JPTI only ever reaches these tables through its own server-side
// connection, so row level security is enabled on every jpti_* table with no policies
// (which denies anon/authenticated entirely) and their direct privileges are revoked.
// The server connects as the table owner, which is not subject to these rules.
// Idempotent: only tables that do not yet have RLS enabled are touched.
export const ENFORCE_RLS_SQL = `
DO $jpti$
DECLARE
  tbl text;
  api_roles text;
BEGIN
  SELECT string_agg(quote_ident(rolname), ', ') INTO api_roles
    FROM pg_roles WHERE rolname IN ('anon', 'authenticated');
  FOR tbl IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'jpti\\_%' ESCAPE '\\' AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    IF api_roles IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %s', tbl, api_roles);
    END IF;
  END LOOP;
END
$jpti$;
`;

export async function enforceRowLevelSecurity(db, log = console) {
  try {
    await db.query(ENFORCE_RLS_SQL);
    return true;
  } catch (error) {
    log.warn('JPTI could not enforce row level security on jpti_* tables (' + error.message + '). On Supabase, run migrations/004_supabase_rls.sql as the postgres role.');
    return false;
  }
}
