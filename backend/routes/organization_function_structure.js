'use strict';

const express = require('express');
const { can } = require('../services/permissions');
const structure = require('../services/department_function_structure');

const router = express.Router();

router.post('/fonctions/:id/structure', async (req, res, next) => {
  try {
    if (!(await can(req.user, 'hr.department_function.create'))) {
      return res.status(403).json({
        error: 'Permission refusée',
        permission: 'hr.department_function.create',
      });
    }
    res.json(await structure.setStructure(req.params.id, req.body || {}, req.user?.id));
  } catch (error) {
    if (error?.code) {
      return res.status(error.status || 400).json({
        error: error.message,
        code: error.code,
        details: error.details || undefined,
      });
    }
    next(error);
  }
});

module.exports = router;
