'use strict';

const express = require('express');
const unitsRouter = require('./organization_units');
const functionsRouter = require('./organization_department_functions');

const router = express.Router();
router.use(unitsRouter);
router.use(functionsRouter);

module.exports = router;
