const CACHE = 'caisse-tc-v4';
const OFFLINE_URLS = [
  '/',
  '/index.html',
  '/dashboard.html',
  '/manifest.json'
];

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
  // Ignore non-http(s) requests (chrome-extension://, etc.)
  if (!isCacheable(e.request.url)) return;

  if (e.request.url.includes('/api/')) {
    // API: network first, fallback to cache
    e.respondWith(
      fetch(e.request.clone())
        .then(res => {
          if (res.ok && e.request.method === 'GET') {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request).then(cached => cached || new Response(JSON.stringify({ error: 'Hors ligne' }), { status: 503, headers: { 'Content-Type': 'application/json' } })))
    );
  } else {
    // Static assets: network first to always get latest, fallback to cache
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request).then(cached => cached || caches.match('/index.html')))
    );
  }
});
