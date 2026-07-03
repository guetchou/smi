'use strict';

/**
 * Intercepteur RH : congés et avances avec parapheur obligatoire.
 * Toutes les écritures congé passent ici avant le routeur historique.
 */
const express = require('express');
const db = require('../db');
const { hasRole } = require('./auth');
const { createLeaveRequest } = require('../services/leave_workflow');
const {
  approveLeave,
  cancelLeave,
  finishLeave,
  rejectLeave,
  validateBySupervisor,
} = require('../services/leave_transition_workflow');
const { submitSalaryAdvance } = require('../services/salary_advance_workflow');

const router = express.Router();

function canRH(user) {
  return hasRole(user, 'admin', 'dg', 'rh');
}

async function agentActif(id, res) {
  const employee = await db.queryOne('SELECT * FROM employes WHERE id = ?', [id]);
  if (!employee) {
    res.status(404).json({ error: 'Agent introuvable' });
    return null;
  }
  if (Number(employee.actif) !== 1 || employee.statut_dossier !== 'actif') {
    res.status(400).json({ error: "L'agent doit être actif" });
    return null;
  }
  return employee;
}

function sendWorkflowError(error, res, next) {
  if (!error.status) return next(error);
  const payload = { error: error.message };
  if (error.details && typeof error.details === 'object') Object.assign(payload, error.details);
  return res.status(error.status).json(payload);
}

router.post('/:id/conges', async (req, res, next) => {
  try {
    if (!canRH(req.user)) {
      return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });
    }
    const employee = await agentActif(req.params.id, res);
    if (!employee) return;

    const result = await createLeaveRequest({
      employee,
      payload: req.body,
      actorId: req.user.id,
      isAdmin: hasRole(req.user, 'admin'),
    });

    res.status(201).json({
      id: result.id,
      parapheur_id: result.parapheurId,
      type_conge: result.type_conge,
      date_debut: result.date_debut,
      date_fin: result.date_fin,
      nb_jours: result.nb_jours,
      motif: result.motif,
      statut: 'demande',
      notes: result.notes,
    });
  } catch (error) {
    sendWorkflowError(error, res, next);
  }
});

router.put('/:id/conges/:cid/valider-sup', async (req, res, next) => {
  try {
    const employeeId = Number(req.params.id);
    const leaveId = Number(req.params.cid);
    const result = await validateBySupervisor({
      employeeId,
      leaveId,
      actor: req.user,
      notes: req.body?.notes,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    sendWorkflowError(error, res, next);
  }
});

router.put('/:id/conges/:cid/approuver', async (req, res, next) => {
  try {
    if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });
    const employeeId = Number(req.params.id);
    const leaveId = Number(req.params.cid);
    const result = await approveLeave({ employeeId, leaveId, actorId: req.user.id });
    res.json({ ok: true, ...result, solde: result.counters });
  } catch (error) {
    sendWorkflowError(error, res, next);
  }
});

router.put('/:id/conges/:cid/refuser', async (req, res, next) => {
  try {
    if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });
    const employeeId = Number(req.params.id);
    const leaveId = Number(req.params.cid);
    const result = await rejectLeave({
      employeeId,
      leaveId,
      actorId: req.user.id,
      reason: req.body?.motif,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    sendWorkflowError(error, res, next);
  }
});

router.put('/:id/conges/:cid/annuler', async (req, res, next) => {
  try {
    if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis' });
    const employeeId = Number(req.params.id);
    const leaveId = Number(req.params.cid);
    const result = await cancelLeave({
      employeeId,
      leaveId,
      actorId: req.user.id,
      reason: req.body?.motif,
    });
    res.json({ ok: true, ...result, solde: result.counters });
  } catch (error) {
    sendWorkflowError(error, res, next);
  }
});

router.put('/:id/conges/:cid/terminer', async (req, res, next) => {
  try {
    if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });
    const employeeId = Number(req.params.id);
    const leaveId = Number(req.params.cid);
    const result = await finishLeave({ employeeId, leaveId, actorId: req.user.id });
    res.json({ ok: true, ...result, solde: result.counters });
  } catch (error) {
    sendWorkflowError(error, res, next);
  }
});

router.post('/:id/avances/:aid/soumettre', async (req, res, next) => {
  try {
    if (!canRH(req.user)) {
      return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
    }
    const employee = await agentActif(req.params.id, res);
    if (!employee) return;

    const result = await submitSalaryAdvance({
      employee,
      advanceId: Number(req.params.aid),
      actorId: req.user.id,
      autoApprove: hasRole(req.user, 'admin', 'finance', 'dg'),
    });

    res.json({
      ok: true,
      statut_workflow: result.statut_workflow,
      parapheur_id: result.parapheurId || undefined,
      auto_approved: result.auto_approved || undefined,
    });
  } catch (error) {
    sendWorkflowError(error, res, next);
  }
});

module.exports = router;
