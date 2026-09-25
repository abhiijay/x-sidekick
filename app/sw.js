/* Service worker: caches the app shell so the app opens instantly and offline.
 * API calls (/api/*) always go to the network - queue data is never cached. */
const CACHE = 'sidekick-v1';
const SHELL = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith('/app')) return;
  // Share-target launches (/app/share?...) get the cached index page.
  const key = url.pathname.startsWith('/app/share') ? 'index.html' : e.request;
  // Network first so updates land; cache as the offline fallback.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && !url.pathname.startsWith('/app/share')) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(key, { ignoreSearch: true }))
  );
});
