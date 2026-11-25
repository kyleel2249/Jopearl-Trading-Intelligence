import { runOrganizationPulse } from '../functions/organization-intelligence.js';

export default {
  async scheduled(controller, env, context) {
    context.waitUntil(runOrganizationPulse({ env }).catch(error => {
      console.error('[JPTI department scheduler] Daily intelligence pulse failed:', error?.message || error);
      throw error;
    }));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/health') return new Response('Not found', { status: 404 });
    return Response.json({
      service: 'JPTI autonomous department scheduler',
      status: env.JPTI_DB && env.AI ? 'ready' : 'degraded',
      d1: Boolean(env.JPTI_DB),
      workersAI: Boolean(env.AI),
      schedule: 'Every 6 hours; one idempotent daily pulse with retries for partial or stale runs.'
    }, { headers: { 'cache-control': 'no-store' } });
  }
};
