'use strict';

const express = require('express');
const db = require('../database');
const { can } = require('../services/permissions');
const { ensureSqliteMutationWorkflowSchema } = require('../services/organization_mutation_schema');
const { installOrganizationMutationGuard } = require('../services/organization_mutation_guard');
const workflow = require('../services/organization_mutation_workflow');
const departmentFunctionsRouter = require('./organization_department_module');

ensureSqliteMutationWorkflowSchema();
installOrganizationMutationGuard();

const router = express.Router();
router.use(departmentFunctionsRouter);

async function hasPermission(user, code) {
  return Boolean(await can(user, code));
}

async function requirePermission(req, res, code) {
  if (await hasPermission(req.user, code)) return true;
  res.status(403).json({ error: `Permission ${code} requise`, permission: code });
  return false;
}

async function canReadMutations(user) {
  const allowed = await Promise.all([
    hasPermission(user, 'hr.mutation.create'),
    hasPermission(user, 'hr.mutation.approve'),
    hasPermission(user, 'hr.mutation.apply'),
    hasPermission(user, 'hr.agent.update'),
  ]);
  return allowed.some(Boolean);
}

function sendWorkflowError(res, error) {
  if (!(error instanceof workflow.MutationWorkflowError) && !error?.code) return false;
  res.status(error.status || 400).json({
    error: error.message,
    code: error.code,
    details: error.details || undefined,
  });
  return true;
}

function auditTransition(mutation, action, userId, details = {}) {
  try {
    db.prepare(`
      INSERT INTO audit_logs (table_name, record_id, action, details, user_id, created_at)
      VALUES ('employes_mutations', ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      Number(mutation.id),
      action,
      JSON.stringify({
        employe_id: mutation.employe_id,
        statut: mutation.statut,
        revision: mutation.revision,
        ...details,
      }),
      userId || null,
    );
  } catch (_) {}
}

router.put('/:id/superieur', (_req, res) => res.status(409).json({
  error: 'La modification du supérieur doit passer par une mutation RH.',
  code: 'USE_ORGANIZATION_MUTATION_WORKFLOW',
  workflow_endpoint: '/api/org/mutations',
}));

router.get('/mutations/capabilities', async (req, res, next) => {
  try {
    const codes = [
      'hr.mutation.create',
      'hr.mutation.submit',
      'hr.mutation.approve',
      'hr.mutation.apply',
      'hr.mutation.cancel',
    ];
    const values = await Promise.all(codes.map(code => hasPermission(req.user, code)));
    res.json({ permissions: Object.fromEntries(codes.map((code, index) => [code, values[index]])) });
  } catch (error) {
    next(error);
  }
});

router.get('/mutations', async (req, res, next) => {
  try {
    if (!(await canReadMutations(req.user))) {
      return res.status(403).json({ error: 'Permission de consultation des mutations requise' });
    }
    res.json({ rows: workflow.listMutations(req.query || {}) });
  } catch (error) {
    next(error);
  }
});

router.get('/mutations/:id', async (req, res, next) => {
  try {
    if (!(await canReadMutations(req.user))) {
      return res.status(403).json({ error: 'Permission de consultation des mutations requise' });
    }
    const mutation = workflow.getMutation(req.params.id);
    if (!mutation) return res.status(404).json({ error: 'Mutation introuvable', code: 'MUTATION_NOT_FOUND' });
    res.json(mutation);
  } catch (error) {
    next(error);
  }
});

router.post('/mutations', async (req, res, next) => {
  try {
    if (!(await requirePermission(req, res, 'hr.mutation.create'))) return;
    const mutation = workflow.createDraft(req.body || {}, req.user?.id);
    auditTransition(mutation, 'mutation_brouillon_cree', req.user?.id);
    res.status(201).json(mutation);
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
});

router.put('/mutations/:id', async (req, res, next) => {
  try {
    if (!(await requirePermission(req, res, 'hr.mutation.create'))) return;
    const mutation = workflow.updateDraft(req.params.id, req.body || {}, req.user?.id);
    auditTransition(mutation, 'mutation_brouillon_modifie', req.user?.id);
    res.json(mutation);
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
});

router.post('/mutations/:id/soumettre', async (req, res, next) => {
  try {
    if (!(await requirePermission(req, res, 'hr.mutation.submit'))) return;
    const mutation = workflow.submit(req.params.id, req.user?.id);
    auditTransition(mutation, 'mutation_soumise', req.user?.id);
    res.json(mutation);
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
});

async function approve(req, res, next) {
  try {
    if (!(await requirePermission(req, res, 'hr.mutation.approve'))) return;
    const mutation = workflow.approve(req.params.id, req.user?.id);
    const action = mutation.statut === workflow.STATUS.EFFECTIVE
      ? 'mutation_approuvee_et_appliquee'
      : mutation.statut === workflow.STATUS.NEEDS_CORRECTION
        ? 'mutation_a_corriger'
        : 'mutation_approuvee';
    auditTransition(mutation, action, req.user?.id);
    res.json(mutation);
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
}

router.post('/mutations/:id/approuver', approve);
router.put('/mutations/:id/approuver', approve);

async function refuse(req, res, next) {
  try {
    if (!(await requirePermission(req, res, 'hr.mutation.approve'))) return;
    const mutation = workflow.refuse(req.params.id, req.user?.id, req.body?.motif || req.body?.motif_refus);
    auditTransition(mutation, 'mutation_refusee', req.user?.id, { motif_refus: mutation.motif_refus });
    res.json(mutation);
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
}

router.post('/mutations/:id/refuser', refuse);
router.put('/mutations/:id/refuser', refuse);

router.post('/mutations/:id/annuler', async (req, res, next) => {
  try {
    if (!(await requirePermission(req, res, 'hr.mutation.cancel'))) return;
    const mutation = workflow.cancel(req.params.id, req.user?.id, req.body?.motif);
    auditTransition(mutation, 'mutation_annulee', req.user?.id, { motif: mutation.motif_refus });
    res.json(mutation);
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
});

router.post('/mutations/:id/appliquer', async (req, res, next) => {
  try {
    if (!(await requirePermission(req, res, 'hr.mutation.apply'))) return;
    const mutation = workflow.apply(req.params.id, req.user?.id);
    auditTransition(
      mutation,
      mutation.statut === workflow.STATUS.EFFECTIVE ? 'mutation_appliquee' : 'mutation_a_corriger',
      req.user?.id,
    );
    res.json(mutation);
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
});

router.post('/mutations/appliquer-echeances', async (req, res, next) => {
  try {
    if (!(await requirePermission(req, res, 'hr.mutation.apply'))) return;
    res.json(workflow.applyDue(req.user?.id));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
