'use strict';

const express = require('express');
const { can } = require('../services/permissions');
const integrityAudit = require('../services/organization_integrity_audit');

const router = express.Router();

async function organizationCapabilities(user) {
  const [createAgent, updateAgent, archiveAgent] = await Promise.all([
    can(user, 'hr.agent.create'),
    can(user, 'hr.agent.update'),
    can(user, 'hr.agent.archive'),
  ]);

  return {
    permissions: {
      'hr.agent.create': createAgent,
      'hr.agent.update': updateAgent,
      'hr.agent.archive': archiveAgent,
    },
    capabilities: {
      manage_departments: updateAgent,
      inspect_integrity: updateAgent,
      repair_integrity: updateAgent,
    },
    evaluated_at: new Date().toISOString(),
  };
}

async function canInspect(req) {
  return can(req.user, 'hr.agent.update');
}

async function canRepair(req) {
  return can(req.user, 'hr.agent.update');
}

router.get('/capabilities', async (req, res, next) => {
  try {
    res.json(await organizationCapabilities(req.user));
  } catch (error) {
    next(error);
  }
});

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
