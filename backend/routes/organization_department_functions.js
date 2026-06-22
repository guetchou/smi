'use strict';

const express = require('express');
const db = require('../database');
const { can } = require('../services/permissions');
const functions = require('../services/organization_department_functions');
const { installDepartmentFunctionSafety } = require('../services/organization_department_functions_safety');
const {
  installDepartmentHierarchyRules,
  reconcileEffectiveManagers,
} = require('../services/organization_department_hierarchy');
const { installMutationDepartmentFunctions } = require('../services/organization_mutation_department_functions');

installDepartmentFunctionSafety();
installDepartmentHierarchyRules();
installMutationDepartmentFunctions();

const router = express.Router();

const reconciliationTimer = setInterval(() => {
  try {
    const result = reconcileEffectiveManagers(null);
    if (result.changed.length || result.failed.length) {
      console.log('[ORG fonctions départementales]', JSON.stringify(result));
    }
  } catch (error) {
    console.error('[ORG fonctions départementales]', error.message);
  }
}, 60000);
if (typeof reconciliationTimer.unref === 'function') reconciliationTimer.unref();

async function canManage(user) {
  return Boolean(await can(user, 'hr.agent.update'));
}

async function requireManage(req, res) {
  if (await canManage(req.user)) return true;
  res.status(403).json({ error: 'Permission de modification RH requise', permission: 'hr.agent.update' });
  return false;
}

function sendFunctionError(res, error) {
  if (!(error instanceof functions.DepartmentFunctionError) && !error?.code) return false;
  res.status(error.status || 400).json({
    error: error.message,
    code: error.code,
    details: error.details || undefined,
  });
  return true;
}

function audit(recordId, action, details, userId) {
  try {
    db.prepare(`
      INSERT INTO audit_logs (table_name, record_id, action, details, user_id, created_at)
      VALUES ('org_departement_fonctions', ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(Number(recordId), action, JSON.stringify(details || {}), userId || null);
  } catch (_) {}
}

function validDate(value) {
  return !value || /^\d{4}-\d{2}-\d{2}$/.test(String(value));
}

router.get('/departements/capabilities', async (req, res, next) => {
  try {
    res.json({ can_manage_functions: await canManage(req.user) });
  } catch (error) {
    next(error);
  }
});

router.get('/departements', (_req, res, next) => {
  try {
    res.json(functions.listAllActive());
  } catch (error) {
    next(error);
  }
});

router.get('/departements/:id/fonctions', (req, res, next) => {
  try {
    const includeInactive = String(req.query?.historique || '') === '1';
    res.json({
      types: functions.FUNCTION_TYPES,
      rows: functions.listFunctions(req.params.id, { includeInactive }),
    });
  } catch (error) {
    if (sendFunctionError(res, error)) return;
    next(error);
  }
});

router.post('/departements/:id/fonctions', async (req, res, next) => {
  try {
    if (!(await requireManage(req, res))) return;
    const result = functions.createFunction(req.params.id, req.body || {}, req.user?.id);
    const reconciliation = reconcileEffectiveManagers(req.user?.id);
    audit(result.function.id, 'fonction_departementale_creee', {
      departement_id: Number(req.params.id),
      employe_id: result.function.employe_id,
      fonction_type: result.function.fonction_type,
      date_debut: result.function.date_debut,
      date_fin: result.function.date_fin,
      reconciliation,
    }, req.user?.id);
    res.status(201).json({ ...result, reconciliation });
  } catch (error) {
    if (sendFunctionError(res, error)) return;
    next(error);
  }
});

router.put('/departements/:departmentId/fonctions/:functionId', async (req, res, next) => {
  try {
    if (!(await requireManage(req, res))) return;
    const current = db.prepare(`
      SELECT * FROM org_departement_fonctions
      WHERE id = ? AND departement_id = ?
    `).get(Number(req.params.functionId), Number(req.params.departmentId));
    if (!current) {
      return res.status(404).json({ error: 'Fonction départementale introuvable.', code: 'DEPARTMENT_FUNCTION_NOT_FOUND' });
    }
    if (req.body?.employe_id && Number(req.body.employe_id) !== Number(current.employe_id)) {
      return res.status(409).json({ error: 'L’agent d’une fonction existante ne peut pas être remplacé. Clôturez-la puis créez-en une nouvelle.', code: 'FUNCTION_EMPLOYEE_IMMUTABLE' });
    }
    if (req.body?.fonction_type && String(req.body.fonction_type) !== String(current.fonction_type)) {
      return res.status(409).json({ error: 'Le type d’une fonction existante ne peut pas être transformé. Clôturez-la puis créez-en une nouvelle.', code: 'FUNCTION_TYPE_IMMUTABLE' });
    }

    const start = req.body?.date_debut === undefined ? current.date_debut : String(req.body.date_debut || '');
    const end = req.body?.date_fin === undefined ? current.date_fin : (req.body.date_fin || null);
    if (!validDate(start) || !validDate(end)) {
      return res.status(400).json({ error: 'Date invalide. Format attendu : AAAA-MM-JJ.', code: 'INVALID_FUNCTION_DATE' });
    }
    if (end && end < start) {
      return res.status(400).json({ error: 'La date de fin ne peut pas précéder la date de début.', code: 'INVALID_FUNCTION_DATE_RANGE' });
    }
    if (['interimaire', 'suppleant'].includes(current.fonction_type) && !end) {
      return res.status(400).json({ error: 'Une fonction temporaire doit avoir une date de fin.', code: 'TEMPORARY_FUNCTION_END_REQUIRED' });
    }

    db.prepare(`
      UPDATE org_departement_fonctions
      SET rang = ?, perimetre = ?, date_debut = ?, date_fin = ?, titulaire = ?,
          decision_reference = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      req.body?.rang === undefined ? Number(current.rang || 0) : Number(req.body.rang || 0),
      req.body?.perimetre === undefined ? current.perimetre : (String(req.body.perimetre || '').trim() || null),
      start,
      end,
      req.body?.titulaire === undefined ? Number(current.titulaire || 0) : (req.body.titulaire ? 1 : 0),
      req.body?.decision_reference === undefined ? current.decision_reference : (String(req.body.decision_reference || '').trim() || null),
      Number(current.id),
    );

    const reconciliation = reconcileEffectiveManagers(req.user?.id);
    const row = functions.listFunctions(req.params.departmentId, { includeInactive: true })
      .find(item => Number(item.id) === Number(current.id));
    audit(row.id, 'fonction_departementale_modifiee', {
      departement_id: Number(req.params.departmentId),
      fonction_type: row.fonction_type,
      date_debut: row.date_debut,
      date_fin: row.date_fin,
      reconciliation,
    }, req.user?.id);
    res.json({ ...row, reconciliation });
  } catch (error) {
    if (sendFunctionError(res, error)) return;
    next(error);
  }
});

router.delete('/departements/:departmentId/fonctions/:functionId', async (req, res, next) => {
  try {
    if (!(await requireManage(req, res))) return;

    const current = db.prepare(`
      SELECT * FROM org_departement_fonctions
      WHERE id = ? AND departement_id = ?
    `).get(Number(req.params.functionId), Number(req.params.departmentId));
    if (!current) {
      return res.status(404).json({ error: 'Fonction départementale introuvable.', code: 'DEPARTMENT_FUNCTION_NOT_FOUND' });
    }
    if (current.fonction_type === 'chef' && current.actif) {
      const replacement = db.prepare(`
        SELECT COUNT(*) AS total
        FROM org_departement_fonctions
        WHERE departement_id = ? AND id != ? AND fonction_type = 'chef' AND actif = 1
          AND date_debut <= CURRENT_DATE
          AND (date_fin IS NULL OR date_fin >= CURRENT_DATE)
      `).get(Number(req.params.departmentId), Number(req.params.functionId));
      if (Number(replacement?.total || 0) === 0) {
        return res.status(409).json({
          error: 'Nommez d’abord un nouveau chef titulaire avant de clôturer la fonction actuelle.',
          code: 'ACTIVE_CHIEF_REPLACEMENT_REQUIRED',
        });
      }
    }

    const result = functions.deactivateFunction(req.params.departmentId, req.params.functionId, req.user?.id);
    const reconciliation = reconcileEffectiveManagers(req.user?.id);
    audit(req.params.functionId, 'fonction_departementale_cloturee', {
      departement_id: Number(req.params.departmentId),
      reconciliation,
    }, req.user?.id);
    res.json({ ...result, reconciliation });
  } catch (error) {
    if (sendFunctionError(res, error)) return;
    next(error);
  }
});

module.exports = router;
