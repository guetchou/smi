'use strict';

/**
 * Intercepteur HTTP offboarding. Le workflow transactionnel est isolé dans
 * services/offboarding_workflow.js afin d’être testable sans charger le serveur.
 */
const express = require('express');
const db = require('../db');
const { hasRole } = require('./auth');
const userProvSvc = require('../services/user_provisioning');
const { initiateOffboarding, validateOffboarding } = require('../services/offboarding_workflow');

const router = express.Router();
const WRITE_ROLES = ['admin', 'rh', 'dg'];
const VALID_ROLES = ['admin', 'dg'];

function canWrite(user) { return hasRole(user, ...WRITE_ROLES); }
function canValid(user) { return hasRole(user, ...VALID_ROLES); }

router.post('/:id/sortie/initier', async (req, res, next) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Rôle RH, DG ou Admin requis' });

    const agent = await db.queryOne('SELECT * FROM employes WHERE id = ?', [req.params.id]);
    if (!agent) return res.status(404).json({ error: 'Agent introuvable' });
    if (!['actif', 'suspendu'].includes(agent.statut_dossier)) {
      return res.status(400).json({ error: `L’agent doit être actif ou suspendu pour initier une sortie (statut actuel : ${agent.statut_dossier})` });
    }

    const existant = await db.queryOne(
      "SELECT id, statut FROM employes_sortie WHERE employe_id = ? AND statut NOT IN ('solde','annule')",
      [agent.id],
    );
    if (existant) {
      return res.status(409).json({ error: `Un dossier de sortie existe déjà pour cet agent (statut : ${existant.statut}, id: ${existant.id})` });
    }

    const out = await initiateOffboarding({
      agent,
      payload: req.body,
      actorId: req.user.id,
    });
    const dossier = await db.queryOne('SELECT * FROM employes_sortie WHERE id = ?', [out.id]);
    res.status(201).json({ ...dossier, parapheur_id: out.parapheurId });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

router.put('/:id/sortie/valider', async (req, res, next) => {
  try {
    if (!canValid(req.user)) return res.status(403).json({ error: 'Rôle DG ou Admin requis pour valider une sortie' });

    const out = await validateOffboarding({
      employeeId: req.params.id,
      actorId: req.user.id,
    });

    try {
      await Promise.resolve(userProvSvc.revoquerAcces(out.employeeId, req.user.id, out.typeSortie, req.ip));
    } catch (_) {}

    res.json({ ok: true, statut: out.statut, employe_statut: out.employeStatut });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

module.exports = router;
