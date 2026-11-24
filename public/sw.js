const APP_BASE = new URL('./', self.registration.scope);
const CACHE = 'jpti-shell-v3';
const SHELL = [
  APP_BASE.href,
  new URL('manifest.webmanifest', APP_BASE).href,
  new URL('jpti-icon.svg', APP_BASE).href
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key.startsWith('jpti-shell-') && key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  const basePath = APP_BASE.pathname;
  if (!url.pathname.startsWith(basePath)) return;
  const relativePath = url.pathname.slice(basePath.length);
  if (relativePath.startsWith('api/') || relativePath.startsWith('t-bots/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) void caches.open(CACHE).then((cache) => cache.put(APP_BASE.href, response.clone()));
      return response;
    }).catch(async () => (await caches.match(APP_BASE.href)) || Response.error()));
    return;
  }

  if (relativePath.startsWith('assets/') || ['jpti-icon.svg','manifest.webmanifest'].includes(relativePath)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) void caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
      return response;
    })));
  }
});
