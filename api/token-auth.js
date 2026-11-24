import { timingSafeEqual } from 'node:crypto';

// Constant-time comparison so response timing cannot be used to recover the API token.
export function tokensMatch(expected, provided) {
  if (typeof expected !== 'string' || !expected || typeof provided !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) {
    // Compare against itself to keep the work comparable, then reject.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

// Reads the API token from the x-jpti-api-token header or an "Authorization: Bearer <token>"
// header. Every private route must use this one extractor so they all accept the same forms.
export function requestApiToken(req) {
  const header = req.get('x-jpti-api-token');
  if (header) return header;
  const authorization = req.get('authorization');
  return authorization ? authorization.replace(/^Bearer\s+/i, '') : undefined;
}
