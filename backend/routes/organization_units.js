'use strict';

const express = require('express');
const units = require('../services/organization_units');

const router = express.Router();

router.get('/departements/:id/unites', async (req, res, next) => {
  try {
    res.json({ types: units.UNIT_TYPES, rows: await units.list(req.params.id, false) });
  } catch (error) { next(error); }
});

module.exports = router;
