const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const { router: authRouter, requireAuth, hasRole } = require('./routes/auth');
const { activePermissionsForUser } = require('./services/permissions');
const cashReceiptWorkflowRouter = require('./routes/cash_receipt_workflow_router');
const operationsParapheurRequiredRouter = require('./routes/operations_parapheur_required_safe');
const operationsRouter = require('./routes/operations');
const usersRouter = require('./routes/users');
const accessRouter = require('./routes/access');
const salairesRouter = require('./routes/salaires');
const agentsRouter = require('./routes/agents');
const agentsSafeWriteRouter = require('./routes/agents_safe_write');
const entrepriseRouter = require('./routes/entreprise');
const achatsParapheurRequiredRouter = require('./routes/achats_parapheur_required_safe');
const achatsRouter = require('./routes/achats');
const notifsRouter = require('./routes/notifs');
const clientsRouter = require('./routes/clients');
const devisRouter = require('./routes/devis');
const facturesClientsRouter = require('./routes/factures_clients');
const produitsRouter = require('./routes/produits');
const contratsRouter = require('./routes/contrats');
const rapprochementsRouter = require('./routes/rapprochements');
const organizationMutationWorkflowRouter = require('./routes/organization_mutation_workflow');
const organizationMutationWorkflow = require('./services/organization_mutation_workflow');
const organizationIntegrityRouter = require('./routes/organization_integrity_safe');
const { router: orgRouter } = require('./routes/organigramme');
const grillesRouter = require('./routes/grilles');
const revisionsSalaireRouter = require('./routes/revisions_salaire');
const { router: periodesRouter } = require('./routes/periodes_paie');
const sanctionsRouter = require('./routes/sanctions');
const offboardingRouter = require('./routes/offboarding');
const heuresSupRouter = require('./routes/heures_sup');
const calendrierFiscalRouter = require('./routes/calendrier_fiscal');
const dashboardRouter = require('./routes/dashboard');
const parapheurSourceSyncRouter = require('./routes/parapheur_source_sync_safe');
const parapheurRouter = require('./routes/parapheur');
const pointeuseRouter = require('./routes/pointeuse');
const accountingRouter = require('./routes/accounting');
const notifSvc = require('./services/notif');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3337;
const IS_MYSQL_DRIVER = (process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'mysql';

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : null;
app.use(cors({
  origin: (origin, cb) => {
    if (!ALLOWED_ORIGINS) return cb(null, true);
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origine non autorisée'));
  },
  credentials: true,
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.body?.email || req.socket.remoteAddress || 'unknown').toLowerCase(),
  validate: { xForwardedForHeader: false },
  message: { error: 'Trop de tentatives de connexion. Réessayez dans 15 minutes.' },
  skip: (req) => req.method !== 'POST',
});
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false, message: { error: 'Trop de requêtes. Ralentissez.' } });

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' };
['/', '/index.html', '/dashboard.html', '/sw.js'].forEach(route => {
  const file = route === '/' ? 'index.html' : route.slice(1);
  app.get(route, (_req, res) => {
    Object.entries(NO_STORE).forEach(([k, v]) => res.setHeader(k, v));
    res.sendFile(path.join(__dirname, '..', 'frontend', file));
  });
});
app.get(['/app', '/app/*'], (_req, res) => {
  Object.entries(NO_STORE).forEach(([k, v]) => res.setHeader(k, v));
  res.sendFile(path.join(__dirname, '..', 'frontend', 'dashboard.html'));
});
app.get('/sw-kill', (_req, res) => {
  Object.entries(NO_STORE).forEach(([k, v]) => res.setHeader(k, v));
  res.type('html').send('<!doctype html><meta charset="utf-8"><title>Cache</title><p>Rechargez la page avec Ctrl+F5 pour vider le cache navigateur.</p>');
});

app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.use('/uploads', express.static(path.join(__dirname, 'data', 'uploads')));

const _lastSeenCache = new Map();
function updateLastSeen(req) {
  if (!req.user?.id) return;
  const uid = req.user.id;
  const now = Date.now();
  if (_lastSeenCache.has(uid) && now - _lastSeenCache.get(uid) < 30000) return;
  _lastSeenCache.set(uid, now);
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
  try { db.prepare("UPDATE users SET last_seen_at = datetime('now'), last_ip = ? WHERE id = ?").run(ip, uid); } catch (_) {}
}
async function canAccessModule(user, modules) {
  if (!user) return false;
  if (hasRole(user, 'admin')) return true;
  const allowedModules = Array.isArray(modules) ? modules : [modules];
  if (allowedModules.includes('pointeuse')) return true;
  const permissions = await activePermissionsForUser(user.id);
  const userModules = new Set(permissions.map(p => p.module).filter(Boolean));
  return allowedModules.some(moduleName => userModules.has(moduleName));
}
function requireModule(modules) {
  return async (req, res, next) => {
    try {
      if (!await canAccessModule(req.user, modules)) {
        return res.status(403).json({ error: 'Module non assigné à votre compte', module: Array.isArray(modules) ? modules.join(',') : modules });
      }
      next();
    } catch (e) { res.status(500).json({ error: e.message }); }
  };
}
async function canAccessParapheur(user) {
  if (!user) return false;
  if (hasRole(user, 'admin', 'dg', 'manager', 'assistante_direction')) return true;
  return canAccessModule(user, ['parapheur', 'access', 'purchase', 'cash', 'salary', 'hr', 'commercial', 'project']);
}
function requireParapheurAccess(req, res, next) {
  canAccessParapheur(req.user)
    .then(allowed => {
      if (!allowed) return res.status(403).json({ error: 'Module parapheur non assigné à votre compte', module: 'parapheur' });
      next();
    })
    .catch(e => res.status(500).json({ error: e.message }));
}
function protectedRoute(...middlewares) {
  return [requireAuth, (req, _res, next) => { updateLastSeen(req); next(); }, ...middlewares];
}
async function runScheduledTask(label, task) {
  try { return await task(); } catch (error) { console.error(`[${label}]`, error.message); return null; }
}
function csvCell(value) {
  const raw = value === undefined || value === null ? '' : String(value);
  return `"${raw.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

function safeBodyShape(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const keys = Object.keys(body).sort();
  const shape = {
    keys,
    content_type: req.headers['content-type'] || null,
    client_build: req.headers['x-client-build'] || null,
  };

  if (req.originalUrl.startsWith('/api/agents')) {
    shape.agent = {
      id_param: req.params?.id || null,
      has_nom: typeof body.nom === 'string' && body.nom.trim().length > 0,
      has_prenom: typeof body.prenom === 'string' && body.prenom.trim().length > 0,
      nom_len: typeof body.nom === 'string' ? body.nom.trim().length : null,
      prenom_len: typeof body.prenom === 'string' ? body.prenom.trim().length : null,
      statut_dossier: body.statut_dossier || null,
      has_matricule: typeof body.matricule === 'string' && body.matricule.trim().length > 0,
    };
  }

  if (req.originalUrl.startsWith('/api/achats')) {
    const lignes = Array.isArray(body.lignes) ? body.lignes : [];
    shape.achat = {
      id_param: req.params?.id || null,
      has_service_demandeur: typeof body.service_demandeur === 'string' && body.service_demandeur.trim().length > 0,
      has_demandeur_nom: typeof body.demandeur_nom === 'string' && body.demandeur_nom.trim().length > 0,
      service_len: typeof body.service_demandeur === 'string' ? body.service_demandeur.trim().length : null,
      demandeur_len: typeof body.demandeur_nom === 'string' ? body.demandeur_nom.trim().length : null,
      lignes_is_array: Array.isArray(body.lignes),
      lignes_count: lignes.length,
      lignes_with_designation: lignes.filter(l => l?.designation && String(l.designation).trim()).length,
      lignes_with_positive_amount: lignes.filter(l => Number(l?.montant || 0) > 0).length,
      transport_present: body.transport !== undefined,
    };
  }

  return shape;
}

function validationDiagnostic(label) {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      if (res.statusCode >= 400 && res.statusCode < 500 && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
        const diagnosticId = `diag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const safePayload = payload && typeof payload === 'object'
          ? { ...payload, diagnostic_id: diagnosticId }
          : payload;
        console.warn('[VALIDATION-DIAG]', JSON.stringify({
          diagnostic_id: diagnosticId,
          label,
          method: req.method,
          url: req.originalUrl,
          status: res.statusCode,
          response_error: payload?.error || null,
          user_id: req.user?.id || null,
          user_role: req.user?.role || null,
          body_shape: safeBodyShape(req),
        }));
        return originalJson(safePayload);
      }
      return originalJson(payload);
    };
    next();
  };
}

app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'); res.setHeader('Pragma', 'no-cache'); next(); });
app.use('/api/auth/login', loginLimiter);
app.use('/api', apiLimiter);
app.use('/api/auth', authRouter);

app.use('/api/operations', protectedRoute(requireModule('cash')), validationDiagnostic('cash-receipt'), cashReceiptWorkflowRouter);
app.use('/api/operations', protectedRoute(requireModule('cash')), operationsParapheurRequiredRouter);
app.use('/api/operations', protectedRoute(requireModule('cash')), operationsRouter);
app.use('/api/accounting', protectedRoute(requireModule('cash')), accountingRouter);
app.use('/api/config', protectedRoute((req, res, next) => {
  if (req.method === 'GET' && req.path === '/me') return next();
  if (req.method === 'GET' && req.path === '/categories') return requireModule(['cash', 'commercial', 'purchase', 'salary'])(req, res, next);
  if (req.method === 'GET' && req.path === '/employes') return requireModule(['cash', 'salary', 'hr'])(req, res, next);
  if (req.method === 'GET' && req.path === '/fournisseurs') return requireModule(['cash', 'purchase'])(req, res, next);
  if (req.method === 'GET' && req.path === '/parametres') return requireModule(['cash', 'commercial', 'purchase', 'salary', 'hr', 'settings'])(req, res, next);
  return requireModule(['settings', 'access'])(req, res, next);
}), usersRouter);
app.use('/api/access', protectedRoute(), accessRouter);
app.use('/api/salaires', protectedRoute(requireModule('salary')), salairesRouter);
app.use('/api/agents/sorties', protectedRoute(requireModule('hr')), (_req, res) => {
  const rows = db.prepare(`SELECT s.*, e.id AS employe_id, e.nom || ' ' || COALESCE(e.prenom, '') AS employe_nom, e.matricule AS employe_matricule, e.poste, e.departement FROM employes_sortie s JOIN employes e ON e.id = s.employe_id ORDER BY CASE s.statut WHEN 'initie' THEN 1 WHEN 'calcule' THEN 2 WHEN 'valide' THEN 3 ELSE 4 END, COALESCE(s.date_depart_effectif, s.created_at) DESC`).all();
  res.json({ sorties: rows });
});
app.use('/api/agents', protectedRoute(requireModule('hr')), validationDiagnostic('agents'), agentsSafeWriteRouter);
app.use('/api/agents', protectedRoute(requireModule('hr')), offboardingRouter);
app.use('/api/agents', protectedRoute(requireModule('hr')), agentsRouter);
app.use('/api/entreprise', protectedRoute(requireModule(['settings', 'access'])), entrepriseRouter);
app.use('/api/achats', protectedRoute(requireModule('purchase')), validationDiagnostic('achats'), achatsParapheurRequiredRouter);
app.use('/api/achats', protectedRoute(requireModule('purchase')), achatsRouter);
app.use('/api/org', protectedRoute(requireModule(['org', 'hr'])), validationDiagnostic('organization'), organizationMutationWorkflowRouter);
app.use('/api/org', protectedRoute(requireModule(['org', 'hr'])), validationDiagnostic('organization'), organizationIntegrityRouter);
app.use('/api/org', protectedRoute(requireModule(['org', 'hr'])), orgRouter);
app.use('/api/notifs', protectedRoute(), notifsRouter);
app.use('/api/clients', protectedRoute(requireModule('commercial')), clientsRouter);
app.use('/api/devis', protectedRoute(requireModule('commercial')), devisRouter);
app.use('/api/factures-clients', protectedRoute(requireModule('commercial')), facturesClientsRouter);
app.use('/api/produits', protectedRoute(requireModule('stock')), produitsRouter);
app.use('/api/contrats', protectedRoute(requireModule(['project', 'commercial'])), contratsRouter);
app.use('/api/rapprochements', protectedRoute(requireModule('cash')), rapprochementsRouter);
app.use('/api/grilles', protectedRoute(requireModule('salary')), grillesRouter);
app.use('/api/revisions-salaire', protectedRoute(requireModule(['salary', 'hr'])), revisionsSalaireRouter);
app.use('/api/paie', protectedRoute(requireModule('salary')), periodesRouter);
app.use('/api/agents', protectedRoute(requireModule('hr')), sanctionsRouter);
app.use('/api/sanctions', protectedRoute(requireModule('hr')), sanctionsRouter);
app.use('/api/agents', protectedRoute(requireModule('hr')), heuresSupRouter);
app.use('/api/heures-sup', protectedRoute(requireModule('hr')), heuresSupRouter);
app.use('/api/calendrier-fiscal', protectedRoute(requireModule('salary')), calendrierFiscalRouter);
app.use('/api/dashboard', protectedRoute(requireModule('dashboard')), dashboardRouter);
app.use('/api/parapheur', protectedRoute(requireParapheurAccess), parapheurSourceSyncRouter);
app.use('/api/parapheur', protectedRoute(requireParapheurAccess), parapheurRouter);
app.use('/api/pointeuse', protectedRoute(), pointeuseRouter);

setInterval(async () => {
  await runScheduledTask('NOTIF cron rappels', () => notifSvc.traiterRappelsDus());
  await runScheduledTask('NOTIF cron escalades', () => notifSvc.traiterEscalades());
}, 60000);
setInterval(async () => {
  await runScheduledTask('NOTIF cron soldes', () => notifSvc.evaluerAlerteSoldes());
  await runScheduledTask('NOTIF cron stock', () => notifSvc.checkStockBas());
  await runScheduledTask('NOTIF cron encours', () => notifSvc.checkEncoursCreditClient());
}, 300000);
setInterval(async () => {
  await runScheduledTask('NOTIF cron purge', () => notifSvc.purgerAnciennesNotifs());
  try { devisRouter.expireDevisEchus(); } catch (e) { console.error('[DEVIS cron expire]', e.message); }
  try { facturesClientsRouter.marquerFacturesEnRetard(); } catch (e) { console.error('[FAC cron retard]', e.message); }
  try { contratsRouter.expireContratsEchus(); } catch (e) { console.error('[CONTRATS cron expire]', e.message); }
  try { contratsRouter.facturationEcheancesDuJour(); } catch (e) { console.error('[CONTRATS cron factu]', e.message); }
  try { contratsRouter.alerterContratsExpirants(); } catch (e) { console.error('[CONTRATS cron alertes]', e.message); }
  await runScheduledTask('NOTIF cron fac-retard', () => notifSvc.checkFacturesClientEnRetard());
  await runScheduledTask('NOTIF cron contrats', () => notifSvc.checkContratsExpirants());
  await runScheduledTask('NOTIF cron ff-echues', () => notifSvc.checkFacturesFournisseursEchues());
  await runScheduledTask('NOTIF cron fiscal', () => notifSvc.checkEcheancesFiscales());
}, 86400000);
setInterval(() => {
  try {
    const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'caisse.db');
    const BACKUP_DIR = path.join(__dirname, 'data', 'backups');
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(BACKUP_DIR, `caisse-${ts}.db`);
    fs.copyFileSync(DB_PATH, dest);
  } catch (e) { console.error('[BACKUP] Échec sauvegarde DB:', e.message); }
}, 86400000);
setInterval(() => {
  try {
    const delaiH = 48;
    const staleDelayClause = IS_MYSQL_DRIVER ? 'TIMESTAMPDIFF(HOUR, updated_at, NOW()) >= ?' : "(julianday('now') - julianday(updated_at)) * 24 >= ?";
    const achats = db.prepare(`SELECT id FROM demandes_achat WHERE statut = 'soumis' AND ${staleDelayClause}`).all(delaiH);
    for (const da of achats) notifSvc.planifierRappel({ type: 'RAP_ACHAT_SOUMIS_SANS_SUITE', srcTable: 'demandes_achat', srcId: da.id, declenchementJ: 0, declenche_a: new Date().toISOString() });
  } catch (e) { console.error('[CRON relance achats]', e.message); }
}, 21600000);
setImmediate(async () => {
  await runScheduledTask('NOTIF initial soldes', () => notifSvc.evaluerAlerteSoldes());
  await runScheduledTask('NOTIF initial rappels', () => notifSvc.traiterRappelsDus());
  await runScheduledTask('NOTIF initial fiscal', () => notifSvc.checkEcheancesFiscales());
});

app.get('/api/admin/connected-users', requireAuth, (req, res) => {
  if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis' });
  updateLastSeen(req);
  const users = db.prepare('SELECT id, nom, email, role, sous_role, actif, last_seen_at, last_ip FROM users WHERE actif = 1 ORDER BY last_seen_at IS NULL ASC, last_seen_at DESC').all();
  res.json(users);
});
app.get('/api/audit', requireAuth, (req, res) => {
  if (!hasRole(req.user, 'admin', 'dg')) return res.status(403).json({ error: 'Admin ou DG requis' });
  const rows = db.prepare('SELECT a.*, u.nom as user_nom, u.email as user_email, u.role as user_role FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC, a.id DESC LIMIT 100').all();
  res.json({ total: rows.length, rows });
});
app.get('/api/audit/export-csv', requireAuth, (req, res) => {
  if (!hasRole(req.user, 'admin', 'dg')) return res.status(403).json({ error: 'Admin ou DG requis' });

  const { user_id, table_name, action, debut, fin } = req.query;
  let where = 'WHERE 1=1';
  const params = [];
  if (user_id) { where += ' AND a.user_id = ?'; params.push(Number(user_id)); }
  if (table_name) { where += ' AND a.table_name = ?'; params.push(table_name); }
  if (action) { where += ' AND a.action = ?'; params.push(action); }
  if (debut) { where += ' AND a.created_at >= ?'; params.push(debut); }
  if (fin) { where += ' AND a.created_at <= ?'; params.push(`${fin}T23:59:59`); }

  const rows = db.prepare(`
    SELECT a.id, a.created_at, a.table_name, a.record_id, a.action, a.details,
           u.nom as user_nom, u.email as user_email, u.role as user_role
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.user_id
    ${where}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT 5000
  `).all(...params);

  const headers = ['ID','Date/Heure','Module','ID enreg.','Action','Utilisateur','Email','Rôle','Détails'];
  const csvRows = rows.map(r => [
    r.id,
    (r.created_at || '').replace('T', ' ').slice(0, 19),
    r.table_name,
    r.record_id,
    r.action,
    r.user_nom || '(système)',
    r.user_email || '',
    r.user_role || '',
    r.details || '',
  ].map(csvCell).join(';'));

  const label = debut && fin ? `${debut}_au_${fin}` : new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit-${label}.csv"`);
  res.send('\ufeff' + [headers.map(csvCell).join(';'), ...csvRows].join('\n'));
});
app.get('/api/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Route API introuvable' });
  if (path.extname(req.path)) return res.status(404).send('Not found');
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

async function start() {
  if ((process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'mysql') {
    const { runMigrations } = require('./migrations/runner');
    const dbAdapter = require('./db');
    try { await runMigrations(dbAdapter._pool); } catch (err) { console.error('[migrations] ERREUR CRITIQUE - arrêt du serveur:', err.message); process.exit(1); }
  }
  await runScheduledTask('ORG mutations initiales', () => organizationMutationWorkflow.applyDue(null));
  setInterval(() => runScheduledTask('ORG mutations échéances', () => organizationMutationWorkflow.applyDue(null)), 60000).unref();
  app.listen(PORT, () => {
    console.log(`Tala SMI - Systeme de Management Integre (port ${PORT})`);
    console.log('Developpe par Gess GALOYI - TOP CENTER');
  });
}
start();
