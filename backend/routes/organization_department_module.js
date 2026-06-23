'use strict';

const express = require('express');
const { can } = require('../services/permissions');
const unitsRouter = require('./organization_units');
const structureRouter = require('./organization_function_structure');
const functionsRouter = require('./organization_department_functions');

const router = express.Router();
router.use('/fonctions/:id/structure', async (req, res, next) => {
  try {
    if (await can(req.user, 'hr.department_function.create')) return next();
    res.status(403).json({ error: 'Permission refusée', permission: 'hr.department_function.create' });
  } catch (error) { next(error); }
});
router.use(unitsRouter);
router.use(structureRouter);
router.use(functionsRouter);

module.exports = router;
