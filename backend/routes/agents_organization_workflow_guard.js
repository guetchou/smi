'use strict';

const express = require('express');
const db = require('../database');

const router = express.Router();
const ORGANIZATION_FIELDS = ['poste', 'departement', 'site', 'superieur_id', 'superieur_hierarchique'];

function normalize(field, value) {
  if (field === 'superieur_id') return value === undefined || value === null || value === '' ? null : Number(value);
  return String(value ?? '').trim();
}

router.put('/:id', (req, res, next) => {
  try {
    const employee = db.prepare(`
      SELECT id, poste, departement, site, superieur_id, superieur_hierarchique
      FROM employes WHERE id = ?
    `).get(Number(req.params.id));
    if (!employee) return next();

    const changedFields = ORGANIZATION_FIELDS.filter(field => {
      if (req.body?.[field] === undefined) return false;
      return normalize(field, req.body[field]) !== normalize(field, employee[field]);
    });

    if (!changedFields.length) return next();
    return res.status(409).json({
      error: 'Les modifications de poste, département, site ou supérieur doivent passer par une mutation RH.',
      code: 'USE_ORGANIZATION_MUTATION_WORKFLOW',
      changed_fields: changedFields,
      workflow_endpoint: '/api/org/mutations',
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
