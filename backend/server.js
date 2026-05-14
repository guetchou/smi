const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const { router: authRouter, requireAuth, hasRole } = require('./routes/auth');
const operationsRouter  = require('./routes/operations');
const usersRouter       = require('./routes/users');
const accessRouter      = require('./routes/access');
const salairesRouter    = require('./routes/salaires');
const agentsRouter      = require('./routes/agents');
const entrepriseRouter  = require('./routes/entreprise');
const achatsRouter      = require('./routes/achats');
const notifsRouter      = require('./routes/notifs');
const clientsRouter          = require('./routes/clients');
const devisRouter            = require('./routes/devis');
const facturesClientsRouter  = require('./routes/factures_clients');
const produitsRouter         = require('./routes/produits');
const contratsRouter         = require('./routes/contrats');
const rapprochementsRouter   = require('./routes/rapprochements');
const { router: orgRouter } = require('./routes/organigramme');
const grillesRouter          = require('./routes/grilles');
const revisionsSalaireRouter = require('./routes/revisions_salaire');
const { router: periodesRouter } = require('./routes/periodes_paie');
const sanctionsRouter            = require('./routes/sanctions');
const offboardingRouter          = require('./routes/offboarding');
const heuresSupRouter            = require('./routes/heures_sup');
const calendrierFiscalRouter     = require('./routes/calendrier_fiscal');
const notifSvc          = require('./services/notif');
const rateLimit         = require('express-rate-limit');
const helmet            = require('helmet');

const app = express();
const PORT = process.env.PORT || 3337;

// L'application est servie derrière un reverse proxy local. Nécessaire pour que
// express-rate-limit interprète correctement X-Forwarded-For.
app.set('trust proxy', 1);

// ── Sécurité HTTP headers ─────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // désactivé : SPA avec inline scripts Tailwind
  crossOriginEmbedderPolicy: false,
}));

// ── CORS : origines autorisées depuis ENV ou wildcard en dev ──────────────────
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : null; // null = dev mode (accepte tout)

app.use(cors({
  origin: (origin, cb) => {
    if (!ALLOWED_ORIGINS) return cb(null, true); // dev : tout autorisé
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origine non autorisée'));
  },
  credentials: true,
}));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,                   // 10 tentatives login par IP / fenêtre
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives de connexion. Réessayez dans 15 minutes.' },
  skip: (req) => req.method !== 'POST', // appliqué uniquement sur POST /login
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 300,            // 300 requêtes/min par IP (usage normal)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes. Ralentissez.' },
});

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

// ── Rate limiting sur les routes API ─────────────────────────────────────────
app.use('/api/auth/login', loginLimiter);
app.use('/api', apiLimiter);

// API Routes
app.use('/api/auth', authRouter);

// Toutes les routes protégées : last_seen mis à jour après requireAuth
app.use('/api/operations', requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, operationsRouter);
app.use('/api/config',     requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, usersRouter);
app.use('/api/access',     requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, accessRouter);
app.use('/api/salaires',   requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, salairesRouter);
app.use('/api/agents',     requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, agentsRouter);
app.use('/api/entreprise', requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, entrepriseRouter);
app.use('/api/achats',    requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, achatsRouter);
app.use('/api/org',      requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, orgRouter);
app.use('/api/notifs',   requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, notifsRouter);
app.use('/api/clients',          requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, clientsRouter);
app.use('/api/devis',            requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, devisRouter);
app.use('/api/factures-clients', requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, facturesClientsRouter);
app.use('/api/produits',         requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, produitsRouter);
app.use('/api/contrats',         requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, contratsRouter);
app.use('/api/rapprochements',  requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, rapprochementsRouter);
app.use('/api/grilles',           requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, grillesRouter);
app.use('/api/revisions-salaire', requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, revisionsSalaireRouter);
app.use('/api/paie',              requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, periodesRouter);
app.use('/api/agents',            requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, sanctionsRouter);
app.use('/api/sanctions',         requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, sanctionsRouter);
app.use('/api/agents',            requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, offboardingRouter);
app.use('/api/agents',            requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, heuresSupRouter);
app.use('/api/heures-sup',        requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, heuresSupRouter);
app.use('/api/calendrier-fiscal', requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, calendrierFiscalRouter);

// ── Cron interne : moteur notifications ──────────────────────────────────────
// Rappels et escalades : toutes les 60 s
setInterval(() => {
  try { notifSvc.traiterRappelsDus(); }   catch (e) { console.error('[NOTIF cron rappels]',  e.message); }
  try { notifSvc.traiterEscalades(); }    catch (e) { console.error('[NOTIF cron escalades]', e.message); }
}, 60_000);

// Alertes solde + stock bas + encours crédit : toutes les 5 min
setInterval(() => {
  try { notifSvc.evaluerAlerteSoldes(); }     catch (e) { console.error('[NOTIF cron soldes]',   e.message); }
  try { notifSvc.checkStockBas(); }           catch (e) { console.error('[NOTIF cron stock]',    e.message); }
  try { notifSvc.checkEncoursCreditClient(); } catch (e) { console.error('[NOTIF cron encours]', e.message); }
  try {
    const bas = produitsRouter.getProduitsStockBas();
    if (bas.length > 0) console.log(`[STOCK cron] ${bas.length} produit(s) en stock bas/rupture`);
  } catch (e) { console.error('[STOCK cron bas]', e.message); }
}, 5 * 60_000);

// Purge + expirations + facturation récurrente + alertes métier : toutes les 24h
setInterval(() => {
  try { notifSvc.purgerAnciennesNotifs(); }                        catch (e) { console.error('[NOTIF cron purge]',       e.message); }
  try { devisRouter.expireDevisEchus(); }                          catch (e) { console.error('[DEVIS cron expire]',      e.message); }
  try { facturesClientsRouter.marquerFacturesEnRetard(); }         catch (e) { console.error('[FAC cron retard]',        e.message); }
  try { contratsRouter.expireContratsEchus(); }                    catch (e) { console.error('[CONTRATS cron expire]',   e.message); }
  try { contratsRouter.facturationEcheancesDuJour(); }             catch (e) { console.error('[CONTRATS cron factu]',   e.message); }
  try { contratsRouter.alerterContratsExpirants(); }               catch (e) { console.error('[CONTRATS cron alertes]', e.message); }
  try { notifSvc.checkFacturesClientEnRetard(); }                  catch (e) { console.error('[NOTIF cron fac-retard]', e.message); }
  try { notifSvc.checkContratsExpirants(); }                       catch (e) { console.error('[NOTIF cron contrats]',   e.message); }
  try { notifSvc.checkFacturesFournisseursEchues(); }              catch (e) { console.error('[NOTIF cron ff-echues]',  e.message); }
  try { notifSvc.checkEcheancesFiscales(); }                       catch (e) { console.error('[NOTIF cron fiscal]',     e.message); }
}, 24 * 60 * 60_000);

// ── Sauvegarde automatique DB — une fois par jour ─────────────────────────────
setInterval(() => {
  try {
    const DB_PATH  = process.env.DB_PATH || path.join(__dirname, 'data', 'caisse.db');
    const BACKUP_DIR = path.join(__dirname, 'data', 'backups');
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(BACKUP_DIR, `caisse-${ts}.db`);
    fs.copyFileSync(DB_PATH, dest);

    // Rétention 30 jours : supprimer les anciens
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('caisse-') && f.endsWith('.db'))
      .map(f => ({ f, mt: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mt - a.mt);
    files.slice(30).forEach(({ f }) => {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (_) {}
    });
    console.log(`[BACKUP] DB sauvegardée → ${dest}`);
  } catch (e) {
    console.error('[BACKUP] Échec sauvegarde DB:', e.message);
  }
}, 24 * 60 * 60_000);

// ── Relance auto achats soumis sans suite (toutes les 6h) ────────────────────
setInterval(() => {
  try {
    const delaiH = 48; // configurable : délai sans réponse avant rappel
    const achats = db.prepare(`
      SELECT id, numero, service_demandeur, total_general, updated_at
      FROM demandes_achat
      WHERE statut = 'soumis'
        AND (julianday('now') - julianday(updated_at)) * 24 >= ?
    `).all(delaiH);

    for (const da of achats) {
      notifSvc.planifierRappel({
        type:          'RAP_ACHAT_SOUMIS_SANS_SUITE',
        srcTable:      'demandes_achat',
        srcId:         da.id,
        declenchementJ: 0,
        declenche_a:   new Date().toISOString(),
      });
    }
  } catch (e) {
    console.error('[CRON relance achats]', e.message);
  }
}, 6 * 60 * 60_000);

// Passe initiale au démarrage (sans bloquer le listen)
setImmediate(() => {
  try { notifSvc.evaluerAlerteSoldes();     } catch (_) {}
  try { notifSvc.traiterRappelsDus();       } catch (_) {}
  try { notifSvc.checkEcheancesFiscales();  } catch (_) {}
});

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

// ── Journal d'audit ───────────────────────────────────────────────────────────
app.get('/api/audit', requireAuth, (req, res) => {
  if (!hasRole(req.user, 'admin', 'dg')) return res.status(403).json({ error: 'Admin ou DG requis' });

  const { user_id, table_name, action, debut, fin, search,
          limit = 100, offset = 0 } = req.query;

  let where = 'WHERE 1=1';
  const params = [];

  if (user_id)    { where += ' AND a.user_id = ?';             params.push(Number(user_id)); }
  if (table_name) { where += ' AND a.table_name = ?';          params.push(table_name); }
  if (action)     { where += ' AND a.action = ?';              params.push(action); }
  if (debut)      { where += ' AND a.created_at >= ?';         params.push(debut); }
  if (fin)        { where += ' AND a.created_at <= ? || "T23:59:59"'; params.push(fin); }
  if (search)     { where += ' AND (a.details LIKE ? OR a.action LIKE ? OR a.table_name LIKE ?)';
                    const s = '%' + search + '%'; params.push(s, s, s); }

  const total = db.prepare(`SELECT COUNT(*) as c FROM audit_logs a ${where}`).get(...params).c;

  const rows = db.prepare(`
    SELECT a.id, a.table_name, a.record_id, a.action, a.details, a.created_at,
           u.nom as user_nom, u.email as user_email, u.role as user_role
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.user_id
    ${where}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, Number(limit), Number(offset));

  const parsed = rows.map(r => ({
    ...r,
    details: (() => { try { return JSON.parse(r.details); } catch { return r.details; } })()
  }));

  // Méta : listes distinctes pour les filtres
  const modules  = db.prepare("SELECT DISTINCT table_name FROM audit_logs ORDER BY table_name").all().map(r => r.table_name);
  const actions  = db.prepare("SELECT DISTINCT action FROM audit_logs ORDER BY action").all().map(r => r.action);
  const users    = db.prepare("SELECT DISTINCT u.id, u.nom, u.email FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id WHERE u.id IS NOT NULL ORDER BY u.nom").all();

  res.json({ total, rows: parsed, meta: { modules, actions, users } });
});

// ── Export CSV audit ──────────────────────────────────────────────────────────
app.get('/api/audit/export-csv', requireAuth, (req, res) => {
  if (!hasRole(req.user, 'admin', 'dg')) return res.status(403).json({ error: 'Admin ou DG requis' });

  const { user_id, table_name, action, debut, fin } = req.query;
  let where = 'WHERE 1=1';
  const params = [];
  if (user_id)    { where += ' AND a.user_id = ?';    params.push(Number(user_id)); }
  if (table_name) { where += ' AND a.table_name = ?'; params.push(table_name); }
  if (action)     { where += ' AND a.action = ?';     params.push(action); }
  if (debut)      { where += ' AND a.created_at >= ?';params.push(debut); }
  if (fin)        { where += ' AND a.created_at <= ? || "T23:59:59"'; params.push(fin); }

  const rows = db.prepare(`
    SELECT a.id, a.created_at, a.table_name, a.record_id, a.action, a.details,
           u.nom as user_nom, u.email as user_email, u.role as user_role
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.user_id
    ${where}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT 5000
  `).all(...params);

  const BOM = '﻿';
  const SEP = ';';
  const headers = ['ID','Date/Heure','Module','ID enreg.','Action','Utilisateur','Email','Rôle','Détails'];
  const csvRows = rows.map(r => [
    r.id,
    (r.created_at || '').replace('T', ' ').slice(0, 19),
    r.table_name, r.record_id, r.action,
    r.user_nom || '(système)', r.user_email || '', r.user_role || '',
    `"${(r.details || '').replace(/"/g, '""')}"`
  ].join(SEP));

  const label = debut && fin ? `${debut}_au_${fin}` : new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit-${label}.csv"`);
  res.send(BOM + [headers.join(SEP), ...csvRows].join('\n'));
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
});
