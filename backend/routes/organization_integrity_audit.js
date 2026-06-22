'use strict';

const express = require('express');
const { hasRole } = require('./auth');
const { can } = require('../services/permissions');
const integrityAudit = require('../services/organization_integrity_audit');

const router = express.Router();

async function canInspect(req) {
  if (hasRole(req.user, 'admin', 'rh', 'dg')) return true;
  return can(req.user, 'hr.agent.view');
}

async function canRepair(req) {
  if (hasRole(req.user, 'admin', 'rh', 'dg')) return true;
  return can(req.user, 'hr.agent.update');
}

router.get('/anomalies', async (req, res, next) => {
  try {
    if (!(await canInspect(req))) return res.status(403).json({ error: 'Permission RH requise' });
    const report = integrityAudit.scanIntegrity();
    res.json(report);
  } catch (error) {
    next(error);
  }
});

router.post('/reparer-integrite', async (req, res, next) => {
  try {
    if (!(await canRepair(req))) return res.status(403).json({ error: 'Permission de modification RH requise' });

    const dryRun = req.body?.dry_run !== false;
    if (!dryRun && String(req.body?.confirmation || '').trim().toUpperCase() !== 'REPARER') {
      return res.status(400).json({
        error: 'Confirmation explicite requise pour exécuter la réparation.',
        code: 'REPAIR_CONFIRMATION_REQUIRED',
        expected_confirmation: 'REPARER',
      });
    }

    const result = integrityAudit.repairIntegrity({
      dryRun,
      actorUserId: req.user?.id || null,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
