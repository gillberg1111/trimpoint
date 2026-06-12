// TrimPoint service worker — minimal offline shell.
// network-first everywhere; cache fallback when offline. Never caches redirects
// (login flow) or non-OK responses. API fallback is read-only and limited to
// config + history so the dashboard can render with last-known data offline.
const CACHE = 'trimpoint-v1';
const STATIC = ['/favicon.svg', '/apple-touch-icon.png', '/manifest.webmanifest'];
const API_FALLBACK = ['/api/config', '/api/history'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') && !API_FALLBACK.includes(url.pathname)) return;
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r.ok && r.type === 'basic' && !r.redirected) {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return r;
    }).catch(() =>
      caches.match(e.request, { ignoreSearch: e.request.mode === 'navigate' })
        .then((m) => m || (e.request.mode === 'navigate' ? caches.match('/') : undefined))
        .then((m) => m || Response.error())
    )
  );
});
