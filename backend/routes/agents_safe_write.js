'use strict';

/**
 * Correctif ciblé du module Agents.
 *
 * Ce routeur intercepte POST / et PUT /:id avant le routeur agents historique
 * afin de protéger les écritures partielles et l'intégrité organisationnelle.
 */
const express = require('express');
const db = require('../database');
const { can } = require('../services/permissions');
const onboardingSvc = require('../services/onboarding');
const organizationSvc = require('../services/organization_assignment');
const agentParapheurRequiredRouter = require('./agent_parapheur_required_safe');
const offboardingParapheurRequiredRouter = require('./offboarding_parapheur_required_safe');
const agentsEcosystemSafeRouter = require('./agents_ecosystem_safe');

const router = express.Router();

const TEXT_DEFAULTS = {
  matricule: '', sexe: 'M', poste: '', type: 'permanent', mode_paiement: 'especes',
  banque: '', numero_compte: '', email: '', telephone: '', telephone2: '',
  lieu_naissance: '', nationalite: 'Congolaise', situation_matrimoniale: 'celibataire',
  adresse: '', num_piece_identite: '', type_piece_identite: '', type_contrat: 'cdi',
  departement: '', superieur_hierarchique: '', site: '', statut_dossier: 'actif',
  motif_sortie: '',
};
const NUMBER_DEFAULTS = {
  salaire_base: 0, prime_transport: 0, prime_logement: 0,
  nb_enfants: 0, nb_enfants_charge: 0, periode_essai_mois: 0,
};
const DATE_FIELDS = [
  'date_naissance', 'date_expiration_identite', 'date_embauche',
  'date_debut_contrat', 'date_fin_contrat', 'date_fin_essai', 'date_sortie',
];
const WRITABLE_FIELDS = [
  'nom', 'prenom', 'matricule', 'sexe', 'poste', 'type',
  'salaire_base', 'prime_transport', 'prime_logement',
  'mode_paiement', 'banque', 'numero_compte', 'email', 'telephone', 'telephone2',
  'date_naissance', 'lieu_naissance', 'nationalite', 'situation_matrimoniale',
  'nb_enfants', 'nb_enfants_charge', 'adresse',
  'num_piece_identite', 'type_piece_identite', 'date_expiration_identite',
  'date_embauche', 'type_contrat', 'date_debut_contrat', 'date_fin_contrat',
  'periode_essai_mois', 'date_fin_essai',
  'departement', 'superieur_hierarchique', 'site', 'superieur_id',
  'statut_dossier', 'motif_sortie', 'date_sortie', 'actif',
];
const SALARY_FIELDS = ['salaire_base', 'prime_transport', 'prime_logement'];
const SALARY_ROLES = ['admin', 'rh', 'finance', 'dg'];

function hasRole(user, ...roles) {
  const all = new Set([user?.role, ...(Array.isArray(user?.roles) ? user.roles : [])].filter(Boolean));
  if (typeof user?.roles === 'string') {
    try { JSON.parse(user.roles).forEach(r => all.add(r)); } catch (_) {}
  }
  return roles.some(r => all.has(r));
}

async function requirePerm(req, res, permission) {
  if (await can(req.user, permission)) return true;
  res.status(403).json({ error: `Permission ${permission} requise`, permission });
  return false;
}

function nextMatricule() {
  const last = db.prepare("SELECT matricule FROM employes WHERE matricule LIKE 'MAT-%' ORDER BY id DESC LIMIT 1").get();
  if (!last) return 'MAT-0001';
  const num = parseInt(String(last.matricule || '').replace('MAT-', ''), 10) || 0;
  return 'MAT-' + String(num + 1).padStart(4, '0');
}

function n(value, fallback = 0) {
  const v = value === '' || value === null || value === undefined ? fallback : value;
  const out = Number(v);
  return Number.isFinite(out) ? out : fallback;
}

function text(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function dateOrNull(value, fallback = null) {
  if (value === undefined) return fallback || null;
  if (value === null || value === '') return null;
  return String(value).slice(0, 10);
}

function safeCreatePayload(body) {
  const payload = {};
  for (const field of WRITABLE_FIELDS) {
    if (field in NUMBER_DEFAULTS) payload[field] = n(body[field], NUMBER_DEFAULTS[field]);
    else if (DATE_FIELDS.includes(field)) payload[field] = dateOrNull(body[field]);
    else if (field === 'superieur_id') payload[field] = body[field] ? Number(body[field]) : null;
    else if (field === 'actif') payload[field] = body[field] === undefined ? 1 : (body[field] ? 1 : 0);
    else payload[field] = text(body[field], TEXT_DEFAULTS[field] ?? '');
  }
  payload.nom = text(body.nom);
  payload.prenom = text(body.prenom);
  payload.matricule = payload.matricule || nextMatricule();
  payload.actif = ['sorti', 'archive'].includes(payload.statut_dossier) ? 0 : payload.actif;
  return payload;
}

function safeUpdatePayload(current, body) {
  const payload = { ...current };
  for (const field of WRITABLE_FIELDS) {
    if (body[field] === undefined) continue;
    if (field in NUMBER_DEFAULTS) payload[field] = n(body[field], n(current[field], NUMBER_DEFAULTS[field]));
    else if (DATE_FIELDS.includes(field)) payload[field] = dateOrNull(body[field], current[field]);
    else if (field === 'superieur_id') payload[field] = body[field] ? Number(body[field]) : null;
    else if (field === 'actif') payload[field] = body[field] ? 1 : 0;
    else payload[field] = text(body[field], current[field] ?? TEXT_DEFAULTS[field] ?? '');
  }
  payload.actif = ['sorti', 'archive'].includes(payload.statut_dossier) ? 0 : (payload.actif === undefined ? 1 : payload.actif);
  return payload;
}

function sanitizeBind(values) {
  return values.map(v => v === undefined ? null : v);
}

function audit(table, recordId, action, details, userId) {
  try {
    db.prepare(`
      INSERT INTO audit_logs (table_name, record_id, action, details, user_id, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(table, recordId, action, JSON.stringify(details || {}), userId || null);
  } catch (_) {}
}

function assertIdentityUnique(numPiece, selfId = null) {
  const clean = text(numPiece);
  if (!clean) return null;
  const sql = selfId
    ? 'SELECT id, nom, prenom FROM employes WHERE num_piece_identite = ? AND id != ? AND actif = 1'
    : 'SELECT id, nom, prenom FROM employes WHERE num_piece_identite = ? AND actif = 1';
  return selfId ? db.prepare(sql).get(clean, selfId) : db.prepare(sql).get(clean);
}

function assertMatriculeUnique(matricule, selfId = null) {
  const clean = text(matricule);
  if (!clean) return null;
  const sql = selfId
    ? 'SELECT id, nom, prenom FROM employes WHERE matricule = ? AND id != ?'
    : 'SELECT id, nom, prenom FROM employes WHERE matricule = ?';
  return selfId ? db.prepare(sql).get(clean, selfId) : db.prepare(sql).get(clean);
}

function salaryChanged(current, payload) {
  return SALARY_FIELDS.some(f => n(current[f]) !== n(payload[f]));
}

function assertSalaryChangeAllowed(req, current, payload) {
  if (!salaryChanged(current, payload)) return null;
  if (!hasRole(req.user, ...SALARY_ROLES)) {
    return { status: 403, body: { error: 'Modification de la rémunération interdite', code: 'SALARY_PROTECTED' } };
  }
  if (!text(req.body.motif)) {
    return { status: 400, body: { error: 'Motif obligatoire pour toute modification de rémunération', code: 'SALARY_MOTIF_REQUIRED' } };
  }
  return null;
}

function insertOrUpdateSql(table, payload, id = null) {
  const fields = WRITABLE_FIELDS.filter(f => f !== 'actif' || payload[f] !== undefined);
  if (!id) {
    return {
      sql: `INSERT INTO ${table} (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
      values: sanitizeBind(fields.map(f => payload[f])),
    };
  }
  return {
    sql: `UPDATE ${table} SET ${fields.map(f => `${f}=?`).join(', ')}, updated_at=datetime('now') WHERE id=?`,
    values: sanitizeBind([...fields.map(f => payload[f]), id]),
  };
}

function getAgent(id) {
  return db.prepare('SELECT * FROM employes WHERE id = ?').get(id);
}

function changedFields(before, after) {
  return WRITABLE_FIELDS.filter(f => String(before?.[f] ?? '') !== String(after?.[f] ?? ''));
}

function sendOrganizationError(res, error) {
  if (!(error instanceof organizationSvc.OrganizationRuleError) && !error?.code) return false;
  res.status(error.status || 400).json({ error: error.message, code: error.code, details: error.details || undefined });
  return true;
}

router.post('/', async (req, res, next) => {
  try {
    if (!(await requirePerm(req, res, 'hr.agent.create'))) return;
    const payload = safeCreatePayload(req.body || {});
    if (!payload.nom || !payload.prenom) return res.status(400).json({ error: 'Nom et prénom requis' });

    const matriculeConflict = assertMatriculeUnique(payload.matricule);
    if (matriculeConflict) return res.status(409).json({ error: `Matricule déjà utilisé par ${matriculeConflict.nom} ${matriculeConflict.prenom}` });
    const pieceConflict = assertIdentityUnique(payload.num_piece_identite);
    if (pieceConflict) return res.status(409).json({ error: `Numéro de pièce déjà utilisé par ${pieceConflict.nom} ${pieceConflict.prenom}` });

    let hierarchy;
    try {
      hierarchy = organizationSvc.resolveAgentAssignment(payload);
    } catch (error) {
      if (sendOrganizationError(res, error)) return;
      throw error;
    }

    const { sql, values } = insertOrUpdateSql('employes', payload);
    const r = db.prepare(sql).run(...values);
    const agent = getAgent(r.lastInsertRowid);
    audit('employes', agent.id, 'create', {
      matricule: agent.matricule,
      safe_write: true,
      department_manager_applied: hierarchy.manager?.id || null,
    }, req.user?.id);

    try {
      onboardingSvc.initOnboarding(agent.id, agent, req.user?.id, req.ip);
      onboardingSvc.notifierCreation(agent, req.user?.id);
    } catch (obErr) {
      console.error('[onboarding] init error:', obErr.message);
    }

    res.status(201).json(agent);
  } catch (e) {
    next(e);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    if (!(await requirePerm(req, res, 'hr.agent.update'))) return;
    const id = Number(req.params.id);
    const current = getAgent(id);
    if (!current) return res.status(404).json({ error: 'Agent non trouvé' });
    if (current.statut_dossier === 'sorti') {
      return res.status(403).json({ error: 'Agent sorti — utilisez la route /reactiver pour le réactiver' });
    }

    const payload = safeUpdatePayload(current, req.body || {});
    if (!payload.nom || !payload.prenom) return res.status(400).json({ error: 'Nom et prénom requis' });

    const matriculeConflict = assertMatriculeUnique(payload.matricule, id);
    if (matriculeConflict) return res.status(409).json({ error: `Matricule déjà utilisé par ${matriculeConflict.nom} ${matriculeConflict.prenom}` });
    const pieceConflict = assertIdentityUnique(payload.num_piece_identite, id);
    if (pieceConflict) return res.status(409).json({ error: `Numéro de pièce déjà utilisé par ${pieceConflict.nom} ${pieceConflict.prenom}` });

    const salaryError = assertSalaryChangeAllowed(req, current, payload);
    if (salaryError) return res.status(salaryError.status).json(salaryError.body);

    if (current.statut_dossier === 'brouillon' && payload.statut_dossier === 'actif' && n(payload.salaire_base) <= 0) {
      return res.status(400).json({ error: 'Salaire de base requis pour activer le profil paie de l\'agent' });
    }

    let hierarchy;
    try {
      hierarchy = organizationSvc.resolveAgentAssignment(payload, { employeeId: id, current });
    } catch (error) {
      if (sendOrganizationError(res, error)) return;
      throw error;
    }

    const { sql, values } = insertOrUpdateSql('employes', payload, id);
    db.prepare(sql).run(...values);
    const updated = getAgent(id);
    const changed = changedFields(current, updated);
    if (changed.length) audit('employes', id, 'update', {
      changed_fields: changed,
      safe_write: true,
      department_manager_applied: hierarchy.selfManager ? null : hierarchy.manager?.id || null,
    }, req.user?.id);
    if (salaryChanged(current, updated)) {
      audit('employes', id, 'modifier_salaire', {
        ancien_salaire: current.salaire_base,
        nouveau_salaire: updated.salaire_base,
        motif: text(req.body.motif),
        safe_write: true,
      }, req.user?.id);
    }

    res.json(updated);
  } catch (e) {
    next(e);
  }
});

router.use(agentParapheurRequiredRouter);
router.use(offboardingParapheurRequiredRouter);
router.use(agentsEcosystemSafeRouter);

module.exports = router;
