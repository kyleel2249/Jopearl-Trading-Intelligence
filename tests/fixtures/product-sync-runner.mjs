import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLSelectElement', 'Node', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
// Offline gateway: the product selector must behave correctly without any backend.
globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: 'offline' }), text: async () => '' });
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.EventSource = class { close() {} addEventListener() {} };
globalThis.WebSocket = class { constructor() { setTimeout(() => this.onerror && this.onerror(new Error('offline')), 0); } close() {} send() {} };

const { run } = await import(process.argv[2]);
const outcome = await run();
process.stdout.write('RESULT:' + JSON.stringify(outcome));
process.exit(0);
