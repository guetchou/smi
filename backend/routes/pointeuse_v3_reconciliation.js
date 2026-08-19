'use strict';

const express = require('express');
const { hasRole } = require('./auth');
const reconciliation = require('../services/pointeuse_v3_reconciliation');
const shadowSync = require('../services/pointeuse_v3_shadow_sync');

const router = express.Router();

function canManage(user) { return hasRole(user, 'admin', 'dg', 'rh'); }
function validRange(debut, fin) { return /^\d{4}-\d{2}-\d{2}$/.test(debut) && /^\d{4}-\d{2}-\d{2}$/.test(fin) && fin >= debut; }

router.post('/admin/shadow-sync', async (req, res) => {
  try {
    if (!canManage(req.user)) return res.status(403).json({ error: 'Accès RH/DG/admin requis' });
    const debut = String(req.body?.debut || '');
    const fin = String(req.body?.fin || debut);
    if (!validRange(debut, fin)) return res.status(400).json({ error: 'Période de synchronisation invalide' });
    const employeId = req.body?.employe_id ? Number(req.body.employe_id) : null;
    if (employeId !== null && (!Number.isInteger(employeId) || employeId <= 0)) return res.status(400).json({ error: 'employe_id invalide' });
    const result = await shadowSync.syncRange({ debut, fin, employeId });
    res.json({ ...result, mode: 'shadow', destructive: false });
  } catch (error) {
    console.error('[pointeuse-v3 shadow-sync]', error);
    res.status(500).json({ error: 'Erreur interne de synchronisation Pointeuse' });
  }
});

router.get('/admin/reconciliation', async (req, res) => {
  try {
    if (!canManage(req.user)) return res.status(403).json({ error: 'Accès RH/DG/admin requis' });
    const debut = String(req.query.debut || '');
    const fin = String(req.query.fin || debut);
    if (!validRange(debut, fin)) return res.status(400).json({ error: 'Période de rapprochement invalide' });
    const employeId = req.query.employe_id ? Number(req.query.employe_id) : null;
    if (employeId !== null && (!Number.isInteger(employeId) || employeId <= 0)) return res.status(400).json({ error: 'employe_id invalide' });
    res.json(await reconciliation.reconcile({ debut, fin, employeId }));
  } catch (error) {
    console.error('[pointeuse-v3 reconciliation]', error);
    res.status(500).json({ error: 'Erreur interne du rapprochement Pointeuse' });
  }
});

module.exports = router;
