import test from 'node:test';
import assert from 'node:assert/strict';
import { createPagesApiHandler } from './api/[[path]].js';

test('Pages API uses the same-origin Cloudflare runtime without an upstream URL', async () => {
  const handler = createPagesApiHandler();
  const response = await handler({ request: new Request('https://jpti.pages.dev/api/health') });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, 'cloudflare-edge');
  assert.equal(body.source, 'cloudflare-edge');
});
