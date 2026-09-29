'use strict';
/*
 * Prévisions budgétaires — GET pour la grille, PUT pour la saisie.
 * Réservé à l'administration, à la finance et à la direction : une
 * prévision engage l'imputation de toutes les opérations du mois.
 */
const express = require('express');
const { hasRole } = require('../services/roles');
const budget = require('../services/budget');

const router = express.Router();
const ROLES_BUDGET = ['admin', 'finance', 'dg'];

function repondreErreur(res, error, next) {
  if (error instanceof budget.BudgetError) return res.status(error.status).json({ error: error.message });
  return next(error);
}

router.get('/', async (req, res, next) => {
  if (!hasRole(req.user, ...ROLES_BUDGET)) return res.status(403).json({ error: 'Admin, Finance ou DG requis' });
  try {
    res.json(await budget.lirePrevisions({ annee: req.query.annee, type: req.query.type }));
  } catch (error) { repondreErreur(res, error, next); }
});

router.put('/', async (req, res, next) => {
  if (!hasRole(req.user, ...ROLES_BUDGET)) return res.status(403).json({ error: 'Admin, Finance ou DG requis' });
  try {
    const { annee, type, lignes } = req.body || {};
    res.json({ ok: true, ...(await budget.enregistrerPrevisions({ annee, type, lignes }, req.user.id)) });
  } catch (error) { repondreErreur(res, error, next); }
});

module.exports = router;
module.exports.ROLES_BUDGET = ROLES_BUDGET;
