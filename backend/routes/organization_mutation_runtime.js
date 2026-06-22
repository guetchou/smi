'use strict';

const express = require('express');
const workflow = require('../services/organization_mutation_workflow');
const { installOrganizationMutationGuard } = require('../services/organization_mutation_guard_runtime');
const mutationWorkflowRouter = require('./organization_mutation_workflow');

installOrganizationMutationGuard();

const router = express.Router();

router.put('/:id/superieur', (_req, res) => res.status(409).json({
  error: 'La modification du supérieur doit passer par une mutation RH.',
  code: 'USE_ORGANIZATION_MUTATION_WORKFLOW',
  workflow_endpoint: '/api/org/mutations',
}));

router.use(mutationWorkflowRouter);

const scheduler = setInterval(() => {
  try {
    const result = workflow.applyDue(null);
    if (result.applied.length || result.needs_correction.length || result.failed.length) {
      console.log('[ORG mutation scheduler]', JSON.stringify(result));
    }
  } catch (error) {
    console.error('[ORG mutation scheduler]', error.message);
  }
}, 60000);
if (typeof scheduler.unref === 'function') scheduler.unref();

module.exports = router;
