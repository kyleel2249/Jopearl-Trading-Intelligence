// Maps a /api/auth/check response onto one clear, actionable outcome for the Connection Settings screen.
// Kept free of React so it can be unit-tested and reused by any panel that needs to explain a 401.
export function describeTokenCheck(status, payload = {}) {
  const code = Number(status);
  if (code >= 200 && code < 300 && payload?.authorised === true) {
    return { kind: 'ok', message: 'Token accepted. Private agent, department and journal panels are unlocked for this browser session.' };
  }
  if (code === 401) {
    return { kind: 'rejected', message: 'The server rejected this token. Re-copy the JPTI_JOURNAL_TOKEN secret value exactly, with no quotes or spaces, then verify again.' };
  }
  if (code === 409) {
    return { kind: 'unconfigured', message: 'This deployment has no JPTI_JOURNAL_TOKEN secret yet. Add it as an encrypted Cloudflare Pages secret, redeploy, then verify again.' };
  }
  return { kind: 'error', message: payload?.error || 'Token check failed (HTTP ' + code + '). Try again shortly.' };
}
