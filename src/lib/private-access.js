// Explains why a private panel could not load, using what the browser actually knows.
export function describePrivateFailure(status, payload = {}, hasToken = false) {
  const code = Number(status);
  const serverMessage = payload?.error || 'Request failed (HTTP ' + code + ').';
  if (code === 401 && !hasToken) {
    return { kind: 'missing', needsSettings: true, message: 'This browser session has no access token. Open Connection Settings, enter your JPTI_JOURNAL_TOKEN and choose Verify access token.' };
  }
  if (code === 401) {
    return { kind: 'rejected', needsSettings: true, message: serverMessage + ' The token in this browser session does not match the secret on this deployment (' + deploymentHost() + '). Re-enter it in Connection Settings.' };
  }
  if ((code === 503 || code === 409) && /token|secret/i.test(serverMessage) && !/D1|binding/i.test(serverMessage)) {
    return { kind: 'unconfigured', needsSettings: false, message: serverMessage + ' Add it to the Cloudflare Pages project serving ' + deploymentHost() + ', then redeploy.' };
  }
  return { kind: 'error', needsSettings: false, message: serverMessage };
}

function deploymentHost() {
  return (typeof window !== 'undefined' && window.location?.host) || 'this site';
}
