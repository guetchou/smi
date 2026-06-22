'use strict';

const express = require('express');
const db = require('../database');
const { can } = require('../services/permissions');
const { ensureSqliteDepartmentFunctionsSchema } = require('../services/organization_department_functions_schema');
const functions = require('../services/organization_department_functions');

ensureSqliteDepartmentFunctionsSchema();

const router = express.Router();

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

router.get('/departements/capabilities', async (req, res, next) => {
  try {
    res.json({ can_manage_functions: await canManage(req.user) });
  } catch (error) {
    next(error);
  }
});

// Cette route enrichie passe avant la route historique /departements.
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
    audit(result.function.id, 'fonction_departementale_creee', {
      departement_id: Number(req.params.id),
      employe_id: result.function.employe_id,
      fonction_type: result.function.fonction_type,
      date_debut: result.function.date_debut,
      date_fin: result.function.date_fin,
    }, req.user?.id);
    res.status(201).json(result);
  } catch (error) {
    if (sendFunctionError(res, error)) return;
    next(error);
  }
});

router.put('/departements/:departmentId/fonctions/:functionId', async (req, res, next) => {
  try {
    if (!(await requireManage(req, res))) return;
    const row = functions.updateFunction(req.params.departmentId, req.params.functionId, req.body || {});
    audit(row.id, 'fonction_departementale_modifiee', {
      departement_id: Number(req.params.departmentId),
      fonction_type: row.fonction_type,
      date_debut: row.date_debut,
      date_fin: row.date_fin,
    }, req.user?.id);
    res.json(row);
  } catch (error) {
    if (sendFunctionError(res, error)) return;
    next(error);
  }
});

router.delete('/departements/:departmentId/fonctions/:functionId', async (req, res, next) => {
  try {
    if (!(await requireManage(req, res))) return;
    const result = functions.deactivateFunction(req.params.departmentId, req.params.functionId, req.user?.id);
    audit(req.params.functionId, 'fonction_departementale_cloturee', {
      departement_id: Number(req.params.departmentId),
    }, req.user?.id);
    res.json(result);
  } catch (error) {
    if (sendFunctionError(res, error)) return;
    next(error);
  }
});

module.exports = router;
