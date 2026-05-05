const CACHE = 'caisse-tc-v8';
const OFFLINE_HTML = new Response(
  '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Hors ligne</title></head><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><p style="font-size:1.2rem;color:#475569">Connexion indisponible</p><p style="color:#94a3b8">Vérifiez votre réseau puis <a href="/" style="color:#1A50D9">rechargez</a>.</p></div></body></html>',
  { status: 503, headers: { 'Content-Type': 'text/html; charset=UTF-8' } }
);
const OFFLINE_JSON = new Response(
  JSON.stringify({ error: 'Hors ligne' }),
  { status: 503, headers: { 'Content-Type': 'application/json' } }
);

// HTML jamais mis en cache — toujours réseau pour avoir la dernière version
const NO_CACHE_URLS = ['/', '/index.html', '/dashboard.html', '/sw.js'];

// Only cache http/https requests (exclude chrome-extension://, data:, etc.)
function isCacheable(url) {
  return url.startsWith('http://') || url.startsWith('https://');
}

function offlineResponse(isApi) {
  return isApi ? OFFLINE_JSON.clone() : OFFLINE_HTML.clone();
}

self.addEventListener('install', (e) => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (!isCacheable(e.request.url)) return;

  const url = new URL(e.request.url);
  const isApi  = url.pathname.startsWith('/api/');
  const isHtml = NO_CACHE_URLS.some(p => url.pathname === p);

  // API + HTML : réseau uniquement, fallback offline propre
  if (isApi || isHtml) {
    e.respondWith(
      fetch(e.request).catch(() => offlineResponse(isApi))
    );
    return;
  }

  // Assets statiques : réseau en priorité, cache en fallback, offline 503 si rien
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() =>
        caches.match(e.request).then(cached => cached || offlineResponse(false))
      )
  );
});
