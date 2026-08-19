'use strict';

const express = require('express');
const { hasRole } = require('./auth');
const reconciliation = require('../services/pointeuse_v3_reconciliation');

const router = express.Router();

router.get('/admin/reconciliation', async (req, res) => {
  try {
    if (!hasRole(req.user, 'admin', 'dg', 'rh')) return res.status(403).json({ error: 'Accès RH/DG/admin requis' });
    const debut = String(req.query.debut || '');
    const fin = String(req.query.fin || debut);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(debut) || !/^\d{4}-\d{2}-\d{2}$/.test(fin) || fin < debut) {
      return res.status(400).json({ error: 'Période de rapprochement invalide' });
    }
    const employeId = req.query.employe_id ? Number(req.query.employe_id) : null;
    if (employeId !== null && (!Number.isInteger(employeId) || employeId <= 0)) return res.status(400).json({ error: 'employe_id invalide' });
    res.json(await reconciliation.reconcile({ debut, fin, employeId }));
  } catch (error) {
    console.error('[pointeuse-v3 reconciliation]', error);
    res.status(500).json({ error: 'Erreur interne du rapprochement Pointeuse' });
  }
});

module.exports = router;
