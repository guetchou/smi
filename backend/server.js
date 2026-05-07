const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./database');
const { router: authRouter, requireAuth, hasRole } = require('./routes/auth');
const operationsRouter  = require('./routes/operations');
const usersRouter       = require('./routes/users');
const salairesRouter    = require('./routes/salaires');
const agentsRouter      = require('./routes/agents');
const entrepriseRouter  = require('./routes/entreprise');
const achatsRouter      = require('./routes/achats');

const app = express();
const PORT = process.env.PORT || 3337;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// HTML et SW : jamais mis en cache (CDN, proxy, navigateur)
const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' };
['/', '/index.html', '/dashboard.html', '/sw.js'].forEach(route => {
  const file = route === '/' ? 'index.html' : route.slice(1);
  app.get(route, (req, res) => {
    Object.entries(NO_STORE).forEach(([k, v]) => res.setHeader(k, v));
    res.sendFile(path.join(__dirname, '..', 'frontend', file));
  });
});

// ── /sw-kill : débloque les navigateurs bloqués sur un ancien Service Worker ──
// Visite cette URL → efface tous les SW + caches → redirige vers /
app.get('/sw-kill', (req, res) => {
  Object.entries(NO_STORE).forEach(([k, v]) => res.setHeader(k, v));
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Nettoyage…</title></head><body>
<p style="font-family:sans-serif;padding:20px">Nettoyage du cache en cours…</p>
<script>
(async () => {
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map(r => r.unregister()));
  }
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));
  window.location.replace('/');
})();
</script></body></html>`);
});

// Serve static frontend (JS, CSS, images — peuvent être cachés)
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Serve uploaded photos + assets entreprise
app.use('/uploads', express.static(path.join(__dirname, 'data', 'uploads')));

// ── Middleware last_seen : met à jour last_seen_at à chaque requête auth ───────
// Throttle : une écriture DB max par 30 secondes par user (évite le flood)
const _lastSeenCache = new Map();
function updateLastSeen(req) {
  if (!req.user?.id) return;
  const uid = req.user.id;
  const now = Date.now();
  if (_lastSeenCache.has(uid) && now - _lastSeenCache.get(uid) < 30_000) return;
  _lastSeenCache.set(uid, now);
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
           || req.socket?.remoteAddress
           || null;
  try {
    db.prepare("UPDATE users SET last_seen_at = datetime('now'), last_ip = ? WHERE id = ?")
      .run(ip, uid);
  } catch (_) { /* non-bloquant */ }
}

// Toutes les réponses API : jamais mises en cache (CDN, proxy, SW)
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
});

// API Routes
app.use('/api/auth', authRouter);

// Toutes les routes protégées : last_seen mis à jour après requireAuth
app.use('/api/operations', requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, operationsRouter);
app.use('/api/config',     requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, usersRouter);
app.use('/api/salaires',   requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, salairesRouter);
app.use('/api/agents',     requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, agentsRouter);
app.use('/api/entreprise', requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, entrepriseRouter);
app.use('/api/achats',    requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, achatsRouter);

// ── Admin : utilisateurs connectés ────────────────────────────────────────────
app.get('/api/admin/connected-users', requireAuth, (req, res) => {
  if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis' });
  updateLastSeen(req);

  const users = db.prepare(`
    SELECT id, nom, email, role, sous_role, actif,
           last_seen_at, last_ip
    FROM users
    WHERE actif = 1
    ORDER BY last_seen_at DESC NULLS LAST
  `).all();

  const now = new Date();
  const result = users.map(u => {
    let statut = 'offline';
    if (u.last_seen_at) {
      const diffMin = (now - new Date(u.last_seen_at)) / 60000;
      if (diffMin <= 5)        statut = 'online';
      else if (diffMin <= 15)  statut = 'idle';
    }
    return { ...u, statut };
  });

  res.json(result);
});

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// SPA fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Route API introuvable' });
  if (path.extname(req.path)) return res.status(404).send('Not found');

  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Tala SMI — Système de Management Intégré (port ${PORT})`);
  console.log(`   Développé par Gess GALOYI · TOP CENTER`);
  console.log(`   Admin: admin@topcenter.cg / Admin@2025!`);
});
