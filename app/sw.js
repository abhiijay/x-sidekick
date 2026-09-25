/* Service worker: caches the app shell so the app opens instantly and offline.
 * Works wherever the app is hosted (GitHub Pages or the sidekick server),
 * because every path is relative to this worker's scope.
 * API calls go to the sidekick server (another origin on GitHub Pages) and
 * are never cached. */
const CACHE = 'sidekick-v2';
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
  const scope = new URL(self.registration.scope).pathname;
  if (e.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith(scope)) return;
  if (url.pathname.startsWith(scope + 'api/')) return;
  // Network first so updates land; cache as the offline fallback.
  // Share launches carry query params: never cache those, fall back to the shell.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && !url.search) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(url.search ? 'index.html' : e.request, { ignoreSearch: true }))
  );
});
