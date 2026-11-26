// Single source of truth for private-route token authorisation on Cloudflare Pages Functions.
//
// Why this exists: several routes each carried their own copy of this check and they had drifted.
// Only one trimmed whitespace, so a Cloudflare secret saved with a trailing newline or space
// (very common when pasting) made every other private route return 401 even for the correct token,
// because the browser client always sends a trimmed value and HTTP stacks strip header whitespace.
// Every private route now normalises identically and compares in constant time.

const DEFAULT_UNCONFIGURED = 'Set the JPTI_JOURNAL_TOKEN Cloudflare secret to enable private JPTI routes.';
const DEFAULT_REJECTED = 'Private JPTI authorization failed.';

export const normaliseToken = (value) => String(value ?? '').trim();

// JPTI_JOURNAL_TOKEN wins; JPTI_API_TOKEN is the documented fallback. A blank or whitespace-only
// primary value falls through to the fallback instead of masking it.
export function configuredToken(env) {
  return normaliseToken(env?.JPTI_JOURNAL_TOKEN) || normaliseToken(env?.JPTI_API_TOKEN);
}

// Accepts the x-jpti-api-token header or "Authorization: Bearer <token>", in that order.
export function providedToken(request) {
  const header = normaliseToken(request?.headers?.get('x-jpti-api-token'));
  if (header) return header;
  const authorization = request?.headers?.get('authorization');
  return normaliseToken(authorization ? authorization.replace(/^Bearer\s+/i, '') : '');
}

const sha256 = async (value) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));

// Compares fixed-length SHA-256 digests so timing never depends on where the values differ or on length.
export async function tokensEqual(expected, provided) {
  const [left, right] = await Promise.all([sha256(expected), sha256(provided)]);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

// Resolves to { ok: true } or { ok: false, status, error }.
//   503  no secret is configured on the server (fails closed, never a silent pass)
//   401  a secret exists and the supplied token does not match
// `unconfigured` / `rejected` let each route keep its own established wording.
export async function verifyPrivateToken(request, env, { unconfigured = DEFAULT_UNCONFIGURED, rejected = DEFAULT_REJECTED } = {}) {
  const expected = configuredToken(env);
  if (!expected) return { ok: false, status: 503, error: unconfigured };
  return (await tokensEqual(expected, providedToken(request))) ? { ok: true } : { ok: false, status: 401, error: rejected };
}
