#!/usr/bin/env node
// Post-deploy, read-only report of whether private routes can work on each public JPTI address.
// It warns instead of failing, and never prints the token.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const originOf = (value) => { try { const url = new URL(String(value || '').trim()); return url.protocol === 'https:' ? url.origin : null; } catch { return null; } };

export async function verifyPrivateAuth({ deployUrl, pagesUrl, token = '', fetchImpl = fetch }) {
  const deployed = originOf(deployUrl);
  const published = originOf(pagesUrl);
  const warnings = [];
  if (deployed && published && deployed !== published) {
    warnings.push('This workflow deploys ' + deployed + ' but CLOUDFLARE_PAGES_URL (used by the Android build) is ' + published + '. They are separate Cloudflare Pages addresses, each with its own secrets; confirm which one you use.');
  }
  const sites = [];
  for (const origin of [...new Set([deployed, published].filter(Boolean))]) {
    const site = { origin, secretConfigured: null, token: 'not-checked' };
    try {
      const health = await (await fetchImpl(origin + '/api/health', { signal: AbortSignal.timeout(20000) })).json();
      site.secretConfigured = Boolean(health?.capabilities?.journalAuthConfigured);
      if (!site.secretConfigured) warnings.push(origin + ' has no JPTI_JOURNAL_TOKEN secret, so every private panel will fail there.');
      else if (token.trim()) {
        const check = await fetchImpl(origin + '/api/auth/check', { headers: { 'x-jpti-api-token': token.trim() }, redirect: 'error', signal: AbortSignal.timeout(20000) });
        site.token = check.status === 200 ? 'accepted' : check.status === 401 ? 'rejected' : 'http-' + check.status;
        if (site.token !== 'accepted') warnings.push(origin + ' did not accept the JPTI token stored in GitHub (' + site.token + ').');
      }
    } catch (error) {
      warnings.push(origin + ' could not be checked: ' + String(error?.message || error).slice(0, 160));
    }
    sites.push(site);
  }
  return { sites, warnings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await verifyPrivateAuth({ deployUrl: process.env.JPTI_DEPLOY_URL, pagesUrl: process.env.JPTI_PAGES_URL, token: process.env.JPTI_JOURNAL_TOKEN || '' });
  for (const warning of report.warnings) console.log('::warning title=JPTI private access::' + warning);
  console.log(JSON.stringify(report.sites, null, 2));
}
