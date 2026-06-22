'use strict';

const express = require('express');
const db = require('../database');
const { can } = require('../services/permissions');
const workflow = require('../services/organization_mutation_workflow');

const router = express.Router();

async function requirePermission(req, res, permission) {
  if (await can(req.user, permission)) return true;
  res.status(403).json({ error: `Permission ${permission} requise`, permission });
  return false;
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
      VALUES ('employes_mutations', ?, ?, ?, ?, datetime('now'))
    `).run(Number(mutation.id), action, JSON.stringify({
      employe_id: mutation.employe_id,
      statut: mutation.statut,
      revision: mutation.revision,
      ...details,
    }), userId || null);
  } catch (_) {}
}

router.get('/mutations/capabilities', async (req, res, next) => {
  try {
    const codes = [
      'hr.mutation.create',
      'hr.mutation.submit',
      'hr.mutation.approve',
      'hr.mutation.apply',
      'hr.mutation.cancel',
    ];
    const values = await Promise.all(codes.map(code => can(req.user, code)));
    res.json({ permissions: Object.fromEntries(codes.map((code, index) => [code, values[index]])) });
  } catch (error) {
    next(error);
  }
});

router.get('/mutations', async (req, res, next) => {
  try {
    const readable = await Promise.all([
      can(req.user, 'hr.mutation.create'),
      can(req.user, 'hr.mutation.approve'),
      can(req.user, 'hr.mutation.apply'),
      can(req.user, 'hr.agent.update'),
    ]);
    if (!readable.some(Boolean)) return res.status(403).json({ error: 'Permission de consultation des mutations requise' });
    res.json(workflow.listMutations(req.query || {}));
  } catch (error) {
    next(error);
  }
});

router.get('/mutations/:id', async (req, res, next) => {
  try {
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

async function approveMutation(req, res, next) {
  try {
    if (!(await requirePermission(req, res, 'hr.mutation.approve'))) return;
    const mutation = workflow.approve(req.params.id, req.user?.id);
    auditTransition(mutation, mutation.statut === 'effectif' ? 'mutation_approuvee_et_appliquee' : 'mutation_approuvee', req.user?.id);
    res.json(mutation);
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
}

router.post('/mutations/:id/approuver', approveMutation);
router.put('/mutations/:id/approuver', approveMutation);

async function refuseMutation(req, res, next) {
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

router.post('/mutations/:id/refuser', refuseMutation);
router.put('/mutations/:id/refuser', refuseMutation);

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
    auditTransition(mutation, mutation.statut === 'effectif' ? 'mutation_appliquee' : 'mutation_a_corriger', req.user?.id);
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
