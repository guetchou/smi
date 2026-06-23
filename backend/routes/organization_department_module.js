'use strict';

const express = require('express');
const { can } = require('../services/permissions');
require('../services/department_function_notification_guard').installDepartmentFunctionNotificationGuard();

const router = express.Router();
router.use('/fonctions/:id/structure', async (req, res, next) => {
  try {
    if (await can(req.user, 'hr.department_function.create')) return next();
    return res.status(403).json({ error: 'Permission refusée', permission: 'hr.department_function.create' });
  } catch (error) { return next(error); }
});
router.use(require('./organization_units'));
router.use(require('./organization_function_structure'));
router.use(require('./organization_department_functions'));

module.exports = router;
