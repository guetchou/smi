const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const { router: authRouter, requireAuth, hasRole } = require('./routes/auth');
const { activePermissionsForUser } = require('./services/permissions');
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

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 25, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false });

function updateLastSeen(req) {
  try {
    if (req.user?.id) db.prepare("UPDATE users SET last_seen_at=datetime('now') WHERE id=?").run(req.user.id);
  } catch (_) {}
}

function moduleAliases(moduleName) {
  const aliases = {
    hr: ['hr'],
    salary: ['salary', 'hr'],
    cash: ['cash'],
    purchase: ['purchase'],
    commercial: ['commercial'],
    stock: ['stock', 'purchase'],
    project: ['project'],
    callcenter: ['callcenter'],
    technical: ['technical'],
    settings: ['settings'],
    access: ['access'],
    org: ['org', 'hr'],
  };
  return aliases[moduleName] || [moduleName];
}

function requireModule(modules) {
  const requested = Array.isArray(modules) ? modules : [modules];
  return async (req, res, next) => {
    try {
      if (hasRole(req.user, 'admin')) return next();
      const permissions = await activePermissionsForUser(req.user.id);
      const allowed = requested.some(moduleName => moduleAliases(moduleName).some(alias => (
        permissions.some(permission => permission.module === alias && permission.allowed)
      )));
      if (!allowed) return res.status(403).json({ error: 'Accès module refusé' });
      next();
    } catch (e) { res.status(500).json({ error: e.message }); }
  };
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
app.use('/api/revisions-salaire', protectedRoute(requireModule('salary')), revisionsSalaireRouter);
app.use('/api/periodes-paie', protectedRoute(requireModule('salary')), periodesRouter);
app.use('/api/sanctions', protectedRoute(requireModule('hr')), sanctionsRouter);
app.use('/api/heures-sup', protectedRoute(requireModule('hr')), heuresSupRouter);
app.use('/api/calendrier-fiscal', protectedRoute(requireModule(['cash', 'salary'])), calendrierFiscalRouter);
app.use('/api/dashboard', protectedRoute(), dashboardRouter);
app.use('/api/parapheur', protectedRoute(), parapheurSourceSyncRouter);
app.use('/api/parapheur', protectedRoute(), parapheurRouter);
app.use('/api/pointeuse', protectedRoute(), pointeuseRouter);

app.get('/health', (_req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html')));

const server = app.listen(PORT, () => {
  console.log(`Tala SMI écoute sur le port ${PORT}`);
});

setInterval(() => runScheduledTask('notifications', () => notifSvc.processScheduledNotifications()), 60 * 1000).unref();

module.exports = { app, server };
