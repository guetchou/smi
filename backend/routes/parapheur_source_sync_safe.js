'use strict';
const express = require('express');
const leaveRouter = require('./parapheur_leave_source_sync_safe');
const otherRouter = require('./parapheur_source_sync_other');
const router = express.Router();
router.use(leaveRouter);
router.use(otherRouter);
module.exports = router;
