import { runOrganizationPulse } from '../functions/organization-intelligence.js';
import { runFoundationPulse } from '../functions/intelligence-foundation.js';

export default {
  async scheduled(controller, env, context) {
    context.waitUntil((async () => {
      const organisation = await Promise.allSettled([runOrganizationPulse({ env })]);
      if (organisation[0].status === 'rejected') console.error('[JPTI intelligence scheduler] Department pulse failed:', organisation[0].reason?.message || organisation[0].reason);
      const foundation = await Promise.allSettled([runFoundationPulse({ env })]);
      if (foundation[0].status === 'rejected') console.error('[JPTI intelligence scheduler] Foundation pulse failed:', foundation[0].reason?.message || foundation[0].reason);
      if (organisation[0].status === 'rejected' && foundation[0].status === 'rejected') throw new Error('Both JPTI scheduled intelligence pulses failed.');
    })());
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
