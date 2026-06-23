'use strict';

const express = require('express');
const { can } = require('../services/permissions');
const units = require('../services/organization_units');

const router = express.Router();

async function requirePermission(req, res, code) {
  if (await can(req.user, code)) return true;
  res.status(403).json({ error: `Permission ${code} requise`, permission: code });
  return false;
}

function sendUnitError(res, error) {
  if (!(error instanceof units.OrganizationUnitError) && !error?.code) return false;
  res.status(error.status || 400).json({ error: error.message, code: error.code, details: error.details || undefined });
  return true;
}

router.get('/departements/:id/unites', async (req, res, next) => {
  try {
    if (!(await requirePermission(req, res, 'hr.department_function.view'))) return;
    res.json({
      types: units.UNIT_TYPES,
      rows: await units.list(req.params.id, String(req.query?.historique || '') === '1'),
    });
  } catch (error) {
    if (sendUnitError(res, error)) return;
    next(error);
  }
});

router.post('/departements/:id/unites', async (req, res, next) => {
  try {
    if (!(await requirePermission(req, res, 'hr.department_function.create'))) return;
    res.status(201).json(await units.create(req.params.id, req.body || {}, req.user?.id));
  } catch (error) {
    if (sendUnitError(res, error)) return;
    next(error);
  }
});

router.put('/unites/:id', async (req, res, next) => {
  try {
    if (!(await requirePermission(req, res, 'hr.department_function.create'))) return;
    res.json(await units.update(req.params.id, req.body || {}, req.user?.id));
  } catch (error) {
    if (sendUnitError(res, error)) return;
    next(error);
  }
});

router.delete('/unites/:id', async (req, res, next) => {
  try {
    if (!(await requirePermission(req, res, 'hr.department_function.close'))) return;
    res.json(await units.deactivate(req.params.id, req.body?.version || req.query?.version, req.user?.id));
  } catch (error) {
    if (sendUnitError(res, error)) return;
    next(error);
  }
});

module.exports = router;
