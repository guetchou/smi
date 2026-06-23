'use strict';
const express = require('express');
const structure = require('../services/department_function_structure');
const router = express.Router();
router.post('/fonctions/:id/structure', async (req, res, next) => {
  try {
    res.json(await structure.setStructure(req.params.id, req.body || {}, req.user?.id));
  } catch (error) {
    if (error?.code) return res.status(error.status || 400).json({ error: error.message, code: error.code });
    next(error);
  }
});
module.exports = router;
