/* T3L Member Portal — service worker (installable PWA + offline app shell).
   Scope: /portals/. Auth and data (the Supabase edge function, cross-origin)
   are never cached — only the static shell and assets. */
const CACHE = 't3l-portal-v1';
const SHELL = [
  '/portals/client.html',
  '/portals/login.html',
  '/portals/auth.js',
  '/portals/manifest.webmanifest',
  '/portals/icons/icon-192.png',
  '/portals/icons/icon-512.png',
  '/assets/img/t3l-logo.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Only handle our own origin; never touch the auth/data API or CDNs.
  if (url.origin !== location.origin) return;
  if (url.pathname.indexOf('/functions/v1/') !== -1) return;

  // Page navigations: network-first, fall back to the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })
        .catch(() => caches.match(req).then((m) => m || caches.match('/portals/client.html')))
    );
    return;
  }

  // Same-origin static assets: cache-first, then network (and fill the cache).
  event.respondWith(
    caches.match(req).then((cached) =>
      cached || fetch(req).then((res) => {
        if (res && res.status === 200) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => cached)
    )
  );
});
