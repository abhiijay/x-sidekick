/* Service worker: caches the app shell so the app opens instantly and offline.
 * Works wherever the app is hosted (GitHub Pages or the sidekick server),
 * because every path is relative to this worker's scope.
 * API calls go to the sidekick server (another origin on GitHub Pages) and
 * are never cached. */
const CACHE = 'sidekick-v7';
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
  // Cache first, refreshed in the background: on a weak phone over mobile data
  // the app opens from cache at once instead of waiting on the network (it
  // reloads often, because Android kills it behind LinkedIn). A new version
  // lands on the next open. Share launches carry query params: never cache
  // those, serve the shell.
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(url.search ? 'index.html' : e.request, { ignoreSearch: !!url.search });
    const net = url.search && hit ? null : fetch(e.request).then((res) => {
      if (res.ok && !url.search) c.put(e.request, res.clone());
      return res;
    });
    if (hit) { if (net) e.waitUntil(net.catch(() => {})); return hit; }
    return net.catch(() => c.match('index.html'));
  }));
});
