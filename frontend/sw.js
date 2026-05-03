const CACHE = 'caisse-tc-v6';
const OFFLINE_URLS = [
  '/manifest.json'
];

// HTML jamais mis en cache — toujours réseau pour avoir la dernière version
const NO_CACHE_URLS = ['/', '/index.html', '/dashboard.html', '/sw.js'];

// Only cache http/https requests (exclude chrome-extension://, data:, etc.)
function isCacheable(url) {
  return url.startsWith('http://') || url.startsWith('https://');
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(OFFLINE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (!isCacheable(e.request.url)) return;

  const url = new URL(e.request.url);

  // API + HTML : réseau uniquement, jamais en cache
  if (url.pathname.startsWith('/api/') ||
      NO_CACHE_URLS.some(p => url.pathname === p || url.pathname === p + '')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        url.pathname.startsWith('/api/')
          ? new Response(JSON.stringify({ error: 'Hors ligne' }), {
              status: 503, headers: { 'Content-Type': 'application/json' }
            })
          : caches.match('/index.html')
      )
    );
    return;
  }

  // Assets statiques (JS, CSS, images) : réseau en priorité, cache en fallback
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
