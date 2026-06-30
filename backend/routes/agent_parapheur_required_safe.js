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

async function auditLeave(leaveId, action, details, userId) {
  await db.execute(
    'INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)',
    ['employes_conges', leaveId, action, JSON.stringify(details || {}), userId || null],
  );
}

async function notifyLeaveRoles({ leaveId, type, title, message, actorId }) {
  try {
    const users = await db.query('SELECT id, role, roles FROM users WHERE actif = 1');
    const targets = users.filter((user) => {
      let extra = [];
      try { extra = user.roles ? JSON.parse(user.roles) : []; } catch (_) { extra = []; }
      const roles = new Set([user.role, ...extra].filter(Boolean));
      return roles.has('admin') || roles.has('dg') || roles.has('rh');
    });
    for (const user of targets) {
      await db.execute(`
        INSERT INTO notif_messages
          (type, famille, priorite, titre, message, user_id, src_table, src_id)
        VALUES (?, 'notification', 'info', ?, ?, ?, 'employes_conges', ?)
      `, [type, title, message, user.id, leaveId]);
    }
  } catch (error) {
    console.error('[conges notification]', error.message);
  }
}

async function leaveLabel(employeeId, leaveId) {
  return db.queryOne(`
    SELECT c.id, c.date_debut, c.date_fin, c.nb_jours, c.type_conge,
           e.nom, e.prenom
    FROM employes_conges c
    JOIN employes e ON e.id = c.employe_id
    WHERE c.id = ? AND c.employe_id = ?
  `, [leaveId, employeeId]);
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
    await auditLeave(leaveId, 'valide_sup', { notes: req.body?.notes || '' }, req.user.id);
    const leave = await leaveLabel(employeeId, leaveId);
    await notifyLeaveRoles({
      leaveId,
      type: 'NOTIF_CONGE_VALIDE_SUP',
      title: 'Congé validé par le supérieur',
      message: `Le congé de ${leave?.nom || ''} ${leave?.prenom || ''} du ${leave?.date_debut || ''} au ${leave?.date_fin || ''} attend l'approbation DG/RH.`,
      actorId: req.user.id,
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
    await auditLeave(leaveId, 'approuve', { counters: result.counters }, req.user.id);
    const leave = await leaveLabel(employeeId, leaveId);
    await notifyLeaveRoles({
      leaveId,
      type: 'NOTIF_CONGE_APPROUVE',
      title: 'Congé approuvé',
      message: `Le congé de ${leave?.nom || ''} ${leave?.prenom || ''} du ${leave?.date_debut || ''} au ${leave?.date_fin || ''} a été approuvé.`,
      actorId: req.user.id,
    });
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
    await auditLeave(leaveId, 'refuse', { motif: req.body?.motif || '' }, req.user.id);
    const leave = await leaveLabel(employeeId, leaveId);
    await notifyLeaveRoles({
      leaveId,
      type: 'NOTIF_CONGE_REFUSE',
      title: 'Congé refusé',
      message: `Le congé de ${leave?.nom || ''} ${leave?.prenom || ''} a été refusé : ${req.body?.motif || ''}`,
      actorId: req.user.id,
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
    await auditLeave(leaveId, 'annule', { motif: req.body?.motif || '' }, req.user.id);
    await notifyLeaveRoles({
      leaveId,
      type: 'NOTIF_CONGE_ANNULE',
      title: 'Congé annulé',
      message: `Le congé #${leaveId} a été annulé : ${req.body?.motif || ''}`,
      actorId: req.user.id,
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
    await auditLeave(leaveId, 'termine', {}, req.user.id);
    await notifyLeaveRoles({
      leaveId,
      type: 'NOTIF_CONGE_TERMINE',
      title: 'Congé terminé',
      message: `Le congé #${leaveId} est terminé.`,
      actorId: req.user.id,
    });
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
